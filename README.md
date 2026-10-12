# claude-plugins

Claude Code plugins and mods, published as a plugin marketplace.

| Plugin | What it does |
| --- | --- |
| [file-explorer](plugins/file-explorer) | A **Files** pane: a tree of the working directory, a file viewer pane, and ⧉ buttons that put a file's path in the prompt |
| [clean-view](plugins/clean-view) | Hides tool calls and output, and shows one plain-English checklist of the plan above the prompt |

## Install

From a terminal Claude Code session:

```
/plugin install file-explorer --marketplace anunes9/claude-plugins
```

```
/plugin install clean-view --marketplace anunes9/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

## Develop

```
claude plugin validate plugins/file-explorer
claude plugin test plugins/file-explorer
claude plugin validate plugins/clean-view
claude plugin test plugins/clean-view
```
