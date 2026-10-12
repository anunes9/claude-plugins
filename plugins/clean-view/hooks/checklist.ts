import type { Checklist, ChecklistTask } from '../types'

export const MAX_NAME = 40
export const FALLBACK_NAME = 'Working on it'
export const PLACEHOLDERS = ['Understand your request', 'Plan the steps']

const CODE_FILE =
  /\.(tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|zsh|bash|json|ya?ml|toml|css|scss|html|md|sql|lock|env|vue|svelte)\b/i

/** Turns any name into plain words: no code, paths or file names; at most 40 characters. */
export function cleanName(raw: string): string {
  const words = raw
    .replace(/`[^`]*`/g, ' ')
    .replace(/`/g, ' ')
    .split(/\s+/)
    .filter(word => word !== '' && !word.includes('/') && !CODE_FILE.test(word))
  let name = words.join(' ').trim()
  if (name.length > MAX_NAME) {
    const cut = name.slice(0, MAX_NAME - 1)
    const space = cut.lastIndexOf(' ')
    name = `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`
  }
  if (name === '' || name === '…') {
    return FALLBACK_NAME
  }

  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** A short header name from the prompt itself, used until Haiku answers. */
export function titleFromPrompt(text: string): string {
  return cleanName(text.split(/\s+/).slice(0, 6).join(' '))
}

export function clampPercent(percent: number): number {
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0
}

function task(id: string, name: string, status: ChecklistTask['status']): ChecklistTask {
  return { id, name, status, percent: status === 'done' ? 100 : 0, hasReported: false }
}

export function newJob(jobId: string, title: string, startedAt: number): Checklist {
  return {
    jobId,
    title,
    phase: 'working',
    tasks: PLACEHOLDERS.map((name, i) => task(`placeholder-${i}`, name, i === 0 ? 'active' : 'upcoming')),
    hasPlan: false,
    needsYouReason: null,
    stuckReason: null,
    startedAt,
    finishedAt: null,
    isCollapsed: false,
  }
}

export function applyPlan(list: Checklist, steps: readonly string[]): Checklist {
  const tasks = steps
    .slice(0, 8)
    .map((step, i) => task(`step-${i}`, cleanName(step), i === 0 ? 'active' : 'upcoming'))

  return { ...list, tasks, hasPlan: true }
}

function activate(tasks: ChecklistTask[], index: number): ChecklistTask[] {
  return tasks.map((one, i): ChecklistTask => (i === index ? { ...one, status: 'active' } : one))
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Checks off everything before the reported step, and moves on when it reaches 100. */
export function applyProgress(list: Checklist, name: string, rawPercent: number): Checklist {
  const percent = clampPercent(rawPercent)
  const clean = cleanName(name)
  let tasks = [...list.tasks]
  let index = tasks.findIndex(one => same(one.name, clean))
  if (index === -1) {
    const firstOpen = tasks.findIndex(one => one.status !== 'done')
    index = firstOpen === -1 ? tasks.length : firstOpen
    tasks.splice(index, 0, task(`extra-${tasks.length}-${clean}`, clean, 'active'))
  }
  const isFinished = percent >= 100
  tasks = tasks.map((one, i) => {
    if (i < index) {
      return { ...one, status: 'done', percent: 100 }
    }
    if (i === index) {
      return isFinished
        ? { ...one, status: 'done', percent: 100, hasReported: true }
        : { ...one, status: 'active', percent, hasReported: true }
    }

    return one.status === 'active' ? { ...one, status: 'upcoming' } : one
  })
  if (isFinished) {
    tasks = activate(tasks, tasks.findIndex((one, i) => i > index && one.status === 'upcoming'))
  }

  return { ...list, tasks }
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export function applyTodos(list: Checklist, todos: readonly Todo[]): Checklist {
  if (todos.length === 0) {
    return list
  }
  const tasks = todos.map((todo, i): ChecklistTask => {
    const name = cleanName(todo.content)
    const before = list.tasks.find(one => same(one.name, name))
    if (todo.status === 'completed') {
      return { id: `todo-${i}`, name, status: 'done', percent: 100, hasReported: true }
    }
    if (todo.status === 'in_progress') {
      return {
        id: `todo-${i}`,
        name,
        status: 'active',
        percent: before?.hasReported ? before.percent : 0,
        hasReported: before?.hasReported ?? false,
      }
    }

    return task(`todo-${i}`, name, 'upcoming')
  })

  return { ...list, tasks, hasPlan: true }
}

export function addTask(list: Checklist, id: string, subject: string): Checklist {
  const kept = list.hasPlan ? list.tasks : []
  let tasks = [...kept, task(`task-${id}`, cleanName(subject), 'upcoming')]
  if (!tasks.some(one => one.status === 'active')) {
    tasks = activate(tasks, tasks.findIndex(one => one.status === 'upcoming'))
  }

  return { ...list, tasks, hasPlan: true }
}

type TaskChange = {
  taskId: string
  subject?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'deleted'
}

export function updateTask(list: Checklist, change: TaskChange): Checklist {
  const id = `task-${change.taskId}`
  if (change.status === 'deleted') {
    return { ...list, tasks: list.tasks.filter(one => one.id !== id) }
  }
  let tasks = list.tasks.map((one): ChecklistTask => {
    if (one.id !== id) {
      return change.status === 'in_progress' && one.status === 'active' ? { ...one, status: 'upcoming' } : one
    }
    const name = change.subject === undefined ? one.name : cleanName(change.subject)
    if (change.status === 'completed') {
      return { ...one, name, status: 'done', percent: 100 }
    }
    if (change.status === 'in_progress') {
      return { ...one, name, status: 'active' }
    }
    if (change.status === 'pending') {
      return { ...one, name, status: 'upcoming' }
    }

    return { ...one, name }
  })
  if (change.status === 'completed' && !tasks.some(one => one.status === 'active')) {
    tasks = activate(tasks, tasks.findIndex(one => one.status === 'upcoming'))
  }

  return { ...list, tasks }
}

export function hasUnfinished(list: Checklist): boolean {
  return list.tasks.some(one => one.status !== 'done')
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const METER_CELLS = 10

export function meter(percent: number): string {
  const filled = Math.round(clampPercent(percent) / 10)

  return '█'.repeat(filled) + '░'.repeat(METER_CELLS - filled)
}

/** A three-cell block bouncing across the meter, for a step with no percent yet. */
export function sweep(frame: number): string {
  const span = METER_CELLS - 3
  const step = frame % (span * 2)
  const at = step <= span ? step : span * 2 - step

  return '░'.repeat(at) + '▓▓▓' + '░'.repeat(METER_CELLS - 3 - at)
}

/** Fits a name into its column, cut with an ellipsis, padded so the meters line up. */
export function fit(name: string, width: number): string {
  const fitted = name.length > width ? `${name.slice(0, Math.max(1, width - 1)).trimEnd()}…` : name

  return fitted.padEnd(width)
}

type ApiErrorKind = string | null

/** One calm sentence for an API error that ended the turn. */
export function apiErrorReason(kind: ApiErrorKind, details: string): string {
  const text = `${kind ?? ''} ${details}`.toLowerCase()
  if (/rate_limit|rate limit|usage limit|429/.test(text)) {
    return 'you hit your usage limit, try again a little later'
  }
  if (/overloaded|server_error|529|503|500/.test(text)) {
    return "Claude's servers are busy, try again in a minute"
  }
  if (/too long|context|max_tokens|prompt_too_long/.test(text)) {
    return 'the conversation got too long, type /compact and try again'
  }
  if (/authentication|oauth|login|401|403|credential|account_on_hold/.test(text)) {
    return "you're signed out, type /login"
  }
  if (/network|connect|econn|fetch failed|timed? ?out|socket|offline|dns/.test(text)) {
    return 'the internet connection dropped'
  }

  return 'something went wrong, try again in a moment'
}

export function isUserRefusal(text: string): boolean {
  return /user (doesn't|does not) want|user (rejected|denied|declined)|permission (was )?denied|rejected by the user/i.test(
    text,
  )
}
