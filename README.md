# @qhn/pi-goal

A setup-first autonomous goal mode for Pi.

This is a public Pi package: it includes the `pi-package` npm keyword and an explicit `pi` manifest in `package.json` so Pi can discover and load the extension from npm, git, or a local path.

Use it when you want Pi to pursue one objective across follow-up turns, but only after the goal contract is clear enough to audit.

## What it adds

| Feature | Behavior |
|---------|----------|
| `/goal <intent>` | Starts mandatory setup mode; never activates directly |
| Setup interview | Assistant resolves outcome, done criteria, decision philosophy, and ask-before boundaries |
| `goal_set` | Activates the latest confirmed setup with one rich objective string |
| `goal_get` | Lets the agent inspect setup/goal state, budget, usage, and remaining tokens |
| `goal_status_line` | Lets the agent update short current-progress text in the status line |
| `goal_complete` | Lets the agent mark the active goal complete after evidence audit |
| Hidden continuation | Schedules follow-up turns while Pi is idle |
| User-input safety | Never continues over queued or pending user messages |
| No-work suppression | Shows `BLOCKED! no progress — /goal resume` after a no-tool automatic turn |
| Session-local state | Stores setup and goal state in Pi session entries, not a separate database |

## Install

```bash
pi install npm:@qhn/pi-goal
```

## Local development

From this package directory:

```bash
pi install .
pi -e .
```

For Huy's local Pi runtime, keep `~/.pi/agent/settings.json` pointed at the local package path rather than switching development installs to npm.

## Usage

```text
/goal ship the package
/goal status
/goal pause
/goal resume
/goal cancel
/goal help
```

Flow:

```text
/goal <intent>
  -> hidden setup nudge
  -> assistant interviews in chat
  -> assistant summarizes contract
  -> user approves
  -> assistant calls goal_set
  -> autonomous continuation begins
```

Agent tools:

```text
goal_set
goal_get
goal_status_line
goal_complete
```

`goal_complete` is intentionally narrow. Pause, resume, and cancel stay user-controlled through `/goal`.

## Status line

| State | Example |
|-------|---------|
| Setup | `/goal ◇ setup: ship the package` |
| Working | `/goal ◇ ◴ verifying package` |
| Paused | `/goal ◇ Ⅱ paused: verifying package` |
| Waiting on user | `/goal ◇ ? answer needed: choose release target` |
| Blocked | `/goal ◇ BLOCKED! no progress — /goal resume` |
| Budget blocked | `/goal ◇ BLOCKED! budget limit reached` |
| Done | `/goal ◇ ✓ goal complete`, then clears after the completion turn |

Color is decoration only; glyphs and text carry the meaning. In terminals that support ANSI styling, `/goal` is bold and the working clock glyph is yellow.

## Verification

```bash
npm test
npm run test:ui
npm run verify:pi
npm run verify:package
npm run pack:dry-run
```

`npm run test:ui` writes visible terminal-render artifacts under `codex-scripts/goal-ui/`.

## Pi package manifest

`package.json` declares the Pi resources explicitly:

```json
{
  "keywords": ["pi-package", "pi-extension", "pi", "goal", "goal-mode", "autonomous-agent", "status-line", "agent"],
  "pi": {
    "extensions": ["./extensions/goal.ts"],
    "image": "https://raw.githubusercontent.com/nqh-packages/pi-goal/main/assets/pi-goal-status.png"
  }
}
```

The `image` field is package-gallery metadata for `pi.dev/packages`; the extension itself loads from `./extensions/goal.ts`.

## Package layout

| Path | Purpose |
|------|---------|
| `package.json` | npm metadata and Pi package manifest |
| `assets/pi-goal-status.png` | Pi package gallery preview image |
| `extensions/goal.ts` | Pi extension entrypoint |
| `extensions/goal/` | State, prompt, format, and debug helpers |
| `index.test.mjs` | Regression tests for command, setup, tools, state, continuation, and UI capture |
| `AGENTS.md` | Local ownership and verification law |

## Publish

This local `.pi` copy is not the release authority. Sync changes to `github.com/nqh-packages/pi-goal` and publish through the trusted-publishing GitHub Actions workflow.

Do not run `npm publish` from this directory.
