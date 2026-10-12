import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Checklist, ChecklistTask } from '../types'
import {
  addTask,
  apiErrorReason,
  applyPlan,
  applyProgress,
  applyTodos,
  cleanName,
  fit,
  formatDuration,
  hasUnfinished,
  isUserRefusal,
  meter,
  newJob,
  sweep,
  titleFromPrompt,
  updateTask,
} from './checklist'

const PLUGIN = 'clean-view'
const STORE_KEY = 'cleanViewEnabled'
const PLAN_TOOL = `mcp__${PLUGIN}__plan_steps`
const PROGRESS_TOOL = `mcp__${PLUGIN}__report_progress`
const ALWAYS_ALLOWED = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', PLAN_TOOL])
const FRAME_MS = 250
const COLLAPSE_MS = 5000
const FAILURES_BEFORE_STUCK = 3

const NEEDS_OK = 'Claude needs your OK to continue'
const HAS_QUESTION = 'Claude has a question for you'
const WAITING = 'Claude is waiting for your reply'
const SAID_NO = 'you said no to a step, so Claude paused'
const KEEPS_FAILING = 'a step keeps failing, Claude is trying another way'
const REFUSED = "Claude couldn't help with that request"

const enabled = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklist = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const tick = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

const PROMPT_SECTION = `# Clean View: show the person a plain-English plan

The person is not technical. They see a checklist of your steps instead of your tool calls.

- For every request, even a quick question, call \`${PLAN_TOOL}\` first, with every step of the job in order (2 to 8 steps). If it is deferred, load it with ToolSearch first.
- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.
- Call \`${PROGRESS_TOOL}\` with the step's exact name and a percent as real progress happens, and with 100 the moment a step finishes.
- If you have TodoWrite or TaskCreate, you may use your to-do list as the plan instead; the same naming rules apply.`

type Engine = EngineInterface

// Module variables reset on a hot reload; everything drawn lives in $.state.
let ticker: { cancel: () => void } | undefined
let collapseTimer: { cancel: () => void } | undefined
let failuresInARow = 0
let lastApiError: { kind: string; details: string } | null = null


async function syncTimers($: Engine) {
  const list = await read($, checklist)
  const isAnimating = list !== null && (list.phase === 'working' || list.phase === 'needs-you')
  if (isAnimating && ticker === undefined) {
    ticker = $.clock.every(FRAME_MS, () => {
      void update($, tick, n => n + 1)
    })
  } else if (!isAnimating && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
  }
}

async function settle($: Engine, fn: (list: Checklist) => Checklist) {
  await update($, checklist, list => (list === null ? null : fn(list)))
  await syncTimers($)
}

async function startJob($: Engine, text: string) {
  const startedAt = await $.clock.now()
  const jobId = `job-${startedAt}-${Math.random().toString(36).slice(2, 8)}`
  collapseTimer?.cancel()
  collapseTimer = undefined
  failuresInARow = 0
  await update($, checklist, () => newJob(jobId, titleFromPrompt(text), startedAt))
  await syncTimers($)
  void nameJob($, jobId, text)

  return jobId
}

async function nameJob($: Engine, jobId: string, text: string) {
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 30,
      system:
        'Name the job in the request in 2 to 6 plain English words that start with a verb, like "Build my landing page". No code, file names or punctuation. Reply with the name alone.',
      prompt: text.slice(0, 2000),
    })
    if (!reply.isAnswered) {
      return
    }
    const words = reply.text.replace(/["'.]/g, '').trim().split(/\s+/).slice(0, 6).join(' ')
    const title = cleanName(words)
    await update($, checklist, list => (list === null || list.jobId !== jobId ? list : { ...list, title }))
  } catch {
    // The header keeps the name taken from the prompt.
  }
}

function needsYou(reason: string) {
  return (list: Checklist): Checklist =>
    list.finishedAt !== null ? list : { ...list, phase: 'needs-you', needsYouReason: reason }
}

const backToWork = (list: Checklist): Checklist =>
  list.phase === 'needs-you' ? { ...list, phase: 'working', needsYouReason: null } : list

const stuck = (reason: string) => (list: Checklist): Checklist => ({ ...list, phase: 'stuck', stuckReason: reason })

async function setEnabled($: Engine, isOn: boolean) {
  await update($, enabled, () => isOn)
  await $.store.set(STORE_KEY, isOn)
  $.ui.toast(isOn ? 'Clean View is on: tool details are hidden' : 'Clean View is off: showing everything')
}

export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get(STORE_KEY)
    if (typeof saved === 'boolean') {
      await update($, enabled, () => saved)
    }
    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lay out every step of the job up front, before any other tool: 2 to 8 short plain-English step names in order, each under 40 characters, starting with a verb, with no file names, paths, commands or code. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        'Report progress on the current step of the plan, by its exact name, with a percent from 0 to 100. Report 100 the moment a step finishes; the next step then starts by itself.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          percent: { type: 'number', minimum: 0, maximum: 100 },
        },
        required: ['task', 'percent'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'simple',
      description: 'Turn Clean View on or off (on | off; no argument flips it)',
      argumentHint: 'on|off',
    })
    await syncTimers($)

    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: 'Use /simple on, /simple off, or /simple to flip it.' }
    }
    const isOn = arg === '' ? !(await read($, enabled)) : arg === 'on'
    await setEnabled($, isOn)

    return { text: isOn ? 'Clean View is on.' : 'Clean View is off.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, enabled))) {
      return composed
    }

    return {
      sections: [
        ...composed.sections.filter(one => one.id !== 'clean-view:plan'),
        { id: 'clean-view:plan', text: PROMPT_SECTION, scope: 'session' as const },
      ],
    }
  })

  on('turn.start', async ($, e, next) => {
    lastApiError = null
    const text = e.text.trim()
    if (text !== '' && !text.startsWith('/')) {
      const list = await read($, checklist)
      if (list === null || list.finishedAt !== null) {
        await startJob($, text)
      } else {
        await settle($, list => ({ ...backToWork(list), isCollapsed: false }))
      }
    }

    return next(e)
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const input = e as unknown as { steps?: unknown }
    const steps = Array.isArray(input.steps) ? input.steps.filter((s): s is string => typeof s === 'string') : []
    if (steps.length === 0) {
      return { deny: 'plan_steps needs a list of 2 to 8 short step names.' }
    }
    if ((await read($, checklist)) === null) {
      await startJob($, steps[0] ?? '')
    }
    await settle($, list => applyPlan(backToWork(list), steps))
    const count = Math.min(steps.length, 8)

    return { result: `Planned ${count} steps. The first one has started.` }
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const input = e as unknown as { task?: unknown; percent?: unknown }
    const name = typeof input.task === 'string' ? input.task : ''
    const raw = typeof input.percent === 'number' ? input.percent : Number(input.percent)
    const percent = Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.round(raw))) : 0
    await settle($, list => applyProgress(backToWork(list), name, percent))

    return { result: `Progress noted: ${percent}%.` }
  })

  // The main agent's tools: plan first while Clean View is on, then fill the
  // checklist from what Claude already does and notice trouble.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || e.tool === PLAN_TOOL || e.tool === PROGRESS_TOOL) {
      return next(e)
    }
    if (!ALWAYS_ALLOWED.has(e.tool) && (await read($, enabled))) {
      const list = await read($, checklist)
      if (list === null || !list.hasPlan) {
        return {
          deny: `Clean View: call ${PLAN_TOOL} first to lay out the plan in plain English (load it with ToolSearch if it is deferred), then try again.`,
        }
      }
    }
    const isQuestion = e.tool === 'AskUserQuestion'
    await settle($, isQuestion ? needsYou(HAS_QUESTION) : backToWork)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      const text = ran.deny ?? ran.text ?? ''
      failuresInARow += 1
      if (isUserRefusal(text)) {
        await settle($, stuck(SAID_NO))
      } else if (failuresInARow >= FAILURES_BEFORE_STUCK) {
        await settle($, stuck(KEEPS_FAILING))
      } else if (isQuestion) {
        await settle($, backToWork)
      }

      return ran
    }
    failuresInARow = 0
    await settle($, list => {
      let updated = list.phase === 'stuck' ? { ...list, phase: 'working' as const, stuckReason: null } : backToWork(list)
      if (e.tool === 'TodoWrite') {
        updated = applyTodos(updated, e.todos)
      } else if (e.tool === 'TaskCreate') {
        const made = ran.result as { task?: { id?: string } } | undefined
        if (made?.task?.id !== undefined) {
          updated = addTask(updated, made.task.id, e.subject)
        }
      } else if (e.tool === 'TaskUpdate') {
        updated = updateTask(updated, e)
      }

      return updated
    })

    return ran
  }).catch(($, e, next) =>
    // The plan-first rule is a nudge, not a safety guard: if this hook fails, let the tool run.
    next(e),
  )

  on('classic.Notification', async ($, e, next) => {
    const kind = `${e.notification_type} ${e.message}`.toLowerCase()
    if (/permission|approv/.test(kind)) {
      await settle($, needsYou(NEEDS_OK))
    } else if (/elicitation|question/.test(kind)) {
      await settle($, needsYou(HAS_QUESTION))
    }

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    lastApiError = { kind: e.error, details: e.error_details ?? '' }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    const list = await read($, checklist)
    if (list !== null && list.finishedAt === null) {
      const now = await $.clock.now()
      const finish = (one: Checklist): Checklist => ({ ...one, finishedAt: now, needsYouReason: null })
      if (e.reason === 'error') {
        const reason = apiErrorReason(lastApiError?.kind ?? null, lastApiError?.details ?? e.answer)
        await settle($, one => finish(stuck(reason)(one)))
      } else if (e.reason === 'refusal') {
        await settle($, one => finish(stuck(REFUSED)(one)))
      } else if (e.reason === 'aborted' || e.isAborted) {
        if (list.phase !== 'stuck' || list.stuckReason !== SAID_NO) {
          await settle($, one => ({ ...finish(one), phase: 'stopped' }))
        }
      } else if (list.hasPlan && hasUnfinished(list)) {
        await settle($, needsYou(WAITING))
      } else {
        const jobId = list.jobId
        await settle($, one => ({
          ...finish(one),
          phase: 'done',
          stuckReason: null,
          tasks: one.hasPlan ? one.tasks : [],
        }))
        collapseTimer?.cancel()
        collapseTimer = $.clock.after(COLLAPSE_MS, () => {
          void update($, checklist, one =>
            one !== null && one.jobId === jobId && one.phase === 'done' ? { ...one, isCollapsed: true } : one,
          )
        })
      }
    }
    lastApiError = null

    return next(e)
  })

  // Hide the technical rows while Clean View is on.
  on('ui.render', { component: ['ToolUse', 'ToolResult', 'ToolGroup'] }, async ($, e, next) => {
    if (!(await read($, enabled))) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) =>
    (await read($, enabled)) ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const isOn = await read($, enabled)
    const list = isOn ? await read($, checklist) : null
    const frame = await read($, tick)
    const columns = Math.max(20, e.props.bodyColumns)

    const toggle = (
      <Button
        key="clean-view-toggle"
        label={isOn ? '● Clean View: ON' : '○ Clean View: OFF'}
        variant={isOn ? 'primary' : 'secondary'}
        onPress={() => setEnabled($, !isOn)}
      />
    )
    const headerRow = (left: unknown) => (
      <Box key="header" flexDirection="row" justifyContent="space-between" width={columns}>
        <Box flexShrink={1}>{left as never}</Box>
        {toggle}
      </Box>
    )
    if (list === null) {
      return <Box flexDirection="column">{headerRow(<Text> </Text>)}</Box>
    }

    const now = await $.clock.now()
    const took = formatDuration((list.finishedAt ?? now) - list.startedAt)
    const header = (() => {
      switch (list.phase) {
        case 'needs-you':
          return (
            <Text wrap="truncate-end">
              <Text backgroundColor="warning" color="inverseText" bold>
                {' Needs you '}
              </Text>
              {` ${list.needsYouReason ?? NEEDS_OK}`}
            </Text>
          )
        case 'stuck':
          return (
            <Text wrap="truncate-end" color="warning">
              {`⚠ Stuck: ${list.stuckReason ?? KEEPS_FAILING}`}
            </Text>
          )
        case 'stopped':
          return <Text wrap="truncate-end">{`■ Stopped · ${list.title} · you pressed Esc`}</Text>
        case 'done':
          return (
            <Text wrap="truncate-end">
              <Text color="success">✓ All done</Text>
              {` · ${list.title} · took ${took}`}
            </Text>
          )
        default:
          return (
            <Text wrap="truncate-end">
              <Text bold>{list.title}</Text>
              <Text dimColor>{` · ${took}`}</Text>
            </Text>
          )
      }
    })()

    if (list.phase === 'done' && (list.isCollapsed || list.tasks.length === 0)) {
      return <Box flexDirection="column">{headerRow(header)}</Box>
    }

    // glyph + space, meter, two spaces, a 7-cell label: the name gets the rest.
    const nameWidth = Math.max(6, Math.min(40, columns - 2 - 1 - 10 - 2 - 7))
    let isFirstUpcoming = true
    const rows = list.tasks.map((one: ChecklistTask) => {
      const name = fit(one.name, nameWidth)
      if (one.status === 'done') {
        return (
          <Box key={`row-${one.id}`}>
            <Text wrap="truncate-end">
              <Text color="success">✓</Text>
              <Text dimColor>{` ${name} `}</Text>
              <Text color="success">{meter(100)}</Text>
              <Text dimColor>{'  Done'}</Text>
            </Text>
          </Box>
        )
      }
      if (one.status === 'active') {
        const isPaused = list.phase === 'needs-you'
        const hasPercent = one.hasReported
        return (
          <Box key={`row-${one.id}`}>
            <Text wrap="truncate-end">
              <Text color="claude">{isPaused ? '‖' : '▶'}</Text>
              <Text bold>{` ${name} `}</Text>
              <Text color="claude">{hasPercent ? meter(one.percent) : sweep(frame)}</Text>
              <Text>{hasPercent ? `  ${one.percent}%` : '  Working'}</Text>
            </Text>
          </Box>
        )
      }
      const label = isFirstUpcoming ? 'Next' : 'Up next'
      isFirstUpcoming = false
      return (
        <Box key={`row-${one.id}`}>
          <Text wrap="truncate-end" dimColor>
            {`○ ${name} ${meter(0)}  ${label}`}
          </Text>
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        {headerRow(header)}
        {rows}
      </Box>
    )
  })
}
