# Changelog

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
