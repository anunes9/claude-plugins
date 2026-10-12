import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { cleanName } from './checklist'

const PLUGIN = 'clean-view'
const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const PROGRESS_TOOL = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const

const simple = (args: string) => ({
  command: 'simple',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

/** What sits beneath the plugin: a clock, a store, Haiku, and tools that just succeed. */
function stubEngine(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: 'Build my landing page',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('classic.Notification', () => ({}))

  return clock
}

test('names are cleaned into plain words', () => {
  expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  expect(cleanName('Update src/app/layout and the header')).toBe('Update and the header')
  expect(cleanName('fix Pricing.tsx styles')).toBe('Fix styles')
  const long = cleanName(
    'Make the whole marketing site look much friendlier for first time visitors on phones',
  )
  expect(long.length).toBeLessThanOrEqual(40)
  expect(long.endsWith('…')).toBe(true)
  expect(cleanName('`npm run build`')).toBe('Working on it')
})

test('a to-do list plus a 60% report draws done, current, next and up next rows', async ($, on) => {
  stubEngine(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  })
  await $.tool.call({ tool: PROGRESS_TOOL, task: 'Build the pricing section', percent: 60 } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ key: 'row-todo-0' }))?.text).toMatch(/^✓ Read your brand notes .*██████████ {2}Done$/)
    expect((await ui.find({ key: 'row-todo-1' }))?.text).toMatch(/^▶ Build the pricing section .*██████░░░░ {2}60%$/)
    expect((await ui.find({ key: 'row-todo-2' }))?.text).toMatch(/^○ Add the contact form .*░{10} {2}Next$/)
    expect((await ui.find({ key: 'row-todo-3' }))?.text).toMatch(/^○ Polish the footer .*░{10} {2}Up next$/)
    expect((await ui.find({ key: 'clean-view-toggle' }))?.text).toContain('Clean View: ON')
    await ui.unmount()
  }
})

test('a permission prompt shows Needs you', async ($, on) => {
  stubEngine(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Build the page', 'Check it works'] } as never)
  await $.classic.Notification({
    message: 'Claude needs your permission to use Bash',
    notification_type: 'permission_prompt',
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /needs your OK to continue/ })).toBeDefined()
    expect((await ui.find({ key: 'row-step-0' }))?.text).toMatch(/^‖ /)
    await ui.unmount()
  }
})

test('/simple off hides the band but keeps the button', async ($, on) => {
  stubEngine(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Build the page', 'Check it works'] } as never)
  await $.command.run(simple('off'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'row-step-0' })).toBeUndefined()
    expect((await ui.find({ key: 'clean-view-toggle' }))?.text).toContain('Clean View: OFF')
    await ui.press({ key: 'clean-view-toggle' })
    expect((await ui.find({ key: 'clean-view-toggle' }))?.text).toContain('Clean View: ON')
    expect(await ui.find({ key: 'row-step-0' })).toBeDefined()
    await $.command.run(simple('off'))
    await ui.unmount()
  }
})

test('plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
  stubEngine(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  const planned = await $.tool.call({
    tool: PLAN_TOOL,
    steps: ['Read your brand notes', 'Build the pricing section', 'Polish the footer'],
  } as never)
  expect(planned.result).toBe('Planned 3 steps. The first one has started.')
  const reported = await $.tool.call({ tool: PROGRESS_TOOL, task: 'Read your brand notes', percent: 140 } as never)
  expect(reported.result).toBe('Progress noted: 100%.')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'row-step-0' }))?.text).toMatch(/^✓ .* {2}Done$/)
  expect((await ui.find({ key: 'row-step-1' }))?.text).toMatch(/^▶ Build the pricing section .* {2}Working$/)
  expect((await ui.find({ key: 'row-step-2' }))?.text).toMatch(/Next$/)
})

test('tools are denied before a plan exists and allowed after', async ($, on) => {
  stubEngine(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  const before = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(before.deny ?? (before.isError ? before.text : undefined)).toMatch(/plan_steps first/)

  const search = await $.tool.call({ tool: 'ToolSearch', query: 'select:plan_steps', max_results: 1 } as never)
  expect(search.deny).toBeUndefined()

  await $.tool.call({ tool: PLAN_TOOL, steps: ['Look around', 'Answer the question'] } as never)
  const after = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(after.deny).toBeUndefined()
  expect(after.isError).toBeUndefined()
})

test('a finished job says All done and shrinks to one line after 5 seconds', async ($, on) => {
  const clock = stubEngine(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Build the page', 'Check it works'] } as never)
  await $.tool.call({ tool: PROGRESS_TOOL, task: 'Check it works', percent: 100 } as never)
  await clock.advance(134_000)
  await $.turn.complete({ answer: 'Done!', durationMs: 134_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /All done · .* · took 2m 14s/ })).toBeDefined()
  expect(await ui.find({ key: 'row-step-0' })).toBeDefined()
  await clock.advance(5_000)
  expect(await ui.find({ key: 'row-step-0' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /All done/ })).toBeDefined()
})

test('tool rows are hidden while Clean View is on', async ($, on) => {
  stubEngine(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: { tool_use_id: 'call-1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false },
    })
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { display: 'none' } })
    await ui.unmount()
  }
})
