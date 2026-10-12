# claude-plugins

Claude Code plugins and mods, published as a plugin marketplace.

| Plugin | What it does |
| --- | --- |
| [file-explorer](plugins/file-explorer) | A **Files** pane: a tree of the working directory, a file viewer pane, and ⧉ buttons that put a file's path in the prompt |

## Install

From a terminal Claude Code session:

```
/plugin install file-explorer --marketplace anunes9/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

## Develop

```
claude plugin validate plugins/file-explorer
claude plugin test plugins/file-explorer
```
