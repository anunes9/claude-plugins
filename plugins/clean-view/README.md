# clean-view

A Claude Code mod that makes Claude Code calm and friendly for people who aren't technical.
While Claude works, tool calls, file diffs and command output are hidden, and one plain-English
checklist sits above the prompt:

```
Build my landing page · 1m 12s                     [ ● Clean View: ON ]
✓ Read your brand notes            ██████████  Done
▶ Build the pricing section        ██████░░░░  60%
○ Add the contact form             ░░░░░░░░░░  Next
○ Polish the footer                ░░░░░░░░░░  Up next
```

- The header shows the job's name and how long it has run, or **Needs you**, **⚠ Stuck**,
  **■ Stopped** or **✓ All done** (which shrinks to one line after 5 seconds).
- Claude lays out the plan with a `plan_steps` tool and reports progress with `report_progress`;
  its to-do list (TodoWrite, TaskCreate, TaskUpdate) fills the checklist too.
- While Clean View is on, Claude must make a plan before using other tools (subagents are not affected).
- The **Clean View** button, or `/simple on|off` (no argument flips it), turns it on and off.
  The choice is remembered across restarts. Turned off, every hidden row comes back.

Each new job's name comes from a small, low-effort Haiku request, which uses a little of your usage.

## Install

From a terminal Claude Code session:

```
/plugin install clean-view --marketplace anunes9/claude-plugins
```

Answer `y` to add the marketplace, then pick the scope (user scope loads it in every session).
To try it from a local checkout without installing: `claude --plugin-dir plugins/clean-view`.

## Develop

```
claude plugin validate .
claude plugin test .
```

`hooks/register.tsx` calls `registerCleanView(on)` from `hooks/clean-view.tsx`; more mods can be
registered beside it. Other mods can read the checklist from state under `clean-view`
(`cleanViewEnabled`, `checklist`, `tick`), typed in `types/index.d.ts`.
