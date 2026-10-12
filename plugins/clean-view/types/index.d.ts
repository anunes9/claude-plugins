export type ChecklistTaskStatus = 'done' | 'active' | 'upcoming'

export type ChecklistTask = {
  id: string
  name: string
  status: ChecklistTaskStatus
  percent: number
  hasReported: boolean
}

export type ChecklistPhase = 'working' | 'needs-you' | 'stuck' | 'stopped' | 'done'

export type Checklist = {
  jobId: string
  title: string
  phase: ChecklistPhase
  tasks: ChecklistTask[]
  hasPlan: boolean
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number
  finishedAt: number | null
  isCollapsed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: Checklist | null
      tick: number
    }
  }
}
