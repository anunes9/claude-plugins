import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const ROOT = '/proj'

const file = (name: string, size = 10): FsEntry => ({ name, kind: 'file', size, mtimeMs: 0, isLink: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

const TREE: Record<string, FsEntry[]> = {
  [ROOT]: [file('README.md'), dir('src'), dir('node_modules'), dir('.git')],
  [`${ROOT}/src`]: [file('index.ts', 42)],
}
const FILES: Record<string, string> = {
  [`${ROOT}/README.md`]: '# Hello\n',
  [`${ROOT}/src/index.ts`]: 'export const x = 1\n',
}

/** Stands in for the engine beneath the plugin: a small file system and a prompt box. */
const engine = (on: On) => {
  const filled: string[] = []
  const opened: string[] = []
  on('session.cwd', () => ({ value: ROOT }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('fs.list', (_$, e) => {
    const list = TREE[e.path]
    if (list === undefined) throw new Error(`ENOENT ${e.path}`)

    return { value: list }
  })
  on('fs.stat', (_$, e) => {
    if (e.path in TREE) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
    const text = FILES[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)

    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const text = FILES[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)

    return { value: text }
  })
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })

  return { filled, opened }
}

const runFiles = ($: Engine, args = '') =>
  $.command.run({
    command: 'files',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  } as Parameters<Engine['command']['run']>[0])

const mountExplorer = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({
    plugin: 'file-explorer',
    surface,
    component: 'Pane',
    requestId: 'file-explorer',
    props: { title: 'Files', isFocused: false } as never,
  })

test('lists the folder, hides ignored names, expands folders', async ($, on) => {
  const { opened } = engine(on)
  await runFiles($)
  expect(opened).toContain('file-explorer')

  for (const surface of SURFACES) {
    const ui = await mountExplorer($, surface)
    expect(await ui.find({ key: 'open:README.md' })).toBeDefined()
    expect(await ui.find({ key: 'open:src' })).toBeDefined()
    expect(await ui.find({ key: 'open:node_modules' })).toBeUndefined()
    expect(await ui.find({ key: 'open:.git' })).toBeUndefined()

    await ui.press({ key: 'open:src' })
    expect(await ui.find({ key: 'open:src/index.ts' })).toBeDefined()
    await ui.press({ key: 'open:src' })
    expect(await ui.find({ key: 'open:src/index.ts' })).toBeUndefined()
  }
})

test('a file opens in a viewer pane, and ⧉ puts its path in the prompt', async ($, on) => {
  const { filled, opened } = engine(on)
  await runFiles($)

  for (const surface of SURFACES) {
    const ui = await mountExplorer($, surface)
    await ui.press({ key: 'open:README.md' })
    expect(opened.at(-1)).toMatch(/^file-view-[0-9a-f]+$/)
    expect(await ui.find({ key: 'open:README.md' })).toBeDefined()

    await ui.press({ key: 'copy:README.md' })
    expect(filled.at(-1)).toBe('@README.md ')
  }
})

test('the viewer draws the file as code', async ($, on) => {
  const { opened } = engine(on)
  await runFiles($)
  const explorer = await mountExplorer($, 'terminal')
  await explorer.press({ key: 'open:src' })
  await explorer.press({ key: 'open:src/index.ts' })
  const id = opened.at(-1) ?? ''

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'file-explorer',
      surface,
      component: 'Pane',
      requestId: id,
      props: { title: 'index.ts', isFocused: false } as never,
    })
    expect(await ui.find({ type: 'Code', text: /export const x/ })).toBeDefined()
  }
})

test('refresh picks up a file added outside Claude', async ($, on) => {
  engine(on)
  await runFiles($)
  const ui = await mountExplorer($, 'terminal')
  expect(await ui.find({ key: 'open:NEW.md' })).toBeUndefined()

  TREE[ROOT] = [...(TREE[ROOT] ?? []), file('NEW.md')]
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'open:NEW.md' })).toBeDefined()
})
