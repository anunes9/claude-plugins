export type Entry = {
  name: string
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
  isLink: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'file-explorer': {
      /** The absolute folder the tree is rooted at. */
      root: string
      /** Expanded folders, relative to `root` ('' is the root itself). */
      expanded: string[]
      /** Each listed folder's entries, keyed like `expanded`. */
      entries: Record<string, Entry[]>
      /** Absolute paths Claude wrote recently, to when. */
      touched: Record<string, number>
      /** Open viewer panes: pane id to the absolute path it shows. */
      viewers: Record<string, string>
    }
  }
}
