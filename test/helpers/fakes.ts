import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }
  readonly elicitationRequests: unknown[] = []
  elicitationResponse: any = { action: 'accept', content: { value: 'my answer' } }
  elicitationError: Error | null = null

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }

  async unstable_createElicitation(params: any): Promise<any> {
    this.elicitationRequests.push(params)
    if (this.elicitationError) throw this.elicitationError
    return this.elicitationResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly steers: Array<{ message: string; images: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  nextPromptError: Error | null = null

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
    if (this.nextPromptError) {
      const err = this.nextPromptError
      this.nextPromptError = null
      throw err
    }
  }

  async steer(message: string, images: unknown[] = []): Promise<void> {
    this.steers.push({ message, images })
  }

  async followUp(message: string, images: unknown[] = []): Promise<void> {
    this.steers.push({ message, images })
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return { steering: [], followUp: [] }
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getSessionStats(): Promise<any> {
    return {}
  }

  async getCommands(): Promise<any> {
    return { commands: [] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
