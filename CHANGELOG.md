# Changelog

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
node --test index.test.mjs  # 21 pass, 1 skipped (UI capture)
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
