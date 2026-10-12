import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry } from '../types'

const PANE = 'file-explorer'
const VIEWER = 'file-view-'

const IGNORED = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  '__pycache__',
  '.venv',
  'coverage',
  '.DS_Store',
])

/** Rows drawn at most, to stay inside a tree's node bounds. */
const MAX_ROWS = 1000
/** Characters of a file the viewer draws at most. */
const MAX_VIEW_CHARS = 80_000
/** How long a file Claude wrote keeps its marker. */
const TOUCHED_MS = 5 * 60_000
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const root = atom({ plugin: 'file-explorer', key: 'root' } as const, '')
const expanded = atom({ plugin: 'file-explorer', key: 'expanded' } as const, [''])
const entries = atom({ plugin: 'file-explorer', key: 'entries' } as const, {})
const touched = atom({ plugin: 'file-explorer', key: 'touched' } as const, {})
const viewers = atom({ plugin: 'file-explorer', key: 'viewers' } as const, {})

const join = (base: string, rel: string) =>
  rel === '' ? base : `${base.replace(/\/$/, '')}/${rel}`

const childOf = (rel: string, name: string) => (rel === '' ? name : `${rel}/${name}`)

const parentOf = (path: string) => {
  const cut = path.replace(/\/$/, '').lastIndexOf('/')

  return cut <= 0 ? '/' : path.slice(0, cut)
}

const sortEntries = (list: Entry[]) =>
  [...list].sort((a, b) =>
    (a.kind === 'dir') !== (b.kind === 'dir')
      ? a.kind === 'dir'
        ? -1
        : 1
      : a.name.localeCompare(b.name),
  )

const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const formatAge = (mtimeMs: number) => {
  const s = Math.max(0, (Date.now() - mtimeMs) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`

  return `${Math.floor(s / 86400)}d`
}

/** Lists one folder: ignored names dropped, links resolved to what they lead to. */
const listDir = async ($: EngineInterface, abs: string): Promise<Entry[]> => {
  const raw = await $.fs.list(abs)
  const kept = raw.filter(one => !IGNORED.has(one.name))
  const resolved = await Promise.all(
    kept.map(async (one): Promise<Entry> => {
      if (!one.isLink) {
        return { name: one.name, kind: one.kind, size: one.size, mtimeMs: one.mtimeMs, isLink: false }
      }
      const target = await $.fs.stat(`${abs}/${one.name}`).catch(() => undefined)

      return {
        name: one.name,
        kind: target?.kind ?? 'other',
        size: target?.size ?? 0,
        mtimeMs: target?.mtimeMs ?? 0,
        isLink: true,
      }
    }),
  )

  return sortEntries(resolved)
}

/** Re-reads the given folders (relative to the root); one that fails is collapsed. */
const reload = async ($: EngineInterface, dirs: string[]) => {
  const base = await read($, root)
  const results = await Promise.all(
    dirs.map(async rel => ({
      rel,
      list: await listDir($, join(base, rel)).catch(() => undefined),
    })),
  )
  const failed = new Set(results.filter(r => r.list === undefined).map(r => r.rel))

  await update($, entries, all => {
    const next = { ...all }
    for (const { rel, list } of results) {
      if (list === undefined) delete next[rel]
      else next[rel] = list
    }

    return next
  })
  if (failed.size > 0) {
    await update($, expanded, list => list.filter(rel => rel === '' || !failed.has(rel)))
  }
}

const reloadExpanded = async ($: EngineInterface) => reload($, await read($, expanded))

const setRoot = async ($: EngineInterface, path: string) => {
  await update($, root, () => path)
  await update($, expanded, () => [''])
  await update($, entries, () => ({}))
  await reload($, [''])
}

const toggle = async ($: EngineInterface, rel: string) => {
  const isOpen = (await read($, expanded)).includes(rel)
  if (isOpen) {
    await update($, expanded, list => list.filter(one => one !== rel && !one.startsWith(`${rel}/`)))

    return
  }
  await update($, expanded, list => [...list, rel])
  await reload($, [rel])
}

/** The path as the prompt should carry it: relative to the session's folder when inside it. */
const promptPath = async ($: EngineInterface, abs: string) => {
  const cwd = (await $.session.cwd()).replace(/\/$/, '')

  return abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : abs
}

const copyToPrompt = async ($: EngineInterface, abs: string) => {
  const path = await promptPath($, abs)
  await $.prompt.fill({ text: `@${path} `, mode: 'insert' })
  $.ui.toast(`Added @${path} to the prompt`)
}

/** A pane id for a path: ids are short and plain, so the path is hashed (FNV-1a) and kept in state. */
const viewerId = (abs: string) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < abs.length; i++) {
    hash ^= abs.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return `${VIEWER}${hash.toString(16)}`
}

const openViewer = async ($: EngineInterface, abs: string) => {
  const id = viewerId(abs)
  await update($, viewers, all => ({ ...all, [id]: abs }))

  return $.ui.open({ id, title: abs.slice(abs.lastIndexOf('/') + 1) })
}

const openExplorer = async ($: EngineInterface) => {
  if ((await read($, root)) === '') await setRoot($, await $.session.cwd())
  else await reloadExpanded($)

  return $.ui.open({ id: PANE, title: 'Files' })
}

type Row = { rel: string; entry: Entry; depth: number }

/** The tree flattened into rows, depth first, open folders' children under them. */
const flatten = (
  all: Record<string, Entry[]>,
  open: Set<string>,
  rel: string,
  depth: number,
  rows: Row[],
) => {
  for (const entry of all[rel] ?? []) {
    if (rows.length >= MAX_ROWS) return
    const child = childOf(rel, entry.name)
    rows.push({ rel: child, entry, depth })
    if (entry.kind === 'dir' && open.has(child)) flatten(all, open, child, depth + 1, rows)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'files',
      description: 'Open the file explorer; /files <path> roots it at another folder',
    })
    void openExplorer($)

    return next(e)
  })

  on('command.run', { command: 'files' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg !== '') {
      const cwd = await $.session.cwd()
      const target = arg.startsWith('/') ? arg : join(cwd, arg)
      const stat = await $.fs.stat(target, { resolve: true }).catch(() => undefined)
      if (stat?.kind !== 'dir' || stat.realPath === undefined) {
        return { text: `Not a folder: ${arg}` }
      }
      await setRoot($, stat.realPath)
    }
    await openExplorer($)

    return { text: `File explorer opened at ${await read($, root)}.` }
  })

  // Claude's own writes: re-read the written file's folder and mark the file.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    const args = e as unknown as { file_path?: unknown; notebook_path?: unknown }

    if (WRITE_TOOLS.has(tool)) {
      const path = typeof args.file_path === 'string' ? args.file_path : args.notebook_path
      if (typeof path === 'string') {
        const cwd = await $.session.cwd()
        const abs = path.startsWith('/') ? path : join(cwd, path)
        const now = Date.now()
        await update($, touched, all => {
          const fresh = Object.fromEntries(
            Object.entries(all).filter(([, at]) => now - at < TOUCHED_MS),
          )

          return { ...fresh, [abs]: now }
        })
        const base = await read($, root)
        const folder = parentOf(abs)
        if (folder === base || folder.startsWith(`${base}/`)) {
          const rel = folder === base ? '' : folder.slice(base.length + 1)
          if ((await read($, expanded)).includes(rel)) await reload($, [rel])
        }
      }
    } else if (tool === 'Bash') {
      await reloadExpanded($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Anything missed during the turn.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if ((await read($, root)) !== '') await reloadExpanded($)

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const base = await read($, root)
    const open = new Set(await read($, expanded))
    const all = await read($, entries)
    const marks = await read($, touched)
    const rows: Row[] = []
    flatten(all, open, '', 0, rows)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Box flexShrink={1}>
            <Text bold wrap="truncate-start">
              {base}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Button key="up" label=".." variant="secondary" onPress={() => setRoot($, parentOf(base))} />
            <Button key="refresh" label="↻ Refresh" variant="primary" onPress={() => reloadExpanded($)} />
          </Box>
        </Box>
        {rows.length === 0 && <Text dimColor>Empty folder.</Text>}
        {rows.map(({ rel, entry, depth }) => {
          const abs = join(base, rel)
          const indent = '  '.repeat(depth)
          const isDir = entry.kind === 'dir'
          const at = marks[abs]
          const isChanged = at !== undefined && Date.now() - at < TOUCHED_MS

          return (
            <Box key={`row:${rel}`} flexDirection="row" justifyContent="space-between">
              <Box flexDirection="row" flexShrink={1}>
                <Text>{indent}</Text>
                <Button
                  key={`open:${rel}`}
                  plain
                  onPress={() => (isDir ? toggle($, rel) : openViewer($, abs))}
                >
                  {isDir ? `${open.has(rel) ? '▾' : '▸'} ${entry.name}/` : `  ${entry.name}`}
                  {entry.isLink ? ' →' : ''}
                </Button>
              </Box>
              <Box flexDirection="row" gap={2} flexShrink={0}>
                {isChanged && <Text color="yellow">● changed</Text>}
                {!isDir && <Text dimColor>{formatSize(entry.size)}</Text>}
                {!isDir && entry.mtimeMs > 0 && <Text dimColor>{formatAge(entry.mtimeMs)}</Text>}
                <Button
                  key={`copy:${rel}`}
                  label="⧉"
                  plain
                  dimColor
                  hover={{ dimColor: false, bold: true }}
                  onPress={() => copyToPrompt($, abs)}
                />
              </Box>
            </Box>
          )
        })}
        {rows.length >= MAX_ROWS && <Text dimColor>… more rows not shown; collapse a folder.</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: /^file-view-/ }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const abs = (await read($, viewers))[e.requestId]
    if (abs === undefined) {
      return <Text dimColor>Open a file from the Files pane.</Text>
    }
    // Subscribes the viewer to Claude's writes, so an edited file redraws.
    await read($, touched)

    const header = (
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Box flexShrink={1}>
          <Text bold wrap="truncate-start">
            {abs}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Button key="copy" label="Copy path" onPress={() => copyToPrompt($, abs)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: e.requestId })} />
        </Box>
      </Box>
    )

    const notice = (text: string) => (
      <Box flexDirection="column">
        {header}
        <Text dimColor>{text}</Text>
      </Box>
    )

    const stat = await $.fs.stat(abs).catch(() => undefined)
    if (stat === undefined) return notice('This file no longer exists.')
    if (stat.kind !== 'file') return notice('Not a regular file.')
    if (stat.size > 4 * 1024 * 1024) return notice(`Too large to show (${formatSize(stat.size)}).`)

    const text = await $.fs.read(abs).catch(() => undefined)
    if (typeof text !== 'string') return notice('Could not read this file.')
    if (text.includes('\u0000')) return notice(`Binary file (${formatSize(stat.size)}).`)

    const isCut = text.length > MAX_VIEW_CHARS
    const source = (isCut ? text.slice(0, MAX_VIEW_CHARS) : text)
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

    return (
      <Box flexDirection="column">
        {header}
        {source === '' ? <Text dimColor>Empty file.</Text> : <Code source={source} path={abs} startLine={1} />}
        {isCut && <Text dimColor>… cut at {MAX_VIEW_CHARS.toLocaleString()} characters.</Text>}
      </Box>
    )
  })
}
