# @qhn/pi-goal

Setup-first autonomous goal mode for Pi.

`@qhn/pi-goal` lets Pi pursue one objective across follow-up turns. It does **not** start autonomous work immediately: `/goal <intent>` first opens a setup interview so the assistant and user agree on outcome, done criteria, decision style, and ask-before boundaries.

## Install

```bash
pi install npm:@qhn/pi-goal
```

Try without installing:

```bash
pi -e npm:@qhn/pi-goal
```

## Commands

| Command | Behavior |
|---------|----------|
| `/goal <intent>` | Start setup mode for a new goal |
| `/goal status` | Show current setup or goal state |
| `/goal pause` | Pause autonomous continuation |
| `/goal resume` | Resume a paused or blocked goal |
| `/goal cancel` | Cancel setup or active goal state |
| `/goal help` | Show command help |

## Agent tools

| Tool | Purpose |
|------|---------|
| `goal_present` | Record the contract (Outcome, Done criteria, Decision philosophy, Ask-before boundaries) when presenting it to the user; call this right when you show the contract |
| `goal_set` | Activate the latest confirmed setup — checks that `goal_present` was called with a matching objective |
| `goal_get` | Inspect setup/goal state, budget, usage, and remaining tokens |
| `goal_status_line` | Update short current-progress text in the status line |
| `goal_complete` | Mark the active goal complete after evidence proves it is done |

`goal_complete` is intentionally narrow. Pause, resume, and cancel stay user-controlled through `/goal` commands.

## Goal flow

```text
/goal <intent>
  -> Pi asks setup questions
  -> assistant summarizes the goal contract
  -> assistant calls goal_present to record the contract
  -> user approves the contract
  -> assistant calls goal_set (checks goal_present was called + objective match)
  -> Pi continues while idle
  -> assistant updates progress with goal_status_line
  -> assistant calls goal_complete only after proof
```

## Setup contract

Before activation, the assistant must resolve:

| Contract part | Meaning |
|---------------|---------|
| Outcome | What should be true when the goal finishes |
| Done criteria | Evidence required before completion |
| Decision philosophy | How trade-offs should be made during autonomous work |
| Ask-before boundaries | Actions that require explicit user approval |

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

## Safety rules

| Rule | Behavior |
|------|----------|
| Setup first | `/goal <intent>` never activates directly |
| Explicit approval | `goal_set` requires `confirmed=true`, a matching objective, and a prior `goal_present` call that recorded the contract |
| User input wins | Pi does not continue over queued or pending user messages |
| No-work stop | A no-tool autonomous turn blocks with `/goal resume` guidance |
| Evidence before done | `goal_complete` should be called only after the done criteria are proven |
| Session-local state | Goal state is stored in Pi session entries, not a separate database |

## Pi package manifest

`package.json` declares the Pi package resources explicitly:

```json
{
  "keywords": ["pi-package", "pi-extension", "pi", "goal", "goal-mode", "autonomous-agent", "status-line", "agent"],
  "pi": {
    "extensions": ["./extensions/goal.ts"],
    "image": "https://unpkg.com/@qhn/pi-goal@0.3.0/assets/pi-goal-status.png"
  }
}
```

## Development

```bash
npm install
npm test
npm run test:ui
npm run verify:pi
npm run verify:package
npm run pack:dry-run
```

`npm run test:ui` writes terminal-render artifacts under `codex-scripts/goal-ui/`; those artifacts are local test output and are not part of the npm package.

## Package contents

| Path | Purpose |
|------|---------|
| `package.json` | npm metadata and Pi package manifest |
| `assets/pi-goal-status.png` | Pi package gallery preview image |
| `extensions/goal.ts` | Pi extension entrypoint |
| `extensions/goal/` | State, prompt, format, debug, and structured message helpers |
| `index.test.ts` | Regression tests |
| `messages.test.ts` | Structured message and toolResponse helper tests |
| `.github/workflows/publish.yml` | Trusted publishing workflow |
