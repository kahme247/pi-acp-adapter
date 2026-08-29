import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse
} from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'
import { SessionManager, type PiAcpSession } from './session.js'
import { SessionStore } from './session-store.js'
import { PiRpcProcess } from '../pi-rpc/process.js'
import { listPiSessions, findPiSession } from './pi-sessions.js'
import { normalizePiAssistantText, normalizePiMessageText } from './translate/pi-messages.js'
import { toolResultToText } from './translate/pi-tools.js'
import {
  bashCommand,
  bashExitCode,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { promptToPiMessage } from './translate/prompt.js'
import { loadSlashCommands, parseCommandArgs, toAvailableCommands } from './slash-commands.js'
import { getAgentDir, getEnableSkillCommands, getEnabledModels, getQuietStartup } from './pi-settings.js'
import { toAvailableCommandsFromPiGetCommands } from './pi-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { normalizeAdditionalDirectories } from './workspace-roots.js'
import { getPiCommand } from '../pi-rpc/command.js'
import { isAbsolute } from 'node:path'
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type AdvertisedModel = {
  modelId: string
  name: string
  description?: string | null
}

const MODEL_CONFIG_ID = 'model'
const THOUGHT_LEVEL_CONFIG_ID = 'thought_level'

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' }
    },
    {
      name: 'autocompact',
      description: 'Toggle automatic context compaction',
      input: { hint: 'on|off|toggle' }
    },
    {
      name: 'export',
      description: 'Export session to an HTML file in the session cwd'
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost, session file)'
    },
    {
      name: 'name',
      description: 'Set session display name',
      input: { hint: '<name>' }
    },
    {
      name: 'steering',
      description: 'Get/set pi steering message delivery mode (how queued steering messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'follow-up',
      description: 'Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'changelog',
      description: 'Show pi changelog'
    },
    {
      name: 'fork',
      description: 'Fork session from a previous message',
      input: { hint: '<entryId>' }
    },
    {
      name: 'clone',
      description: 'Clone current session branch'
    },
    {
      name: 'bash',
      description: 'Run a shell command directly',
      input: { hint: '<command>' }
    },
    {
      name: 'reload',
      description: 'Reload pi extensions and skills'
    }
  ]
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = []
  const seen = new Set<string>()

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }

  return out
}

async function loadAvailableCommands(
  proc: Pick<PiRpcProcess, 'getCommands'>,
  fileCommands: ReturnType<typeof loadSlashCommands>,
  enableSkillCommands: boolean
): Promise<AvailableCommand[]> {
  try {
    const pi = await proc.getCommands()
    const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
      enableSkillCommands,
      includeExtensionCommands: false
    })
    return mergeCommands(commands, builtinAvailableCommands())
  } catch {
    return mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
  }
}
import { fileURLToPath } from 'node:url'

const pkg = readNearestPackageJson(import.meta.url)

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly sessions = new SessionManager()
  private readonly store = new SessionStore()
  private readonly restoringSessions = new Map<string, Promise<PiAcpSession>>()

  dispose(): void {
    this.sessions.disposeAll()
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null

  constructor(conn: AgentSideConnection, _config?: unknown) {
    this.conn = conn
    void _config
  }

  private cleanupFailedNewSession(sessionId: string, state?: any | null): void {
    this.sessions.close(sessionId)

    const sessionFile =
      typeof state?.sessionFile === 'string' && state.sessionFile.trim()
        ? state.sessionFile
        : this.store.get(sessionId)?.sessionFile

    if (typeof sessionFile === 'string' && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId)
  }

  private findStoredSession(sessionId: string): { cwd: string; sessionFile: string } | null {
    const stored = this.store.get(sessionId)
    if (stored?.cwd && stored?.sessionFile) {
      return { cwd: stored.cwd, sessionFile: stored.sessionFile }
    }

    const piSession = findPiSession(sessionId)
    if (!piSession) return null

    this.store.upsert({
      sessionId,
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    })

    return {
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    }
  }

  private async restoreSession(
    sessionId: string,
    opts?: { cwd?: string; mcpServers?: LoadSessionRequest['mcpServers']; additionalDirectories?: string[] }
  ): Promise<PiAcpSession> {
    const existing = this.sessions.maybeGet(sessionId)
    if (existing) {
      if (typeof existing.proc.isAlive !== 'function' || existing.proc.isAlive()) return existing
      this.sessions.close(sessionId)
    }

    const inFlight = this.restoringSessions.get(sessionId)
    if (inFlight) return inFlight

    const restorePromise = (async () => {
      const stored = this.findStoredSession(sessionId)
      if (!stored) {
        throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
      }

      const cwd = opts?.cwd ?? stored.cwd

      let proc: PiRpcProcess
      try {
        proc = await PiRpcProcess.spawn({
          cwd,
          sessionPath: stored.sessionFile,
          piCommand: process.env.PI_ACP_PI_COMMAND,
          ...(opts?.additionalDirectories?.length ? { additionalDirectories: opts.additionalDirectories } : {}),
          ...(opts?.mcpServers?.length ? { mcpServers: opts.mcpServers } : {})
        })
      } catch (e: any) {
        if (e?.name === 'PiRpcSpawnError') {
          throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e))
        }
        throw e
      }

      const fileCommands = loadSlashCommands(cwd)
      const session = this.sessions.getOrCreate(sessionId, {
        cwd,
        mcpServers: opts?.mcpServers ?? [],
        conn: this.conn,
        proc,
        fileCommands,
        additionalDirectories: opts?.additionalDirectories
      })

      this.lastSessionCwd = cwd
      this.store.upsert({ sessionId, cwd, sessionFile: stored.sessionFile })

      return session
    })()

    this.restoringSessions.set(sessionId, restorePromise)

    try {
      return await restorePromise
    } finally {
      this.restoringSessions.delete(sessionId)
    }
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // We currently only support ACP protocol version 1.
    const supportedVersion = 1
    const requested = params.protocolVersion

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      _meta: { steering: { supported: true } },
      agentInfo: {
        name: pkg.name ?? 'pi-agent',
        title: 'PI Agent',
        version: pkg.version ?? '0.0.0'
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: (params as any)?.clientCapabilities?._meta?.['terminal-auth'] === true
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === 'true'
        },
        sessionCapabilities: {
          // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
          // Enables a native session picker in clients that support it.
          list: {},
          delete: {},
          additionalDirectories: {}
        }
      }
    }
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === '_session/steering') {
      const sessionId = params.sessionId
      if (typeof sessionId !== 'string' || !sessionId) {
        throw RequestError.invalidParams('_session/steering requires a sessionId')
      }
      const session = await this.restoreSession(sessionId)
      const prompt = (Array.isArray(params.prompt) ? params.prompt : []) as any[]
      const { message, images } = promptToPiMessage(prompt as any)
      if (!session.hasPendingTurn) {
        const meta = params._meta as { steering?: { idleBehavior?: string } } | undefined
        if (meta?.steering?.idleBehavior === 'promptRequired') {
          return { outcome: 'promptRequired', reason: 'noRunningTurn' }
        }
        this.prompt({ sessionId, prompt: prompt as any }).catch(() => {})
        return { outcome: 'startedNewTurn' }
      }
      try {
        await session.proc.steer(message, images)
      } catch (e) {
        throw RequestError.internalError({}, String((e as Error)?.message ?? e))
      }
      return { outcome: 'injected' }
    }
    throw RequestError.methodNotFound(method)
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    const additionalDirectories = normalizeAdditionalDirectories((params as any).additionalDirectories, params.cwd)

    this.lastSessionCwd = params.cwd

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      additionalDirectories
    })

    // Fetch state + models once (parallel) to reduce startup latency.
    let state: any = null
    let availableModels: any = null
    let stateErr: unknown = null
    let availableModelsErr: unknown = null

    await Promise.all([
      session.proc
        .getState()
        .then(s => {
          state = s as any
        })
        .catch(err => {
          stateErr = err
          state = null
        }),
      session.proc
        .getAvailableModels()
        .then(m => {
          availableModels = m as any
        })
        .catch(err => {
          availableModelsErr = err
          availableModels = null
        })
    ])

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr)

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw availableModelsAuthErr
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    const { configOptions, models, modes } = await getSessionConfiguration(session.proc, {
      state,
      availableModels,
      cwd: params.cwd
    })

    const quietStartup = getQuietStartup(params.cwd)
    const updateNotice = buildUpdateNotice()

    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    const preludeText = quietStartup
      ? updateNotice
        ? updateNotice + '\n'
        : ''
      : buildStartupInfo({
          cwd: params.cwd,
          fileCommands,
          updateNotice,
          additionalDirectories
        })

    if (preludeText)
      session.setStartupInfo(preludeText)

      // Policy: within a single ACP connection (one client window), keep only one live pi subprocess.
      // This avoids leaking subprocesses when clients start new sessions but don't explicitly close old ones.
      // It does NOT affect other client windows because they run in separate agent processes.
      //
      // (Tests sometimes stub out `this.sessions`, so guard the call.)
    ;(this.sessions as any).closeAllExcept?.(session.sessionId)

    const response = {
      sessionId: session.sessionId,
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: preludeText || null
        }
      }
    }

    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0)

    // Finish the pi command probe before exposing the session so it cannot race the first prompt.
    const availableCommands = await loadAvailableCommands(session.proc, fileCommands, enableSkillCommands)
    setTimeout(() => {
      void session.publishContextUsage()
      void this.conn
        .sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands
          }
        })
        .catch(() => {})
    }, 0)

    return response
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    return
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = await this.restoreSession(params.sessionId)

    const { message, images } = promptToPiMessage(params.prompt)

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)

      if (cmd === 'compact') {
        const customInstructions = args.join(' ').trim() || undefined
        const res = await session.proc.compact(customInstructions)

        const r: any = res && typeof res === 'object' ? (res as any) : null
        const tokensBefore = typeof r?.tokensBefore === 'number' ? r.tokensBefore : null
        const summary = typeof r?.summary === 'string' ? r.summary : null

        const headerLines = [
          `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean)

        const text = headerLines.join('\n') + (summary ? `\n\n${summary}` : '')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'session') {
        const [stats, state] = await Promise.all([
          session.proc.getSessionStats().catch(() => null) as Promise<any>,
          session.proc.getState().catch(() => null) as Promise<any>
        ])

        const lines: string[] = []
        if (stats?.sessionId || state?.sessionId) lines.push(`Session: ${stats?.sessionId ?? state?.sessionId}`)
        if (stats?.sessionFile || state?.sessionFile)
          lines.push(`Session file: ${stats?.sessionFile ?? state?.sessionFile}`)
        if (typeof state?.sessionName === 'string' && state.sessionName) lines.push(`Name: ${state.sessionName}`)
        if (typeof stats?.totalMessages === 'number') lines.push(`Messages: ${stats.totalMessages}`)
        if (typeof state?.pendingMessageCount === 'number') lines.push(`Pending: ${state.pendingMessageCount}`)
        if (typeof state?.isStreaming === 'boolean') lines.push(`Streaming: ${state.isStreaming}`)
        if (typeof state?.isCompacting === 'boolean') lines.push(`Compacting: ${state.isCompacting}`)

        if (typeof stats?.cost === 'number') lines.push(`Cost: ${stats.cost}`)

        const t = stats?.tokens
        if (t && typeof t === 'object') {
          const parts: string[] = []
          if (typeof t.input === 'number') parts.push(`in ${t.input}`)
          if (typeof t.output === 'number') parts.push(`out ${t.output}`)
          if (typeof t.cacheRead === 'number') parts.push(`cache read ${t.cacheRead}`)
          if (typeof t.cacheWrite === 'number') parts.push(`cache write ${t.cacheWrite}`)
          if (typeof t.total === 'number') parts.push(`total ${t.total}`)
          if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
        }

        // Fallback if stats shape changes.
        const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'name') {
        const name = args.join(' ').trim()
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Usage: /name <name>' }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          await session.proc.setSessionName(name)
        } catch (e: any) {
          const msg = String(e?.message ?? e)
          const hint = /set_session_name/i.test(msg)
            ? ' This requires a newer pi version that supports `set_session_name` in RPC mode.'
            : ''

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to set session name: ${msg}${hint}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Session name set: ${name}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'steering') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.steeringMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Steering mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /steering all | /steering one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setSteeringMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Steering mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'follow-up') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.followUpMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Follow-up mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /follow-up all | /follow-up one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setFollowUpMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Follow-up mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'changelog') {
        // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
        const findChangelog = (): string | null => {
          const customPi = process.env.PI_ACP_PI_COMMAND?.trim()
          if (customPi && isAbsolute(customPi) && existsSync(customPi)) {
            try {
              const resolved = realpathSync(customPi)
              const pkgRoot = dirname(dirname(resolved))
              const p = join(pkgRoot, 'CHANGELOG.md')
              if (existsSync(p)) return p
            } catch {
              // ignore
            }
          }
          // 1) Locate the installed pi package by resolving the `pi` executable.
          // On Node installs, `pi` typically resolves to .../@earendil-works/pi-coding-agent/dist/cli.js
          try {
            const whichCmd = process.platform === 'win32' ? 'where' : 'which'
            const lookup = customPi && !isAbsolute(customPi) ? customPi : 'pi'
            const which = spawnSync(whichCmd, [lookup], { encoding: 'utf-8' })
            const piPath = String(which.stdout ?? '')
              .split(/\r?\n/)[0]
              ?.trim()

            if (piPath) {
              const resolved = realpathSync(piPath)
              const pkgRoot = dirname(dirname(resolved))
              const p = join(pkgRoot, 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          // 2) Fallback: ask npm where global modules live.
          try {
            const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8' })
            const root = String(npmRoot.stdout ?? '').trim()
            if (root) {
              const p = join(root, '@earendil-works', 'pi-coding-agent', 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          return null
        }

        const changelogPath = findChangelog()
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: "Changelog not found (couldn't locate pi installation)." }
            }
          })
          return { stopReason: 'end_turn' }
        }

        let text = ''
        try {
          text = readFileSync(changelogPath, 'utf-8')
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000
        if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n...(truncated)...'

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'export') {
        // For now we always export into the session cwd and do not accept a user-provided path.
        // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
        // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
        // (no id), which would otherwise hang our request. So we guard here.
        const state = (await session.proc.getState()) as any
        const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
        const messageCount = typeof state?.messageCount === 'number' ? state.messageCount : 0

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Nothing to export yet (no session messages). Send a prompt first.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          const raw = readFileSync(sessionFile, 'utf-8')
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Nothing to export yet (empty session file). Send a prompt first.'
                }
              }
            })
            return { stopReason: 'end_turn' }
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`)

        let resultPath = ''
        try {
          const result = await session.proc.exportHtml(outputPath)
          resultPath = result.path
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Export failed: no output path returned by pi.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const uri = `file://${resultPath}`

        // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
        // assistant message, so this avoids the "link + duplicate plain text" look.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Session exported: '
            }
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource_link',
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: 'text/html',
              title: 'Session exported'
            }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'autocompact') {
        const mode = (args[0] ?? 'toggle').toLowerCase()
        let enabled: boolean | null = null
        if (mode === 'on' || mode === 'true' || mode === 'enable' || mode === 'enabled') enabled = true
        else if (mode === 'off' || mode === 'false' || mode === 'disable' || mode === 'disabled') enabled = false

        if (enabled === null) {
          // toggle: read current state and invert.
          const state = (await session.proc.getState()) as any
          const current = Boolean(state?.autoCompactionEnabled)
          enabled = !current
        }

        await session.proc.setAutoCompaction(enabled)

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`
            }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'bash') {
        const command = args.join(' ').trim()
        if (!command) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Usage: /bash <command>' } }
          })
          return { stopReason: 'end_turn' }
        }
        try {
          const result: any = await session.proc.bash(command)
          const output = typeof result?.output === 'string' ? result.output : JSON.stringify(result, null, 2)
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output || '(no output)' } }
          })
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `bash failed: ${String(e?.message ?? e)}` }
            }
          })
        }
        return { stopReason: 'end_turn' }
      }

      if (cmd === 'fork') {
        const entryId = String(args[0] ?? '').trim()
        if (!entryId) {
          const data: any = await session.proc.getForkMessages().catch(() => null)
          const msgs = Array.isArray(data?.messages) ? data.messages : []
          const text = msgs.length
            ? msgs.map((m: any) => `${m.entryId}: ${String(m.text ?? '').slice(0, 80)}`).join('\n')
            : 'No fork points'
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
          })
          return { stopReason: 'end_turn' }
        }
        try {
          await session.proc.fork(entryId)
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Forked from ${entryId}` } }
          })
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `fork failed: ${String(e?.message ?? e)}` }
            }
          })
        }
        return { stopReason: 'end_turn' }
      }

      if (cmd === 'clone') {
        try {
          await session.proc.clone()
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Cloned current branch' } }
          })
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `clone failed: ${String(e?.message ?? e)}` }
            }
          })
        }
        return { stopReason: 'end_turn' }
      }

      if (cmd === 'reload') {
        try {
          const fileCommands = loadSlashCommands(session.cwd)
          const enableSkillCommands = getEnableSkillCommands(session.cwd)
          const cmds = await loadAvailableCommands(session.proc, fileCommands, enableSkillCommands)
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: { sessionUpdate: 'available_commands_update', availableCommands: cmds }
          })
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Reloaded extensions and skills' }
            }
          })
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `reload failed: ${String(e?.message ?? e)}` }
            }
          })
        }
        return { stopReason: 'end_turn' }
      }
    }

    try {
      return { stopReason: await session.prompt(message, images) }
    } catch (error) {
      this.sessions.close(session.sessionId)
      throw error
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.maybeGet(params.sessionId)
    if (!session) return
    await session.cancel()
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP: filter by cwd if provided.
    // Zed currently sends `{}` (no cwd), so we default to the last session cwd to
    // emulate pi's `/resume` picker (project-scoped).
    const all = listPiSessions()

    const effectiveCwd = (params as any).cwd ?? this.lastSessionCwd
    const filtered = effectiveCwd ? all.filter(s => s.cwd === effectiveCwd) : all

    // Cursor-based pagination (opaque cursor). For MVP, we use a simple numeric offset.
    // If cursor is invalid, treat as 0.
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0

    const PAGE_SIZE = 50
    const page = filtered.slice(start, start + PAGE_SIZE)

    const sessions: SessionInfo[] = page.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }))

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    // If the client is re-loading a session that is already active, tear down the existing
    // pi subprocess so we can start fresh and re-advertise commands reliably.
    // (Some clients may call session/load when restoring from history.)
    this.sessions.close(params.sessionId)

    this.lastSessionCwd = params.cwd

    const stored = this.findStoredSession(params.sessionId)
    if (!stored) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)
    }

    const enableSkillCommands = getEnableSkillCommands(params.cwd)
    const additionalDirectories = normalizeAdditionalDirectories((params as any).additionalDirectories, params.cwd)
    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      additionalDirectories
    })
    const proc = session.proc
    const fileCommands = loadSlashCommands(params.cwd)

    // Policy: within a single ACP connection (one Zed window), keep only one live pi subprocess.
    // (Tests sometimes stub out `this.sessions`, so guard the call.)
    ;(this.sessions as any).closeAllExcept?.(session.sessionId)

    // (Optional) ensure mapping stays fresh.
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile: stored.sessionFile
    })

    // Replay full conversation history.
    const data = (await proc.getMessages()) as any
    const messages = Array.isArray(data?.messages) ? data.messages : []

    for (const m of messages) {
      const role = String(m?.role ?? '')

      if (role === 'user') {
        const text = normalizePiMessageText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text }
            }
          })
        }
      }

      if (role === 'assistant') {
        const text = normalizePiAssistantText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text }
            }
          })
        }
      }

      if (role === 'toolResult') {
        const toolName = String((m as any)?.toolName ?? 'tool')
        const toolCallId = String((m as any)?.toolCallId ?? crypto.randomUUID())
        const isError = Boolean((m as any)?.isError)
        const isBash = isBashTool(toolName)

        if (isBash) {
          const text = bashResultText(m)
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: bashCommand(m) ?? toolName,
              kind: 'execute',
              status: 'completed',
              content: bashTerminalContent(toolCallId),
              _meta: bashTerminalInfoMeta(toolCallId, params.cwd)
            }
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: isError ? 'failed' : 'completed',
              _meta: {
                ...(text ? bashTerminalOutputMeta(toolCallId, text) : {}),
                ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
              }
            }
          })
          continue
        }

        // Create a synthetic ACP tool call to render historic tool usage.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toolName === 'read' ? 'read' : toolName === 'write' || toolName === 'edit' ? 'edit' : 'other',
            status: 'completed',
            rawInput: null,
            rawOutput: m
          }
        })

        const text = toolResultToText(m)
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: isError ? 'failed' : 'completed',
            content: text ? [{ type: 'content', content: { type: 'text', text } }] : null,
            rawOutput: m
          }
        })
      }
    }

    const { configOptions, models, modes } = await getSessionConfiguration(proc, { cwd: params.cwd })
    const availableCommands = await loadAvailableCommands(proc, fileCommands, enableSkillCommands)

    const response = {
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    }

    setTimeout(() => {
      void session.publishContextUsage()
      void this.conn
        .sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands
          }
        })
        .catch(() => {})
    }, 0)

    return response
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    const stored = this.store.get(params.sessionId)
    const piSession = findPiSession(params.sessionId)

    // Per ACP session/delete semantics, deleting a session that does not
    // exist (or is already gone) should succeed idempotently.
    // https://agentclientprotocol.com/protocol/v2/session-delete#semantics
    if (!stored && !piSession) {
      return {}
    }

    const sessionFile = stored?.sessionFile ?? piSession?.sessionFile

    if (sessionFile) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // best-effort cleanup
      }
    }

    this.store.delete(params.sessionId)

    return {}
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const session = await this.restoreSession(params.sessionId)
    await setSessionModel(session.proc, params.modelId)
    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)
    if (typeof (session as any).publishContextUsage === 'function') await session.publishContextUsage()
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = await this.restoreSession(params.sessionId)

    const mode = String(params.modeId)
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`)
    }

    await session.proc.setThinkingLevel(mode)

    // Let the client know the current mode changed (keeps the dropdown in sync).
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: mode
      }
    })

    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)

    return {}
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = await this.restoreSession(params.sessionId)
    const configId = String(params.configId)
    let modelChanged = false

    if (typeof params.value !== 'string') {
      throw RequestError.invalidParams(`Expected string value for config option: ${configId}`)
    }

    if (configId === MODEL_CONFIG_ID) {
      await setSessionModel(session.proc, params.value)
      modelChanged = true
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (!isThinkingLevel(params.value)) {
        throw RequestError.invalidParams(`Unknown thinking level: ${params.value}`)
      }

      await session.proc.setThinkingLevel(params.value)

      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: params.value
        }
      })
    } else {
      throw RequestError.invalidParams(`Unknown config option: ${configId}`)
    }

    const configOptions = await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)
    if (modelChanged && typeof (session as any).publishContextUsage === 'function') await session.publishContextUsage()
    return { configOptions }
  }
}

function isThinkingLevel(x: string): x is ThinkingLevel {
  return x === 'off' || x === 'minimal' || x === 'low' || x === 'medium' || x === 'high' || x === 'xhigh' || x === 'max'
}

async function getThinkingState(
  proc: PiRpcProcess,
  pre?: { state?: any | null }
): Promise<{
  availableModes: Array<{
    id: string
    name: string
    description?: string | null
  }>
  currentModeId: string
}> {
  // Ask pi for current thinking level.
  let current: ThinkingLevel = 'medium'

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch {
        return null
      }
    })())

  const tl = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null
  if (tl && isThinkingLevel(tl)) current = tl

  let available: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  try {
    const maybe = proc as unknown as { getAvailableThinkingLevels?: () => Promise<string[]> }
    if (typeof maybe.getAvailableThinkingLevels === 'function') {
      const levels = await maybe.getAvailableThinkingLevels()
      if (Array.isArray(levels) && levels.length) {
        const filtered = levels.filter(isThinkingLevel)
        available = (filtered.length ? filtered : levels) as ThinkingLevel[]
      }
    }
  } catch {
    // fallback to hardcoded list
  }

  return {
    currentModeId: current,
    availableModes: available.map(id => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  }
}

async function getSessionConfiguration(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null; cwd?: string }
): Promise<{
  configOptions: SessionConfigOption[]
  models: {
    availableModels: AdvertisedModel[]
    currentModelId: string
  } | null
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  } | null
}> {
  const [models, modes] = await Promise.all([
    getModelState(proc, pre, pre?.cwd),
    getThinkingState(proc, { state: pre?.state })
  ])
  const configOptions = buildConfigOptions({ models, modes })
  const hasThoughtLevel = configOptions.some(o => o.id === THOUGHT_LEVEL_CONFIG_ID)
  return {
    configOptions,
    models,
    modes: hasThoughtLevel ? null : modes
  }
}

function buildConfigOptions(state: {
  models: {
    availableModels: AdvertisedModel[]
    currentModelId: string
  } | null
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  }
}): SessionConfigOption[] {
  const configOptions: SessionConfigOption[] = [
    {
      type: 'select',
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: 'thought_level',
      name: 'Thinking',
      description: 'Set the reasoning effort for this session',
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map(mode => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null
      }))
    }
  ]

  if (state.models?.availableModels.length) {
    configOptions.unshift({
      type: 'select',
      id: MODEL_CONFIG_ID,
      category: 'model',
      name: 'Model',
      description: 'Select the model for this session',
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map(model => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    })
  }

  return configOptions
}

async function getModelState(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null },
  cwd?: string
): Promise<{
  availableModels: AdvertisedModel[]
  currentModelId: string
} | null> {
  // Ask pi for available models.
  let availableModels: AdvertisedModel[] = []

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        return (await proc.getAvailableModels()) as any
      } catch {
        return null
      }
    })())

  const models: any[] = Array.isArray(data?.models) ? data.models : []
  availableModels = models
    .map(m => {
      const provider = String(m?.provider ?? '').trim()
      const id = String(m?.id ?? '').trim()
      if (!provider || !id) return null

      const name = String(m?.name ?? id)
      return {
        modelId: `${provider}/${id}`,
        name: `${provider}/${name}`,
        description: null
      } satisfies AdvertisedModel
    })
    .filter(Boolean) as AdvertisedModel[]

  // Respect enabledModels filter from pi settings (global + project merge)
  const effectiveCwd =
    cwd ??
    (() => {
      try {
        return process.cwd()
      } catch {
        return ''
      }
    })()
  if (effectiveCwd) {
    const enabled = getEnabledModels(effectiveCwd)
    if (enabled && enabled.length) {
      const lower = enabled.map(s => s.toLowerCase())
      const filtered = availableModels.filter(m => {
        const modelIdLower = m.modelId.toLowerCase()
        const idOnly = m.modelId.split('/').pop()!.toLowerCase()
        return (
          lower.includes(modelIdLower) ||
          lower.includes(idOnly) ||
          lower.some(p => modelIdLower.includes(p.toLowerCase()))
        )
      })
      if (filtered.length) availableModels = filtered
    }
  }

  // Ask pi what model is currently active.
  let currentModelId: string | null = null

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch {
        return null
      }
    })())

  const model = state?.model
  if (model && typeof model === 'object') {
    const provider = String((model as any).provider ?? '').trim()
    const id = String((model as any).id ?? '').trim()
    if (provider && id) currentModelId = `${provider}/${id}`
  }

  if (!availableModels.length && !currentModelId) return null

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? 'default'

  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? 'default'
  }
}

async function emitConfigOptionsUpdate(
  conn: AgentSideConnection,
  sessionId: string,
  proc: PiRpcProcess
): Promise<SessionConfigOption[]> {
  const { configOptions } = await getSessionConfiguration(proc)

  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions
    }
  })

  return configOptions
}

async function setSessionModel(proc: PiRpcProcess, requestedModelId: string): Promise<void> {
  // Either half may contain a slash — model ids like "google/gemma-3-12b" are
  // common, and a provider id is whatever the extension registering it chose —
  // so resolve against the catalog rather than guessing where the split falls.
  const data = (await proc.getAvailableModels()) as any
  const models: any[] = Array.isArray(data?.models) ? data.models : []
  const found =
    models.find(m => `${String(m?.provider ?? '')}/${String(m?.id ?? '')}` === requestedModelId) ??
    models.find(m => String(m?.id ?? '') === requestedModelId)

  if (found) {
    await proc.setModel(String(found.provider), String(found.id))
    return
  }

  // Not advertised by pi. Split at the first slash so the rejection still comes
  // from pi rather than from a guess made here.
  const separator = requestedModelId.indexOf('/')
  if (separator < 1) {
    throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`)
  }

  await proc.setModel(requestedModelId.slice(0, separator), requestedModelId.slice(separator + 1))
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v)
}

function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

function buildUpdateNotice(): string | null {
  if (process.env.PI_ACP_CHECK_FOR_UPDATES === 'false') return null
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    const piCmd = getPiCommand(process.env.PI_ACP_PI_COMMAND)
    const piVersion = spawnSync(piCmd, ['--version'], {
      encoding: 'utf-8',
      shell: piCmd.endsWith('.cmd') || piCmd.endsWith('.bat')
    })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )

    if (!installed || !isSemver(installed)) return null

    const latestRes = spawnSync('npm', ['view', '@earendil-works/pi-coding-agent', 'version'], {
      encoding: 'utf-8',
      timeout: 800
    })
    const latest = String(latestRes.stdout ?? '')
      .trim()
      .replace(/^v/i, '')

    if (!latest || !isSemver(latest)) return null
    if (compareSemver(latest, installed) <= 0) return null

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``
  } catch {
    return null
  }
}

function buildStartupInfo(opts: {
  cwd: string
  fileCommands: ReturnType<typeof loadSlashCommands>
  updateNotice: string | null
  additionalDirectories?: string[]
}): string {
  void opts.fileCommands

  const md: string[] = []

  // pi version header
  try {
    const piCmd = getPiCommand(process.env.PI_ACP_PI_COMMAND)
    const piVersion = spawnSync(piCmd, ['--version'], {
      encoding: 'utf-8',
      shell: piCmd.endsWith('.cmd') || piCmd.endsWith('.bat')
    })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )
    if (installed) {
      md.push(`pi v${installed}`)
      md.push('---')
      md.push('')
    }
  } catch {
    // ignore
  }

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map(s => s.trim()).filter(Boolean)
    if (!cleaned.length) return

    md.push(`## ${title}`)
    for (const item of cleaned) md.push(`- ${item}`)
    md.push('')
  }

  // Context
  const contextItems: string[] = []
  const contextPath = join(opts.cwd, 'AGENTS.md')
  if (existsSync(contextPath)) contextItems.push(contextPath)
  addSection('Context', contextItems)

  addSection('Additional workspace roots', opts.additionalDirectories ?? [])

  // Skills
  const skillsItems: string[] = []

  const pushSkillFromRoot = (root: string) => {
    try {
      // Direct .md files in root
      for (const e of readdirSync(root)) {
        const p = join(root, e)
        try {
          const st = statSync(p)
          if (st.isFile() && e.toLowerCase().endsWith('.md')) {
            skillsItems.push(p)
          }
        } catch {
          // ignore
        }
      }

      // Recursive SKILL.md under subdirectories
      const stack: string[] = [root]
      while (stack.length) {
        const dir = stack.pop()!
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }

        for (const name of entries) {
          // Skip obvious noise
          if (name === 'node_modules' || name === '.git') continue
          const p = join(dir, name)
          let st
          try {
            st = statSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            stack.push(p)
          } else if (st.isFile() && name === 'SKILL.md') {
            skillsItems.push(p)
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Global skills
  // Use getAgentDir() so this respects PI_CODING_AGENT_DIR overrides.
  const globalSkillsDir = join(getAgentDir(), 'skills')
  pushSkillFromRoot(globalSkillsDir)

  // Also support ~/.agents/skills (pi skill discovery)
  const legacyAgentsSkillsDir = join(process.env.HOME ?? '', '.agents', 'skills')
  pushSkillFromRoot(legacyAgentsSkillsDir)

  // Project skills (.pi/skills)
  const projectSkillsDir = join(opts.cwd, '.pi', 'skills')
  pushSkillFromRoot(projectSkillsDir)

  const customSkillsDir = process.env.PI_SKILLS_DIR?.trim() || process.env.PI_AGENT_SKILLS_DIR?.trim()
  if (customSkillsDir) pushSkillFromRoot(customSkillsDir)

  addSection('Skills', skillsItems)

  // Prompts
  const promptsItems: string[] = []
  const promptsDir = join(process.env.HOME ?? '', '.pi', 'agent', 'prompts')
  try {
    const prompts = readdirSync(promptsDir).filter(f => f.endsWith('.md'))
    for (const f of prompts) promptsItems.push(`/${basename(f, '.md')}`)
  } catch {
    // ignore
  }
  addSection('Prompts', promptsItems)

  // Extensions
  const extItems: string[] = []
  const extDir = join(process.env.HOME ?? '', '.pi', 'agent', 'extensions')
  try {
    const exts = readdirSync(extDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    for (const f of exts) extItems.push(join(extDir, f))
  } catch {
    // ignore
  }

  // Also show npm packages from pi settings (global + project)
  const settingsPaths = [join(getAgentDir(), 'settings.json'), join(opts.cwd, '.pi', 'settings.json')]
  for (const settingsPath of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as any
      const pkgs: unknown[] = Array.isArray(settings?.packages) ? settings.packages : []
      for (const pkg of pkgs) {
        let name: string
        if (typeof pkg === 'string') name = pkg
        else if (pkg && typeof pkg === 'object') {
          const o = pkg as any
          name = String(o.name ?? o.package ?? o.id ?? JSON.stringify(o))
        } else name = String(pkg)
        extItems.push(name)
      }
    } catch {
      // ignore
    }
  }

  // Dedupe and keep stable order, truncate long lists
  const dedupedExt = [...new Set(extItems)]
  const displayExt = dedupedExt.length > 8 ? [...dedupedExt.slice(0, 7), `+${dedupedExt.length - 7} more`] : dedupedExt
  addSection('Extensions', displayExt)

  if (opts.updateNotice) {
    md.push('---')
    md.push(opts.updateNotice)
    md.push('')
  }

  // Do NOT include themes (per request).
  return md.join('\n').trim() + '\n'
}

function readNearestPackageJson(metaUrl: string): {
  name?: string
  version?: string
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl))

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, 'utf-8')) as any
        return { name: json?.name, version: json?.version }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'pi-acp', version: '0.0.0' }
}
