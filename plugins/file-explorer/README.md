# file-explorer

A Claude Code mod that adds a **Files** pane: a tree of the working directory.

- Click a folder to expand or collapse it; **..** goes up a level, **↻ Refresh** re-reads open folders.
- Click a file to open it in its own pane (syntax highlighted, line numbers, Copy path, Close).
- **⧉** on a row inserts `@path ` into the prompt at the cursor.
- Files Claude writes are marked **● changed** for 5 minutes; the tree re-reads after Claude's
  edits, after Bash commands, and at the end of each turn.
- `.git`, `node_modules`, `dist`, `build`, `.next`, `.cache`, `__pycache__`, `.venv`, `coverage`
  and `.DS_Store` are hidden (edit `IGNORED` in `hooks/register.tsx`).
- `/files` reopens the pane; `/files <path>` roots it at another folder.

## Install

From a terminal Claude Code session:

```
/plugin install file-explorer --marketplace anunes9/claude-plugins
```

Answer `y` to add the marketplace, then pick the scope (user scope loads it in every session).
To try it from a local checkout without installing: `claude --plugin-dir plugins/file-explorer`.

## Develop

```
claude plugin validate .
claude plugin test .
```

Limits: shows at most 1,000 rows; the viewer shows the first 80,000 characters and skips binary
files and files over 4 MiB; paths are joined with `/`, so Windows is not supported.
