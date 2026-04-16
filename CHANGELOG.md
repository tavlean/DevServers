# Dev Servers Changelog

## [Bun & Package Manager Support] - {PR_MERGE_DATE}

- Detect dev servers launched via `bun` (in addition to `node_modules/.bin/` processes)
- Restart now picks the right package manager (`npm`, `pnpm`, `yarn`, `bun`) from the project's lockfile instead of always running `npm run dev`
- Restart spawns the new process directly (no shell concatenation of the project path)

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
