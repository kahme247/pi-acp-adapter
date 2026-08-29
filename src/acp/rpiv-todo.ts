import type { PlanEntry, PlanEntryStatus } from '@agentclientprotocol/sdk'

type RpivTodoTask = {
  id: number
  subject: string
  description?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  blockedBy?: number[]
}

function toPlanStatus(s: RpivTodoTask['status']): PlanEntryStatus | null {
  if (s === 'pending') return 'pending'
  if (s === 'in_progress') return 'in_progress'
  if (s === 'completed') return 'completed'
  return null // deleted -> omit
}

export function rpivTasksToPlanEntries(tasks: RpivTodoTask[]): PlanEntry[] {
  return tasks
    .map(t => {
      const status = toPlanStatus(t.status)
      if (!status) return null
      const detail = t.activeForm ?? t.description
      const content = detail ? `${t.subject} — ${detail}` : t.subject
      return {
        content,
        priority: 'medium' as const,
        status
      } satisfies PlanEntry
    })
    .filter(Boolean) as PlanEntry[]
}

export function extractRpivTasks(result: unknown): RpivTodoTask[] | null {
  const details = (result as any)?.details
  if (!details || !Array.isArray(details.tasks)) {
    // Some rpiv-todo calls (like list) still return details.tasks
    // but tool result content is fallback - try to parse details directly
    const maybeTasks = (result as any)?.tasks
    if (Array.isArray(maybeTasks)) return maybeTasks as RpivTodoTask[]
    return null
  }
  return details.tasks as RpivTodoTask[]
}
