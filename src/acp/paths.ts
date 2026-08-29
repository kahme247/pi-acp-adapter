import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Storage owned by the ACP adapter.
 *
 * Set PI_ACP_DATA_DIR to override the default location (defaults to ~/.pi/pi-acp).
 * This is separate from pi's own ~/.pi/agent/* directory, which is controlled
 * via PI_CODING_AGENT_DIR.
 */
function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export function getPiAcpDir(): string {
  const raw = process.env.PI_ACP_DATA_DIR
  if (!raw) return join(homedir(), '.pi', 'pi-acp')
  return resolve(expandTilde(raw))
}

export function getPiAcpSessionMapPath(): string {
  return join(getPiAcpDir(), 'session-map.json')
}
