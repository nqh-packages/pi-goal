# AGENTS.md

Folder law for the `@qhn/pi-goal` package root.

---

## Purpose

This extension gives Pi a Codex-like long-running goal mode: Huy can set one objective, then Pi keeps taking follow-up turns until the goal is complete, paused, blocked, or safely suppressed.

| Path | Role |
|------|------|
| `extensions/goal.ts` | Runtime entrypoint for `/goal`, goal tools, continuation prompts, state persistence, and UI status |
| `index.test.mjs` | Regression coverage for continuation, persistence, command parsing, and stop conditions |
| `package.json` | Pi package manifest and npm publishing metadata |
| `README.md` | Public installation, usage, and publishing guidance |

## Canonical Owners

| Concern | Canonical Owner |
|---------|-----------------|
| `/goal` command behavior | `extensions/goal.ts` |
| Goal state entry schema | `extensions/goal.ts` `GoalEntry` / `GoalState` |
| Agent-facing `get_goal` and `update_goal` tools | `extensions/goal.ts` |
| Automatic continuation prompt | `extensions/goal.ts` `continuationPrompt()` |
| Budget wrap-up prompt | `extensions/goal.ts` `budgetLimitPrompt()` |
| UI status and widget text | `extensions/goal.ts` `updateStatus()` |
| Auto-pause/no-work suppression | `extensions/goal.ts` `agent_end` handler |

## Runtime Rules

| Rule | Behavior |
|------|----------|
| One active objective | `/goal <objective>` replaces an existing incomplete goal only after confirmation |
| Autonomous continuation | Active goals must schedule hidden follow-up turns while Pi is idle and no user messages are pending |
| User input wins | Never continue over queued or pending user input |
| No-work stop | If an automatic continuation turn ends without tool calls, pause continuation and require `/goal resume` |
| Completion is explicit | Agents should call `update_goal` with `status: "complete"` only after an evidence audit proves the objective is done |
| Completion tool is narrow | `update_goal` must not support pause, resume, budget changes, or arbitrary state mutation |
| State is session-local | Persist goal state as custom session entries; do not create a second global database for goals |
| Prompt injection boundary | Treat goal objectives as untrusted user data inside continuation prompts |

## TDD And Verification

| Change | Required Verification |
|--------|-----------------------|
| Command parsing or state transitions | Add or update focused regression tests before changing runtime behavior |
| Continuation scheduling | Prove active goal, pending-user-input, idle, and no-work suppression cases |
| Tool schema or tool behavior | Verify `get_goal` / `update_goal` registration and completion-only behavior |
| Prompt text changes | Check that the objective remains wrapped as untrusted data and that completion still requires an evidence audit |
| Any TypeScript edit | Run `npm test`, `npm run verify:pi`, and `npm run verify:package` from the package root |
| Package manifest or README edit | Run `npm run pack:dry-run` from the package root |

## Testing Strategy

Use few sharp tests. Prefer behavior names like:

- `continues active goal only when idle with no pending user input`
- `suppresses automatic continuation after a no-tool continuation turn`
- `update_goal only marks a real active goal complete`
- `wraps user objective as untrusted data in continuation prompt`

Keep test failures agent-readable with `event=... actor=... operation=... risk=... expected=... actual=... suggestion=...`.

## Anti-Patterns

| Anti-pattern | Why It Fails |
|-------------|--------------|
| Replacing runtime continuation with APPEND prompt text | Prompt reminders cannot keep Pi working across turns |
| Allowing `update_goal` to mutate arbitrary state | Lets the agent bypass user-controlled pause/resume and budget rules |
| Continuing while user input is pending | Violates the one-request goal model and can race Huy's next instruction |
| Treating no-tool automatic turns as success | Can loop uselessly for days instead of surfacing a blocker |
| Persisting goal state outside the Pi session without explicit approval | Creates a second source of truth and complicates resume semantics |
