# Changelog

## v0.4.0 (2026-05-10)

the setup flow was too dumpy. first version just dropped a whole contract block and said "approve or revise". agents would write a massive wall, users would skim, nobody caught the missing bits.

split everything into phases now. agent proposes one section, user approves, on to the next. budget, outcome, criteria, must do, avoid, philosophy, boundaries — one at a time. also added MUST DO and AVOID because the contract was missing the guardrails.

### What changed

- **Phase-by-phase setup.** Budget is Phase 0 now — agent asks what kind of budget you want instead of assuming `--token-budget`. Then Outcome, Done criteria, MUST DO, AVOID, Decision philosophy, Ask-before boundaries. Each one gets its own propose-approve cycle.
- **MUST DO and AVOID** are now required contract sections. Every objective must include all six labels.
- **`goal_set` dropped `setup_id`.** LLMs hallucinate UUIDs in tool calls. Now it just uses the one active setup — there's only ever one.
- **All tool responses are structured JSON.** Every error has `type`, `error_code`, `detail`, `suggestions`. No more plain strings. Agents can self-heal from the response.
- **Test suite went from monolithic to modular.** 81 tests across 5 files, split by concern (command, goal-set, goal-complete, goal-status, lifecycle). Plus 14 dedicated message-format tests.
- **write-dev-logs everywhere.** Inline strings extracted to typed constants in `messages.ts`. Status line strings, debug event names, audit action names, notification text — all referenced by constant, not hardcoded.

### Verification

```bash
node --import tsx --test tests/*.test.ts messages.test.ts  # 81 pass, 0 fail
```

## v0.3.0 (2026-05-09)

Been debugging this for a while. The contract verification had an architectural problem — it was trying to reconstruct what happened by scraping the session branch, which meant it broke whenever the message ordering didn't match its assumptions. One of those bugs you fix three times before realizing the approach itself is wrong.

### What changed

- **Explicit contract state tracking.** Replaced the brittle `hasConfirmedContractAfterSetup` branch-scan with a `goal_present` tool. The agent calls it when showing the contract to the user — records the timestamp and the exact objective. `goal_set` then just checks `contractPresentedAt !== null` and `contractObjective === objective`. No branch entries, no content extraction, no approval text pattern matching.
- **Module path fix.** Updated `@mariozechner/pi-*` references to `@earendil-works/pi-*` after pi was renamed upstream. The package couldn't run or be tested without this.

### Why it matters now

- `goal_set` finally works reliably in the system-injected intent flow (`untrusted_goal_intent`).
- The old approach had three independent failure modes (missing setup entry, wrong label formatting, branch message ordering). The new one has zero — it's just a state check.
- Tests also run again (module path fix). 21/21 passing.

### Verification

```bash
node --import tsx --test index.test.ts messages.test.ts  # 35 pass, 1 skipped (UI capture)
```

## v0.2.0 (2026-05-02)

Nothing flashy with the code. But the package is now a proper citizen on pi.dev/packages.

### Why

Goal mode started as a loose extension. Worked fine for me, but if someone wanted to install it, they'd have to know where to find it. No manifest, no gallery image, no publishing workflow. Just a file sitting in a folder.

Wanted to change that before the first real user tries to install it.

### What changed

- Moved from loose extension to local-packages with proper pi package manifest
- Added gallery image and publish metadata so the package shows up on pi.dev/packages
- Made README public-facing — install, usage, safety, development
- Added npm trusted publishing workflow inside the package directory
- Package preview URL now points at the versioned npm asset, not a branch projection
- Bumped to 0.2.0

### How to install

```bash
pi install @qhn/pi-goal
```

### Verification

`npm test`, `npm run verify:pi`, `npm run verify:package`, `npm run pack:dry-run` all pass.
