# AGENTS.md

Folder law for the `@qhn/pi-goal` package root.

---

## Purpose

This extension gives Pi a setup-first Codex-like long-running goal mode: Huy states an intent, Pi interviews until the goal contract is clear, then Pi keeps taking follow-up turns until the goal is complete, paused, blocked, or safely suppressed.

## Release Ownership

| Concern | Owner |
|---------|-------|
| Canonical release repository | `https://github.com/nqh-packages/pi-goal` |
| npm package | `@qhn/pi-goal` |
| Local `.pi` copy | Development/source mirror for Huy's global Pi runtime, not the release authority |
| Release mechanism | GitHub Actions trusted publishing from `nqh-packages/pi-goal` only |
| Local publishing rule | Do not run `npm publish` from `/Users/huy/.pi/agent/local-packages/goal`; sync to the release repo and publish by workflow/tag |

| Path | Role |
|------|------|
| `extensions/goal.ts` | Runtime entrypoint for `/goal`, goal tools, continuation prompts, state persistence, and status-line UI |
| `index.test.mjs` | Regression coverage for setup, tools, continuation, persistence, command parsing, and stop conditions |
| `package.json` | Pi package manifest and npm publishing metadata |
| `README.md` | Public installation, usage, and publishing guidance |

## Canonical Owners

| Concern | Canonical Owner |
|---------|-----------------|
| `/goal` command behavior | `extensions/goal.ts` |
| Goal/setup state entry schema | `extensions/goal/types.ts` / `extensions/goal/state.ts` |
| Agent-facing `goal_set`, `goal_get`, `goal_status_line`, and `goal_complete` tools | `extensions/goal.ts` |
| Setup nudge prompt | `extensions/goal/prompts.ts` `setupPrompt()` |
| Automatic continuation prompt | `extensions/goal/prompts.ts` `continuationPrompt()` |
| Budget wrap-up prompt | `extensions/goal/prompts.ts` `budgetLimitPrompt()` |
| Status-line text | `extensions/goal/format.ts` |
| Auto-pause/no-work suppression | `extensions/goal.ts` `agent_end` handler |
| Evlog-compatible internal debug/audit event helpers | `extensions/goal/debug.ts` |

## Environment Governance Exception

This package intentionally does not use Varlock yet.

| Field | Exception |
|-------|-----------|
| Env/config owner | GitHub Actions trusted publishing workflow in the release repo at `.github/workflows/publish.yml` |
| Validation mechanism | `npm test`, `npm run verify:pi`, `npm run verify:package`, and `npm run pack:dry-run` must pass before publishing |
| Secret-leak protection | Trusted publishing uses GitHub OIDC with `id-token: write`; no `NPM_TOKEN`, OTP, or registry secret is stored in repo secrets |
| Migration trigger | Add `.env.schema` before introducing any runtime environment variable, npm token secret, external drain token, or configurable secret |
| Verification command | In the release repo, `rg -n "NODE_AUTH_TOKEN|NPM_TOKEN|secrets\\.|npm_[A-Za-z]*token" .github package.json README.md` should produce no matches |

## Runtime Rules

| Rule | Behavior |
|------|----------|
| Setup-first activation | `/goal <intent>` starts setup mode and never activates directly |
| Setup contract | Setup must resolve outcome, done criteria, decision philosophy, and ask-before boundaries |
| Confirmation gate | `goal_set` requires the latest setup id, `confirmed: true`, and a labeled rich objective string |
| One active objective | Starting a new setup while an incomplete goal exists must reject with “cancel first” |
| Autonomous continuation | Active goals must schedule hidden follow-up turns while Pi is idle and no user messages are pending |
| User input wins | Never continue over queued or pending user input |
| No-work stop | If an automatic continuation turn ends without tool calls, show `BLOCKED! no progress — /goal resume` and require `/goal resume` |
| Completion is explicit | Agents should call `goal_complete` with `status: "complete"` only after an evidence audit proves the objective is done |
| Completion tool is narrow | `goal_complete` must not support pause, resume, budget changes, or arbitrary state mutation |
| State is session-local | Persist setup and goal state as custom session entries; do not create a second global database for goals |
| Prompt injection boundary | Treat goal intents/objectives as untrusted user data inside setup and continuation prompts |

## TDD And Verification

| Change | Required Verification |
|--------|-----------------------|
| Command parsing or state transitions | Add or update focused regression tests before changing runtime behavior |
| Continuation scheduling | Prove active goal, pending-user-input, idle, and no-work suppression cases |
| Setup prompt behavior | Prove setup nudge includes the four contract parts and forbids premature `goal_set` |
| Tool schema or tool behavior | Verify `goal_set`, `goal_get`, `goal_status_line`, and `goal_complete` registration and completion-only behavior |
| Prompt text changes | Check that the objective remains wrapped as untrusted data and that completion still requires an evidence audit |
| Any TypeScript edit | Run `npm test`, `npm run verify:pi`, and `npm run verify:package` from the package root |
| Package manifest or README edit | Run `npm run pack:dry-run` from the package root |

## Testing Strategy

Use few sharp tests. Prefer behavior names like:

- `continues active goal only when idle with no pending user input`
- `suppresses automatic continuation after a no-tool continuation turn`
- `goal_set activates only the latest confirmed setup`
- `goal_complete only marks a real active goal complete`
- `wraps user objective as untrusted data in continuation prompt`

Keep test failures agent-readable with `event=... actor=... operation=... risk=... expected=... actual=... suggestion=...`.

## Anti-Patterns

| Anti-pattern | Why It Fails |
|-------------|--------------|
| Replacing runtime continuation with APPEND prompt text | Prompt reminders cannot keep Pi working across turns |
| Allowing `goal_complete` to mutate arbitrary state | Lets the agent bypass user-controlled pause/resume and budget rules |
| Continuing while user input is pending | Violates the one-request goal model and can race Huy's next instruction |
| Treating no-tool automatic turns as success | Can loop uselessly for days instead of surfacing a blocker |
| Keeping legacy aliases | Lets old vocabulary keep drifting after the intentional breaking grammar change |
| Persisting goal state outside the Pi session without explicit approval | Creates a second source of truth and complicates resume semantics |
