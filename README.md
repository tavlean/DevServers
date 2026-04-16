# Dev Servers

List and manage your running development servers without leaving Raycast. See all active servers grouped by project, kill them individually or in bulk, open in browser, copy URLs, and track uptime — all with keyboard shortcuts.

## Features

- **Auto-detects** running dev servers (Vite, Next.js, Astro, SvelteKit, Nuxt, Webpack, Bun, and more)
- **Grouped by project** — servers from the same directory appear under one section
- **Favicons** — shows each site's actual favicon as the list icon
- **Uptime tracking** — see how long each server has been running; hover for exact start time
- **Stays open** — the window never closes after an action, so you can kill multiple servers in one session
- **Auto-refresh** — list updates automatically on a configurable interval
- **Smart restart** — picks the right package manager (npm, pnpm, yarn, or bun) from the project's lockfile

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Open in Browser | `↵` Enter |
| Kill server | `⌘` `D` |
| Copy URL | `⌘` `C` |
| Restart server | `⌘` `⇧` `R` |
| Kill all for project | `⌘` `⇧` `D` |
| Kill all servers | `⌘` `⌥` `D` |

## Preferences

- **Show Full Directory Path** — show the full path in section headers instead of the project folder name
- **Refresh Interval** — how often to refresh the server list (2s, 5s, 10s, or 30s)

## Known Limitations

- **macOS only**
