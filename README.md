# Dev Servers

A keyboard-first dashboard for every dev server you have running. See them grouped by project, jump into any one in the browser or your terminal, kill stragglers individually or in bulk, and restart with the right package manager — without leaving Raycast.

## Features

- **Auto-detects** running dev servers — Vite, Next.js, Astro, SvelteKit, Nuxt, Webpack, Parcel, Gatsby, Remix, Turbo, esbuild, anything launched via `node_modules/.bin/`, plus servers running on the Bun runtime
- **Grouped by project** — servers from the same directory appear under one section
- **Favicons** — pulls each site's actual favicon (with `/favicon.ico` fallback) and caches them across refreshes
- **Runtime tag** — yellow `bun` badge appears when the listening process is genuinely running on Bun
- **Uptime tracking** — see how long each server has been running; hover for the exact start time
- **Smart restart** — picks the right package manager (npm, pnpm, yarn, bun) from the project's lockfile, polls until the new server binds a port, surfaces failures with a link to the log
- **Confirm dialogs on bulk-kill** — destructive actions ask first, with a "Don't ask again" option for project-scoped kills
- **Open in your terminal** — configurable terminal app preference (Terminal, iTerm, Warp, Ghostty, etc.)
- **Tool filter** — dropdown in the search bar appears when you have multiple frameworks running
- **Stays open** — the window never closes after an action, so you can chain kills/restarts in one session
- **Auto-refresh** — list updates automatically on a configurable interval, plus manual `⌘R`

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Open in Browser | `↵` Enter |
| Kill Server | `⌘` `D` |
| Copy URL | `⌘` `C` |
| Restart Server | `⌘` `⇧` `R` |
| Open in Terminal | `⌘` `T` |
| Show in Finder | `⌘` `⇧` `F` |
| Refresh | `⌘` `R` |
| Kill All for Project | `⌘` `⇧` `D` |
| Kill All Servers | `⌘` `⌥` `D` |

## Preferences

- **Terminal App** — which terminal `⌘T` opens. Defaults to macOS Terminal if unset.
- **Project Display** — show the full directory path in section headers instead of just the project folder name
- **Refresh Interval** — how often to refresh the server list (2s, 5s, 10s, or 30s)

## Known Limitations

- **macOS only**
