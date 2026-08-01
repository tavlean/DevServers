import {
  Clipboard,
  Color,
  Image,
  LaunchType,
  MenuBarExtra,
  getPreferenceValues,
  launchCommand,
  open,
  showHUD,
  updateCommandMetadata,
} from "@raycast/api";
import { useFrecencySorting, useLocalStorage } from "@raycast/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_TERMINAL } from "./constants";
import { readPendingStarts } from "./pendingStore";
import { RecentProject, STORAGE_KEY } from "./recents";
import {
  byRecency,
  canonicalCwd,
  directoryExists,
  fetchServers,
  killServer,
  reapProjectHelpersWhenDown,
} from "./servers";
import { svgFaviconTint } from "./favicons";
import { readSnapshot, writeSnapshot } from "./snapshot";
import { toolColor } from "./tool-display";
import { DevServer } from "./types";

function metadataSubtitle(count: number): string {
  return count === 1 ? "1 running" : `${count} running`;
}

// The URL locator shown (in parentheses) after the project name: the custom
// domain host when one points at this server (e.g. "ragi.loc"), otherwise just
// the port ("9292"). "localhost" is dropped — the port alone disambiguates
// same-project servers, which is what matters when several run at once.
function serverLocator(server: DevServer): string {
  const custom =
    server.customUrls && server.customUrls.length > 0
      ? server.customUrls[0]
      : undefined;
  if (custom) {
    try {
      return new URL(custom).host;
    } catch {
      return custom;
    }
  }
  return server.port;
}

// Row title for a running server: "<project> (<locator>) · <branch>". The
// project name leads (the section header is dropped, so this is where it
// shows), then the port/domain in parens, then the branch. It's a submenu,
// which has no subtitle, so everything sits on one line at one weight — the
// parens and " · " separator stand in for the dimming we can't apply.
//
// The branch appears only when it disambiguates: the caller passes showBranch
// per project, true when that project's rows span more than one branch (i.e.
// worktrees running side by side — main included then, it's doing real work).
// A project whose servers all sit on one branch repeats nothing but noise,
// which in practice meant "· main" on every row.
function serverTitle(server: DevServer, showBranch: boolean): string {
  const head = `${server.projectName} (${serverLocator(server)})`;
  return showBranch && server.branch ? `${head} · ${server.branch}` : head;
}

function menuIconSource(name: string): Image.Source {
  return {
    light: `menubar-${name}.svg`,
    dark: `menubar-${name}@dark.svg`,
  };
}

function menuIcon(name: string): Image.ImageLike {
  return { source: menuIconSource(name) };
}

function tintedMenuIcon(
  name: string,
  tintColor: Color.ColorLike,
): Image.ImageLike {
  return { source: menuIconSource(name), tintColor };
}

// Raycast renders SVG images in the menu bar as a monochrome template — they
// show up as a solid black blob — whereas raster images (PNG/ICO) keep their
// color. A cached favicon is a data URI; if it's an SVG we can't use it here.
// (The dashboard renders in a List, which shows SVGs in full color, so its
// favicons are unaffected.)
function isSvgDataUri(uri: string): boolean {
  return uri.startsWith("data:image/svg");
}

// The raster favicon to show for a project in the menu bar, or undefined when
// there isn't a usable one. Prefers `faviconRaster` (the raster variant the
// dashboard resolves specifically for the menu bar), then the shared `favicon`
// when that's already a raster. An SVG-only project has neither and falls back
// to the framework-tinted glyph.
function menuBarFavicon(recent: RecentProject): string | undefined {
  if (recent.faviconRaster) return recent.faviconRaster;
  if (recent.favicon && !isSvgDataUri(recent.favicon)) return recent.favicon;
  return undefined;
}

// Icon for a running server row. Reuses the favicon the dashboard already
// resolved and cached onto the project's recents entry — the menu bar never
// fetches favicons itself, to stay cheap on its background interval. Projects
// with no renderable favicon fall back to the server glyph, tinted with the
// project's own brand color when one could be read out of its SVG favicon
// (tintByCwd), and only then with the framework badge color — the badge tint
// painted every SvelteKit project the same orange, which defeats scanning.
function serverIcon(
  server: DevServer,
  faviconByCwd: Map<string, string>,
  tintByCwd: Map<string, string>,
): Image.ImageLike {
  const cwd = canonicalCwd(server.cwd);
  const favicon = faviconByCwd.get(cwd);
  return favicon
    ? { source: favicon, fallback: menuIconSource("server") }
    : tintedMenuIcon("server", tintByCwd.get(cwd) ?? toolColor(server.tool));
}

// Newest first, within a project and across them, matching the dashboard.
// The same servers listed in two different orders on two surfaces reads as a
// bug in whichever one you looked at second.
function groupByProject(servers: DevServer[]): DevServer[][] {
  const groups = new Map<string, DevServer[]>();
  for (const server of [...servers].sort(byRecency)) {
    const group = groups.get(server.projectKey) ?? [];
    group.push(server);
    groups.set(server.projectKey, group);
  }
  // Insertion order already puts the project owning the newest server first,
  // since that server was the first one seen.
  return [...groups.values()];
}

async function launchDashboard(): Promise<void> {
  await launchCommand({
    name: "index",
    type: LaunchType.UserInitiated,
  });
}

async function launchStartPicker(): Promise<void> {
  await launchCommand({
    name: "start",
    type: LaunchType.UserInitiated,
    context: { forcePicker: true },
  });
}

// Restart delegates to the dashboard's spawn flow, exactly like a start of an
// already-running project: the flow kills the old server, respawns, raises the
// "Restarting…" pending row, and diagnoses failures. It cannot run here: a
// clicked menu bar command survives its click by well under a second (enough
// for a launchCommand, which is why the Start items work), and a restart's
// kill-wait → helper reap → spawn chain is longer than that, so the respawn
// died with the process every time. confirmRestarts: false because this click
// already is the answer to "restart it?".
async function launchRestart(server: DevServer): Promise<void> {
  await launchCommand({
    name: "index",
    type: LaunchType.UserInitiated,
    context: {
      spawn: {
        targets: [{ cwd: server.cwd, name: server.projectName }],
        confirmMulti: false,
        confirmRestarts: false,
        showAutoOpenHint: false,
        requestId:
          Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      },
    },
  });
}

async function launchRecent(recent: RecentProject): Promise<void> {
  await launchCommand({
    name: "index",
    type: LaunchType.UserInitiated,
    context: {
      spawn: {
        targets: [{ cwd: recent.cwd, name: recent.projectName }],
        // No autoOpen: the dashboard reads that preference itself, so the
        // menu bar cannot hand it a value that disagrees with the setting.
        confirmMulti: false,
        showAutoOpenHint: false,
        // Unique per call, so a dashboard that is already mounted can tell
        // this request from the one it handled last. This is the surface that
        // can reach a loaded dashboard without a relaunch, so it matters most
        // here.
        requestId:
          Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      },
    },
  });
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences.Menubar>();
  const [servers, setServers] = useState<DevServer[]>(
    () => readSnapshot() ?? [],
  );
  const [isLoading, setIsLoading] = useState(true);
  const { value: recents = [] } = useLocalStorage<RecentProject[]>(
    STORAGE_KEY,
    [],
  );

  // Raycast unloads a menu bar command shortly after its menu closes, and
  // clicking an item is what closes it. Short async chains survive the click
  // (a launchCommand does; the Start items and launchRestart depend on that),
  // but second-long chains die partway: Restart used to get exactly as far as
  // its synchronous SIGKILL and lose the respawn every time, which is why it
  // now delegates to the dashboard instead of spawning here. isLoading does
  // NOT reliably extend the click path (the documented isLoading contract
  // covers root-search and interval launches), so this wrapper is best-effort
  // only: it holds isLoading through an action's async tail to give work like
  // Kill's helper reap its best shot at completing, and nothing here may
  // *depend* on that tail running. A counter rather than a boolean, so an
  // action finishing can't drop the flag while the initial refresh (or
  // another action) is still in flight.
  const [busyCount, setBusyCount] = useState(0);
  const stayLoadedWhile = useCallback((work: () => Promise<void>) => {
    setBusyCount((n) => n + 1);
    void work()
      .catch(() => {})
      .finally(() => setBusyCount((n) => n - 1));
  }, []);

  const refresh = useCallback(async () => {
    // The dashboard's starts in flight, which is how this surface gets to make
    // the same call it does about a mid-start project's helper rows: they are
    // listening while the project's own server is not, and fetchServers cannot
    // tell them apart from a real one without being told. Entries past their
    // deadline are ignored, so a dashboard that was unloaded mid-start leaves
    // behind an entry that hides rows for its own window and no longer.
    const now = Date.now();
    const settling = new Set(
      [...(await readPendingStarts())]
        .filter(
          ([, entry]) => entry.status === "starting" && entry.deadline > now,
        )
        .map(([cwd]) => cwd),
    );
    const next = await fetchServers(settling);
    setServers(next);
    writeSnapshot(next);
    await updateCommandMetadata({ subtitle: metadataSubtitle(next.length) });
    return next;
  }, []);

  useEffect(() => {
    refresh()
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [refresh]);

  const runningCwds = useMemo(
    () => new Set(servers.map((server) => canonicalCwd(server.cwd))),
    [servers],
  );

  // Raster favicons the dashboard cached onto recents, keyed by canonical cwd,
  // so running rows can show the project's real icon without a network fetch.
  // menuBarFavicon skips SVG-only projects (the menu bar renders SVGs as a
  // black blob), so those rows keep the framework-tinted glyph instead.
  const faviconByCwd = useMemo(() => {
    const map = new Map<string, string>();
    for (const recent of recents) {
      const favicon = menuBarFavicon(recent);
      if (favicon) map.set(canonicalCwd(recent.cwd), favicon);
    }
    return map;
  }, [recents]);

  // Brand tints for projects the menu bar can't show a favicon image for:
  // their cached favicon is SVG-only, but the SVG's dominant color still
  // carries the project's identity onto the fallback glyph. Keyed by canonical
  // cwd like faviconByCwd; a project in neither map uses the framework tint.
  const tintByCwd = useMemo(() => {
    const map = new Map<string, string>();
    for (const recent of recents) {
      if (menuBarFavicon(recent) || !recent.favicon) continue;
      const tint = svgFaviconTint(recent.favicon);
      if (tint) map.set(canonicalCwd(recent.cwd), tint);
    }
    return map;
  }, [recents]);

  const startableRecents = useMemo(
    () =>
      recents
        .filter(
          (recent) =>
            // Skip running projects (the dashboard owns them) and entries whose
            // folder no longer exists on disk — e.g. a deleted git worktree.
            // Mirrors the Start command's filter so the two lists stay in sync.
            !runningCwds.has(canonicalCwd(recent.cwd)) &&
            directoryExists(recent.cwd),
        )
        .sort((a, b) => b.lastSeen - a.lastSeen),
    [recents, runningCwds],
  );

  const { data: sortedRecents, visitItem } = useFrecencySorting(
    startableRecents,
    {
      namespace: "project-starts",
      key: (item) => item.cwd,
      sortUnvisited: (a, b) => b.lastSeen - a.lastSeen,
    },
  );

  // The six rows the Start section will actually render; the branch-subtitle
  // rule below judges ambiguity against these, not the full recents list — a
  // twin that fell off the end of the list can't confuse anyone.
  const visibleRecents = useMemo(
    () => sortedRecents.slice(0, 6),
    [sortedRecents],
  );
  const duplicateRecentNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of visibleRecents) {
      counts.set(r.projectName, (counts.get(r.projectName) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
  }, [visibleRecents]);

  const terminalApp = prefs.terminalApp ?? DEFAULT_TERMINAL;
  const editorApp = prefs.editorApp;
  const title =
    (prefs.showCount ?? true) && servers.length > 0
      ? String(servers.length)
      : undefined;

  return (
    <MenuBarExtra
      icon={menuIcon("server")}
      title={title}
      tooltip="Dev Servers"
      isLoading={isLoading || busyCount > 0}
    >
      {servers.length === 0 ? (
        <MenuBarExtra.Item title="No dev servers running" />
      ) : (
        groupByProject(servers).map((projectServers) => {
          // Branch tags only when they tell rows apart: a project whose
          // running servers span more than one branch is worktrees side by
          // side, and every row gets its branch (main included). One branch
          // across the project — the overwhelmingly common case — shows none.
          const branchesDiffer =
            new Set(projectServers.map((s) => s.branch ?? "")).size > 1;
          // No section title: the project name now leads each row (serverTitle).
          // The title-less section still renders a divider between projects and
          // hosts the per-project "Kill All" item.
          return (
            <MenuBarExtra.Section key={projectServers[0].projectKey}>
              {projectServers.map((server) => (
                <MenuBarExtra.Submenu
                  key={`${server.pid}:${server.port}`}
                  title={serverTitle(server, branchesDiffer)}
                  icon={serverIcon(server, faviconByCwd, tintByCwd)}
                >
                  <MenuBarExtra.Item
                    title="Open in Browser"
                    icon={menuIcon("open-browser")}
                    onAction={() => {
                      void open(server.url);
                    }}
                  />
                  {server.customUrls && server.customUrls.length > 0 ? (
                    <MenuBarExtra.Item
                      title="Open Localhost URL"
                      icon={menuIcon("local-link")}
                      onAction={() => {
                        void open(server.localUrl);
                      }}
                    />
                  ) : null}
                  <MenuBarExtra.Separator />
                  <MenuBarExtra.Item
                    title="Restart"
                    icon={menuIcon("restart")}
                    onAction={() => {
                      void launchRestart(server);
                    }}
                  />
                  <MenuBarExtra.Item
                    title="Kill"
                    icon={tintedMenuIcon("kill", Color.Red)}
                    onAction={() => {
                      stayLoadedWhile(async () => {
                        // The SIGKILL lands synchronously inside killServer;
                        // only the wait-for-exit is deferred. The HUD goes up
                        // before that wait so the confirmation beats the
                        // click-teardown grace window — it is the only
                        // feedback a menu kill has, and it must not queue
                        // behind half a second of process-exit polling.
                        const killed = killServer(server.pid);
                        await showHUD(`Killed ${server.projectName}`);
                        await killed;
                        // Same cleanup the dashboard does. Killing from here
                        // would otherwise strand the project's helpers, which
                        // hold their ports until the machine restarts. killServer
                        // already waited for the process to exit, so the reap's
                        // first look finds the port free and it returns at once.
                        await reapProjectHelpersWhenDown([server.cwd]);
                        await refresh();
                      });
                    }}
                  />
                  <MenuBarExtra.Separator />
                  <MenuBarExtra.Item
                    title="Copy URL"
                    icon={menuIcon("copy-url")}
                    onAction={() => {
                      void Clipboard.copy(server.url);
                    }}
                  />
                  <MenuBarExtra.Item
                    title="Copy Port"
                    icon={menuIcon("copy-port")}
                    onAction={() => {
                      void Clipboard.copy(server.port);
                    }}
                  />
                  {editorApp ? (
                    <MenuBarExtra.Item
                      title="Open in Editor"
                      icon={menuIcon("editor")}
                      onAction={() => {
                        void open(server.cwd, editorApp);
                      }}
                    />
                  ) : null}
                  <MenuBarExtra.Item
                    title="Open in Terminal"
                    icon={menuIcon("terminal")}
                    onAction={() => {
                      void open(server.cwd, terminalApp);
                    }}
                  />
                </MenuBarExtra.Submenu>
              ))}
              {projectServers.length >= 2 ? (
                // No confirmAlert in the menu bar context, so the guardrails are
                // the label carrying the count, bottom placement, and hiding the
                // item entirely for single-server projects (where the per-server
                // Kill already covers it).
                <MenuBarExtra.Item
                  title={
                    projectServers.length === 2
                      ? "Kill Both Servers"
                      : `Kill All ${projectServers.length} Servers`
                  }
                  icon={tintedMenuIcon("kill", Color.Red)}
                  onAction={() => {
                    stayLoadedWhile(async () => {
                      // allSettled: a server can die between menu open and click,
                      // and one stale pid must not stop the rest of the project.
                      // Signals land synchronously; the HUD goes up before the
                      // exit waits, same reasoning as the per-server Kill.
                      const killed = Promise.allSettled(
                        projectServers.map((server) => killServer(server.pid)),
                      );
                      await showHUD(
                        projectServers.length === 2
                          ? `Killed both ${projectServers[0].projectName} servers`
                          : `Killed all ${projectServers.length} ${projectServers[0].projectName} servers`,
                      );
                      await killed;
                      // Reap once per folder, after every server in it is down:
                      // killing a server strands its helpers, and a reap taken
                      // while any real server for the cwd is still listening
                      // backs out rather than touch that server's plumbing.
                      await reapProjectHelpersWhenDown(
                        projectServers.map((s) => s.cwd),
                      );
                      await refresh();
                    });
                  }}
                />
              ) : null}
            </MenuBarExtra.Section>
          );
        })
      )}

      {visibleRecents.length > 0 ? (
        // Section titles render even over zero children, so an empty recents
        // list (or one fully hidden by the running set) must drop the whole
        // section rather than strand a bare "Start" header.
        <MenuBarExtra.Section title="Start">
          {visibleRecents.map((recent) => (
            <MenuBarExtra.Item
              key={recent.cwd}
              title={recent.projectName}
              // Branch only when the name alone is ambiguous — two visible
              // entries sharing a project name are worktrees of it, and the
              // branch is what tells them apart. Otherwise it's noise
              // ("main" on every row); same rule the running rows follow.
              subtitle={
                duplicateRecentNames.has(recent.projectName)
                  ? recent.branch
                  : undefined
              }
              icon={
                menuBarFavicon(recent) ??
                tintedMenuIcon(
                  "folder",
                  tintByCwd.get(canonicalCwd(recent.cwd)) ??
                    (recent.tool
                      ? toolColor(recent.tool)
                      : Color.SecondaryText),
                )
              }
              onAction={() => {
                stayLoadedWhile(async () => {
                  await visitItem(recent);
                  await launchRecent(recent);
                });
              }}
            />
          ))}
        </MenuBarExtra.Section>
      ) : null}

      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title="Open Dashboard"
          icon={menuIcon("dashboard")}
          onAction={() => {
            void launchDashboard();
          }}
        />
        <MenuBarExtra.Item
          title="Start Dev Server…"
          icon={menuIcon("start")}
          onAction={() => {
            void launchStartPicker();
          }}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
