import { platform } from 'node:os'

export function defaultPiCommand(): string {
  return platform() === 'win32' ? 'pi.cmd' : 'pi'
}

export function getPiCommand(override?: string): string {
  const cmd = override ?? defaultPiCommand()
  // Harden: reject shell metachars that could be injected via PI_ACP_PI_COMMAND
  // when shouldUseShellForPiCommand enables shell:true on Windows.
  // Allowed: alphanumerics, path separators, ., -, _, :, ~, @, space (will be quoted)
  // Block: & | ; $ ` ( ) { } < > \n \r
  if (override && /[&|;$`(){}\[\]<>\n\r]/.test(override)) {
    throw new Error(`PI_ACP_PI_COMMAND contains unsafe shell characters: ${override}`)
  }
  return cmd
}

export function shouldUseShellForPiCommand(cmd: string): boolean {
  if (platform() !== 'win32') return false

  const normalized = cmd.trim().toLowerCase()
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat')
}
