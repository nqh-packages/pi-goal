# @qhn/pi-goal

Codex goal mode came out and the concept was good.

Ralph loops and autoresearch-style workflows are powerful, but sometimes I do not want a whole research loop. I just want to give pi one objective and have it keep going until the goal is done, blocked, paused, or clearly wasting turns.

So I ported the idea over. A small goal loop for pi.

## What it adds

| Feature | Behavior |
|---------|----------|
| `/goal` command | Start, inspect, pause, resume, or clear one active objective |
| `get_goal` tool | Lets the agent inspect the current objective, status, budget, and usage |
| `update_goal` tool | Lets the agent mark the active goal complete after proof |
| Hidden continuation | Schedules follow-up turns while pi is idle |
| User-input safety | Never continues over queued or pending user messages |
| No-work suppression | Pauses if an automatic turn ends without tool calls |
| Session-local state | Stores goal state in pi session entries, not a separate database |

## Install

```bash
pi install npm:@qhn/pi-goal
```

## Local development

From the package root:

```bash
pi install .
```

Temporary smoke test:

```bash
pi -e .
```

## Usage

```text
/goal ship the package
/goal status
/goal pause
/goal resume
/goal clear
```

A running goal gives the agent access to:

```text
get_goal
update_goal
```

`update_goal` is intentionally narrow. It only supports marking the active goal complete. Pause, resume, and clearing stay user-controlled through `/goal`.

## Verification

```bash
npm test
npm run verify:pi
npm run verify:package
npm run pack:dry-run
```

## Package layout

| Path | Purpose |
|------|---------|
| `package.json` | npm metadata and pi package manifest |
| `extensions/goal.ts` | pi extension entrypoint |
| `index.test.mjs` | regression tests for command, state, and continuation behavior |
| `AGENTS.md` | local ownership and verification law |

## Roadmap

Small and honest for now.

- Grill unclear goals before starting, so pi does not run with a vague objective.
- Better `/goal` subcommands with clearer display modes.
- More polished UI/status for active, paused, blocked, and complete goals.

## Publish

```bash
npm login
npm view @qhn/pi-goal
npm publish --access public
```

`npm view @qhn/pi-goal` should return `E404` immediately before publishing. If it returns package metadata, choose a new package name before publishing.
