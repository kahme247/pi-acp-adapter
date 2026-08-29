import type { PlanEntry, PlanEntryStatus } from '@agentclientprotocol/sdk'

type SubagentSingleResult = {
  agent: string
  task: string
  exitCode?: number
  stopReason?: string
  agentSource?: string
  step?: number
}

type SubagentDetails = {
  mode: 'single' | 'parallel' | 'chain'
  results: SubagentSingleResult[]
}

type SubagentArgs = {
  agent?: string
  task?: string
  tasks?: { agent: string; task: string }[]
  chain?: { agent: string; task: string }[]
}

function toPlanStatus(r: SubagentSingleResult): PlanEntryStatus {
  if (typeof r.exitCode === 'number') {
    if (r.exitCode === -1) return 'in_progress'
    if (r.exitCode === 0 && r.stopReason !== 'error' && r.stopReason !== 'aborted') return 'completed'
    // failed still maps to completed (ACP has no failed status, show as completed with ✗ in content)
    return 'completed'
  }
  return 'in_progress'
}

function formatTask(task: string): string {
  const t = task.trim().replace(/\s+/g, ' ')
  return t.length > 60 ? `${t.slice(0, 60)}…` : t
}

export function subagentDetailsToPlanEntries(details: SubagentDetails): PlanEntry[] {
  if (!details?.results?.length) return []
  return details.results.map(r => {
    const status = toPlanStatus(r)
    const prefix = r.step ? `Step ${r.step}: ` : ''
    const agent = r.agent || 'subagent'
    const task = formatTask(r.task || '')
    const failed = r.exitCode !== 0 && r.exitCode !== -1
    const icon = failed ? '✗ ' : status === 'completed' ? '✓ ' : status === 'in_progress' ? '⏳ ' : ''
    const content = task ? `${icon}${prefix}${agent}: ${task}` : `${icon}${prefix}${agent}`
    return {
      content,
      priority: 'medium' as const,
      status
    } satisfies PlanEntry
  })
}

export function extractSubagentDetails(result: unknown): SubagentDetails | null {
  const details = (result as any)?.details
  if (details && typeof details.mode === 'string' && Array.isArray(details.results)) {
    return details as SubagentDetails
  }
  // fallback: result itself might be details (for partial updates)
  if ((result as any)?.mode && Array.isArray((result as any)?.results)) {
    return result as SubagentDetails
  }
  return null
}

export function subagentArgsToPlanEntries(args: unknown): PlanEntry[] | null {
  const a = args as SubagentArgs | null | undefined
  if (!a || typeof a !== 'object') return null

  if (Array.isArray(a.chain) && a.chain.length > 0) {
    return a.chain.map((step, i) => ({
      content: `⏳ Step ${i + 1}: ${step.agent}: ${formatTask(step.task)}`,
      priority: 'medium' as const,
      status: (i === 0 ? 'in_progress' : 'pending') as PlanEntryStatus
    }))
  }

  if (Array.isArray(a.tasks) && a.tasks.length > 0) {
    return a.tasks.map(t => ({
      content: `⏳ ${t.agent}: ${formatTask(t.task)}`,
      priority: 'medium' as const,
      status: 'in_progress' as PlanEntryStatus
    }))
  }

  if (typeof a.agent === 'string' && typeof a.task === 'string') {
    return [
      {
        content: `⏳ ${a.agent}: ${formatTask(a.task)}`,
        priority: 'medium' as const,
        status: 'in_progress' as PlanEntryStatus
      }
    ]
  }

  return null
}
