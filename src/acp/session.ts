import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent, type PiSessionStats } from '../pi-rpc/process.js'
import { extractRpivTasks, rpivTasksToPlanEntries } from './rpiv-todo.js'
import {
  extractSubagentDetails,
  subagentArgsToPlanEntries,
  subagentDetailsToPlanEntries
} from './subagent-plan.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { toolResultToText } from './translate/pi-tools.js'

function shouldExpandToolCalls(): boolean {
  const v = process.env.PI_ACP_EXPAND_TOOL_CALLS
  if (v === 'true' || v === '1' || v === 'expand') return true
  if (v === 'false' || v === '0' || v === 'collapsed') return false
  return false
}

function shouldIncludeRawIO(): boolean {
  return shouldExpandToolCalls()
}

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  additionalDirectories?: string[]
}

export type StopReason = 'end_turn' | 'cancelled'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

function toUsageUpdate(stats: PiSessionStats | null | undefined): SessionUpdate | null {
  const used = stats?.contextUsage?.tokens
  const size = stats?.contextUsage?.contextWindow
  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null
  return { sessionUpdate: 'usage_update', used, size }
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  let value: any = args
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return undefined }
  }
  const candidates: unknown[] = [
    (value as any)?.path,
    (value as any)?.file_path,
    (value as any)?.filePath,
    (value as any)?.args?.path,
    (value as any)?.args?.file_path,
    (value as any)?.args?.filePath,
    (value as any)?.input?.path,
    (value as any)?.input?.file_path,
    (value as any)?.toolInput?.path,
    (value as any)?.details?.path,
  ]
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
        ...(params.additionalDirectories?.length ? { additionalDirectories: params.additionalDirectories } : {}),
        ...(params.mcpServers?.length ? { mcpServers: params.mcpServers } : {})
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      additionalDirectories: params.additionalDirectories ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]
  readonly additionalDirectories: string[]

  private startupInfo: string | null = null
  private startupInfoSent = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  get hasPendingTurn(): boolean {
    return this.pendingTurn !== null
  }
  private readonly turnQueue: QueuedTurn[] = []
  private readonly steeredTurns: PendingTurn[] = []
  private pendingTurnFallback: ReturnType<typeof setTimeout> | null = null
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()
  private subagentToolCallIds = new Set<string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  // ---- Reasoning coalescing ----
  private readonly thoughtHoldMs = (() => {
    const n = Number(process.env.PI_ACP_THINK_HOLD_MS)
    return Number.isFinite(n) && n >= 0 ? n : 200
  })()
  private thinkingSeen = false
  private streamDirect = false
  private holdBuf: string[] = []
  private holdTimer: NodeJS.Timeout | null = null

  private lastAssistantError: string | null = null

  private flushHeldText(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
    const text = this.holdBuf.join('')
    this.holdBuf = []
    this.streamDirect = true
    if (text) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text } satisfies ContentBlock
      })
    }
  }

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    additionalDirectories?: string[]
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.additionalDirectories = opts.additionalDirectories ?? []
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      // If a turn is already running, steer if agent loop active, else queue.
      if (this.pendingTurn) {
        if (this.inAgentLoop) {
          const steered: PendingTurn = { resolve, reject }
          this.steeredTurns.push(steered)
          this.proc.steer(expandedMessage, images).catch(err => {
            const idx = this.steeredTurns.indexOf(steered)
            if (idx !== -1) this.steeredTurns.splice(idx, 1)
            reject(err)
          })
          return
        }
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    this.clearFallback()
    // Cancel current and clear any queued/steered prompts.
    this.cancelRequested = true

    if (this.steeredTurns.length) {
      const steered = this.steeredTurns.splice(0)
      for (const t of steered) t.resolve('cancelled')
    }

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    try {
      await this.proc.clearQueue()
    } catch {
      // ignore - queue clearing is best-effort
    }
    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  async publishContextUsage(): Promise<void> {
    try {
      if (typeof this.proc.getSessionStats === 'function') {
        const update = toUsageUpdate(await this.proc.getSessionStats())
        if (update) this.emit(update)
      }
    } catch {
      void 0 // ignore - context usage is auxiliary
    }
    await this.flushEmits()
  }

  private clearFallback(): void {
    if (this.pendingTurnFallback) {
      clearTimeout(this.pendingTurnFallback)
      this.pendingTurnFallback = null
    }
  }

  private async settleTurn(): Promise<void> {
    this.clearFallback()
    await this.publishContextUsage()
    const pendingTurn = this.pendingTurn
    if (!pendingTurn) return
    const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
    const turns = [pendingTurn, ...this.steeredTurns.splice(0)].filter(Boolean) as PendingTurn[]
    for (const t of turns) t.resolve(reason)
    this.pendingTurn = null
    this.inAgentLoop = false
    const next = this.turnQueue.shift()
    if (next) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
      })
      this.startTurn(next)
    } else {
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: false } }
      })
    }
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    const rawTitle = bashCommand(params.args) ?? params.toolName
    const title = rawTitle.length > 80 ? `${rawTitle.slice(0, 80)}…` : rawTitle
    const useTerminal = params.includeTerminal
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(useTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(useTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    const useTerminal = this.bashToolCallIds.has(params.toolCallId)
    if (!useTerminal && params.status === 'in_progress') {
      this.emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: params.toolCallId,
        status: params.status
      })
      return
    }
    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      ...(useTerminal
        ? {
            _meta: {
              ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
              ...((params.status === 'completed' || params.status === 'failed'
                ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
                : {}) as object)
            }
          }
        : {})
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
    this.subagentToolCallIds.delete(toolCallId)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.lastAssistantError = null
    this.thinkingSeen = false
    this.streamDirect = false
    this.holdBuf = []
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }

    const pendingTurn = { resolve: t.resolve, reject: t.reject }
    this.pendingTurn = pendingTurn

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    this.proc.prompt(t.message, t.images).catch(err => {
      this.flushHeldText()
      void this.flushEmits().finally(() => {
        if (this.pendingTurn !== pendingTurn) return
        const authErr = maybeAuthRequiredError(err)
        if (!authErr && !this.cancelRequested) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Prompt failed: ${errorText(err)}` } satisfies ContentBlock
          })
        }
        if (authErr) {
          pendingTurn.reject(authErr)
        } else if (this.cancelRequested) {
          pendingTurn.resolve('cancelled')
        } else {
          pendingTurn.reject(err)
        }
        this.clearFallback()
        this.pendingTurn = null
        this.inAgentLoop = false
        const turns = [...this.steeredTurns.splice(0), ...this.turnQueue.splice(0)]
        for (const turn of turns) {
          if (this.cancelRequested) turn.resolve('cancelled')
          else turn.reject(err)
        }
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: 0, running: false } }
        })
      })
    })
    this.clearFallback()
    this.pendingTurnFallback = setTimeout(() => {
      if (this.pendingTurn !== pendingTurn || this.inAgentLoop) return
      void this.flushEmits().finally(() => {
        if (this.pendingTurn !== pendingTurn) return
        pendingTurn.resolve('end_turn')
        this.pendingTurn = null
        this.inAgentLoop = false
        this.clearFallback()
        const next = this.turnQueue.shift()
        if (next) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
          })
          this.startTurn(next)
        } else {
          this.emit({
            sessionUpdate: 'session_info_update',
            _meta: { piAcp: { queueDepth: 0, running: false } }
          })
        }
      })
    }, 3000)
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          if (this.streamDirect || !this.thinkingSeen) {
            if (!this.thinkingSeen) this.streamDirect = true
            this.emit({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: ame.delta } satisfies ContentBlock
            })
          } else {
            this.holdBuf.push(ame.delta)
            if (!this.holdTimer) {
              this.holdTimer = setTimeout(() => this.flushHeldText(), this.thoughtHoldMs)
            }
          }
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.thinkingSeen = true
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          if (this.holdTimer) {
            clearTimeout(this.holdTimer)
            this.holdTimer = setTimeout(() => this.flushHeldText(), this.thoughtHoldMs)
          }
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          this.flushHeldText()
          const toolCall = (ame as any)?.toolCall ?? (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((ame as any)?.id ?? (toolCall as any)?.id ?? '')
          const toolName = String((ame as any)?.toolName ?? (toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : ame?.type === 'toolcall_end' && (ame as any)?.toolCall?.arguments
                  ? (ame as any).toolCall.arguments
                  : (() => {
                      const delta = typeof (ame as any)?.delta === 'string' ? (ame as any).delta : ''
                      const s = String((toolCall as any)?.partialArgs ?? delta ?? '')
                      if (!s) return undefined
                      try {
                        return JSON.parse(s)
                      } catch {
                        return { partialArgs: s }
                      }
                    })()

            const locations = ame.type === 'toolcall_end' ? toToolCallLocations(rawInput, this.cwd) : undefined
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolDisplayTitle(toolName, rawInput),
                kind: toToolKind(toolName),
                status,
                locations,
                ...(shouldIncludeRawIO() ? { rawInput } : {})
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                locations,
                ...(shouldIncludeRawIO() ? { rawInput } : {})
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'message_end': {
        const message = (ev as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message
        if (message?.role === 'assistant') {
          this.lastAssistantError =
            message.stopReason === 'error' && typeof message.errorMessage === 'string' && message.errorMessage
              ? message.errorMessage
              : null
        }
        break
      }

      case 'tool_execution_start': {
        this.flushHeldText()
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // subagent bar: translate subagent args into ACP plan pane (like todo)
        if (toolName === 'subagent') {
          this.subagentToolCallIds.add(toolCallId)
          const entries = subagentArgsToPlanEntries(args)
          if (entries) this.emit({ sessionUpdate: 'plan', entries } as SessionUpdate)
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolDisplayTitle(toolName, args),
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            ...(shouldIncludeRawIO() ? { rawInput: args } : {})
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            ...(shouldIncludeRawIO() ? { rawInput: args } : {})
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        if (this.subagentToolCallIds.has(toolCallId)) {
          const details = extractSubagentDetails(partial)
          if (details) {
            const entries = subagentDetailsToPlanEntries(details)
            if (entries.length) this.emit({ sessionUpdate: 'plan', entries } as SessionUpdate)
          }
        }

        const isFileMutation = this.fileMutationToolCallIds.has(toolCallId)
        const expand = shouldExpandToolCalls()
        const text = isFileMutation ? '' : toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          ...(expand && text
            ? { content: [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[] }
            : {}),
          ...(isFileMutation || !expand ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const expand = shouldExpandToolCalls()
        const text = expand ? toolResultToText(result) : ''

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (expand && !content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          ...(content ? { content } : {}),
          ...(hasStructuredDiff || !expand ? {} : { rawOutput: result })
        })

        // rpiv-todo adapter: translate todo tool snapshot into ACP plan pane
        const toolNameForPlan = String((ev as any).toolName ?? '')
        if (toolNameForPlan === 'todo') {
          const tasks = extractRpivTasks(result)
          if (tasks) {
            const entries = rpivTasksToPlanEntries(tasks)
            this.emit({ sessionUpdate: 'plan', entries } as SessionUpdate)
          }
        }
        // subagent bar: translate subagent results into ACP plan pane (like todo)
        if (toolNameForPlan === 'subagent') {
          const details = extractSubagentDetails(result)
          if (details) {
            const entries = subagentDetailsToPlanEntries(details)
            if (entries.length) this.emit({ sessionUpdate: 'plan', entries } as SessionUpdate)
          }
        }

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        const success = (ev as { success?: boolean }).success !== false
        if (success) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
          })
        } else {
          const attempt = Number((ev as { attempt?: unknown }).attempt)
          const finalError = (ev as { finalError?: unknown }).finalError
          const detail =
            typeof finalError === 'string' && finalError ? finalError : (this.lastAssistantError ?? 'unknown error')
          const attempts = Number.isFinite(attempt) ? ` after ${attempt} attempts` : ''
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Retry failed${attempts}: ${detail}` } satisfies ContentBlock
          })
          this.lastAssistantError = null
        }
        break
      }

      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'compaction_start': {
        const reason = typeof (ev as any).reason === 'string' ? (ev as any).reason : ''
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Compacting context${reason ? ` (${reason})` : ''}...` } satisfies ContentBlock
        })
        break
      }

      case 'compaction_end': {
        const aborted = Boolean((ev as any).aborted)
        const errorMessage = typeof (ev as any).errorMessage === 'string' ? (ev as any).errorMessage : ''
        if (aborted) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Compaction aborted.' } satisfies ContentBlock
          })
        } else if (errorMessage) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Compaction failed: ${errorMessage}` } satisfies ContentBlock
          })
        } else {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Compaction finished.' } satisfies ContentBlock
          })
        }
        break
      }

      case 'queue_update': {
        const steering = Array.isArray((ev as any).steering) ? (ev as any).steering.length : 0
        const followUp = Array.isArray((ev as any).followUp) ? (ev as any).followUp.length : 0
        const total = steering + followUp
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: total, running: true } }
        })
        break
      }

      case 'ui_prompt_start':
      case 'ui_prompt_end':
      case 'session_compact_failed':
      case 'extension_error': {
        const msg =
          typeof (ev as any).message === 'string'
            ? (ev as any).message
            : typeof (ev as any).errorMessage === 'string'
              ? (ev as any).errorMessage
              : type === 'ui_prompt_start'
                ? 'Waiting for input...'
                : ''
        if (msg) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: msg } satisfies ContentBlock
          })
        }
        break
      }

      case 'session_info_changed': {
        const name = typeof (ev as any).name === 'string' ? (ev as any).name.trim() : ''
        if (name) {
          this.emit({
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          })
        }
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        this.clearFallback()
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        this.inAgentLoop = false
        break
      }

      case 'agent_settled': {
        this.flushHeldText()
        if (this.lastAssistantError && !this.cancelRequested) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Provider error: ${this.lastAssistantError}` } satisfies ContentBlock
          })
          this.lastAssistantError = null
        }
        void this.settleTurn()
        break
      }

      case 'bash_execution_update': {
        const delta = typeof (ev as any).delta === 'string' ? (ev as any).delta : ''
        if (delta) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: delta } satisfies ContentBlock
          })
        }
        break
      }

      default:
        break
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input' || method === 'editor') {
      await this.handleExtensionInput(ev, id)
      return
    }

    if (method === 'notify') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' } satisfies ContentBlock,
        _meta: { piAcp: { notify: { level: stringProp(ev, 'notifyType') ?? 'info' } } }
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  private async handleExtensionInput(ev: PiRpcEvent, id: string): Promise<void> {
    const title = stringProp(ev, 'title') ?? 'Pi input'
    const placeholder = stringProp(ev, 'placeholder')
    const prefill = stringProp(ev, 'prefill')
    try {
      const result = await (this.conn as any).unstable_createElicitation?.({
        sessionId: this.sessionId,
        message: title,
        mode: 'form',
        requestedSchema: {
          type: 'object',
          title,
          properties: {
            value: {
              type: 'string',
              title: placeholder ?? 'Answer',
              ...(prefill ? { default: prefill } : {})
            }
          },
          required: ['value']
        }
      })
      const value = result?.action === 'accept' ? result.content?.value : undefined
      await this.proc.sendExtensionUiResponse(typeof value === 'string' ? { id, value } : { id, cancelled: true })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
    }
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const normalized: Array<{ label: string; description?: string }> = Array.isArray(rawOptions)
      ? rawOptions.map(opt => {
          if (typeof opt === 'string') return { label: opt }
          const o = opt as any
          const label = String(o.label ?? o.name ?? o.title ?? String(opt))
          const description = typeof o.description === 'string' ? o.description : undefined
          return { label, description }
        })
      : []
    if (!normalized.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = normalized.map((opt, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name: opt.description ? `${opt.label} — ${opt.description}` : opt.label,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (normalized.at(index)?.label ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
    case 'powershell':
      return 'execute'
    default:
      return 'other'
  }
}

function toolDisplayTitle(toolName: string, args: unknown): string {
  const path = getToolPath(args)
  if (path) return `${toolName}: ${path}`
  const cmd = bashCommand(args)
  if (cmd) return `${toolName}: ${cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd}`
  // fallback for grep/find/ls etc - show first meaningful string arg
  const v: any = args
  const raw = typeof v === 'string' ? v : v != null ? JSON.stringify(v) : ''
  if (raw && raw !== '{}' && raw.length > 2 && raw.length < 120) return `${toolName}: ${raw.slice(0, 80)}`
  if (raw && raw.length >= 120) return `${toolName}: ${raw.slice(0, 80)}…`
  return toolName
}
