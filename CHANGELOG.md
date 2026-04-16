# Dev Servers Changelog

## [Bun, Smarter Restart, and More Actions] - {PR_MERGE_DATE}

### Detection
- Detect dev servers launched via `bun` (in addition to `node_modules/.bin/` processes)
- Add a runtime tag — yellow `bun` badge appears when the listening process is genuinely running on the Bun runtime
- Favicon resolution now falls back to `/favicon.ico` when the page has no `<link rel="icon">`

### Restart
- Pick the right package manager (`npm`, `pnpm`, `yarn`, `bun`) from the project's lockfile instead of always running `npm run dev`
- Spawn the new process directly (no shell concatenation of the project path)
- Launch via `/bin/zsh -ilc` so user PATH (nvm, bun, pnpm) is available
- Poll until the new server actually binds a port; surface a failure toast pointing to the log file if it times out

### Actions
- "Open in Terminal" (`⌘T`) — configurable terminal app preference
- "Show in Finder" (`⌘⇧F`)
- "Refresh" (`⌘R`) with brief animated toast
- Tool-filter dropdown in the search bar (appears when multiple frameworks are running)

### Safety & UX
- `confirmAlert` on "Kill All for Project" (recoverable, "Don't ask again" supported) and "Kill All Servers" (always confirms)
- `showFailureToast` on every kill/restart catch — failures are no longer silent
- Cache favicon URLs across revalidations so icons don't flash to a placeholder every refresh
- Empty state: drop the placeholder globe (Raycast's default is cleaner), keep Refresh + Open Extension Preferences actions

## [Initial Version] - 2026-04-16

- List running dev servers grouped by project
- Kill individually, by project, or all at once
- Open in browser, copy URL
- Restart server via `npm run dev`
- Uptime tracking with exact start time on hover
- Favicon detection from each server's HTML
- SvelteKit detection (distinguishes from plain Vite)
- Configurable refresh interval preference
- Show full path preference
