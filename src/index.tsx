import {
  Action,
  ActionPanel,
  Alert,
  Application,
  Clipboard,
  Color,
  Detail,
  Icon,
  Image,
  LaunchProps,
  LaunchType,
  List,
  Toast,
  confirmAlert,
  getPreferenceValues,
  launchCommand,
  openExtensionPreferences,
  showToast,
  useNavigation,
} from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";
import * as fs from "node:fs";
import * as os from "node:os";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_TERMINAL } from "./constants";
import {
  recordSeen,
  recordSeenBatch,
  toRecent,
  updateRecentFavicon,
} from "./recents";
import {
  fetchServers,
  killProcess,
  killServer,
  openInBackground,
  restartServer,
  spawnLogPath,
  startDevServer,
} from "./servers";
import { pokeMenuBar, writeSnapshot } from "./snapshot";
import { toolColor, toolLabel } from "./tool-display";
import { DevServer } from "./types";

// Hand off to the Start Dev Server command. Used by the empty-state
// primary action and by the per-row "Start Dev Server" action, so both
// surfaces lead to the same picker (recents + Choose Folder) without
// the user having to bounce back to root search.
async function openStartCommand(): Promise<void> {
  try {
    // forcePicker tells the Start command to skip its Finder-selection
    // probe and go straight to the recents/Choose-Folder picker. From the
    // dashboard the user is in "manage running servers" mode and wants to
    // choose what to start, not have a stale Finder selection hijacked into
    // a spawn/restart of whatever happens to be selected.
    await launchCommand({
      name: "start",
      type: LaunchType.UserInitiated,
      context: { forcePicker: true },
    });
  } catch (err) {
    await showFailureToast(err, { title: "Couldn't open Start Dev Server" });
  }
}

// Shallow equality on the dashboard's view of the server list: same length,
// and same pid+port+branch in the same positions. ps returns processes in PID
// order which is stable for the same processes between polls, so position-wise
// comparison is enough to catch what we care about (a server starting or
// dying, or a branch switch), and `fetchStableServers` can hand back the
// previous array reference when nothing changed so React bails out of the
// re-render.
//
// Branch is included because it comes from a local git/HEAD read that's
// reliable poll-to-poll, and users do switch branches under a running server;
// without it the row would keep showing the old branch until the PID changed.
//
// Deliberately does NOT compare derived fields like the portless
// `url`/`customUrls`. Those come from a `portless list` shell-out with a 3s
// timeout that can intermittently miss, so including them made the comparison
// flap (alias present one poll, absent the next), defeating the dedupe and
// churning re-renders. The tradeoff is that a portless alias attached to an
// already-running server isn't reflected until its PID changes, which is fine:
// aliases are set up at server start in practice, and this matches the
// long-shipped behavior.
function sameServers(a: DevServer[], b: DevServer[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].pid !== b[i].pid ||
      a[i].port !== b[i].port ||
      a[i].branch !== b[i].branch
    )
      return false;
  }
  return true;
}

// First non-internal IPv4 address, for "open this on your phone" URLs.
// Prefer en0/en1 (built-in Wi-Fi / Ethernet on Macs) so a VPN utun or
// container bridge doesn't win just by sorting first.
function lanIPv4(): string | undefined {
  const ifaces = os.networkInterfaces();
  const pick = (name: string) =>
    ifaces[name]?.find((a) => a.family === "IPv4" && !a.internal)?.address;
  const preferred = pick("en0") ?? pick("en1");
  if (preferred) return preferred;
  for (const addrs of Object.values(ifaces)) {
    const hit = addrs?.find((a) => a.family === "IPv4" && !a.internal);
    if (hit) return hit.address;
  }
  return undefined;
}

// Strip scheme and trailing slash so a primary URL renders cleanly as the row
// title: "https://myapp.localhost/" → "myapp.localhost",
// "http://localhost:4321" → "localhost:4321".
function displayHost(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function formatUptime(startedAt: Date): string {
  const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  if (isNaN(seconds) || seconds < 0) return "?";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// Fetch with a hard 3s timeout. Returns null on any failure so callers can
// chain fallbacks cleanly without nested try/catch.
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { method?: string } = {},
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Some SVG favicons are authored as a single-color glyph that inherits the
// page's text color through `currentColor` and declare no color of their own.
// Raycast renders a data-URI SVG with no surrounding color context, so those
// collapse to a flat black square. Detect that specific case — currentColor
// AND no explicit fill/stroke/gradient color — so the resolver can prefer a
// real colored icon. A colored SVG that merely mentions currentColor on one
// sub-path is left alone, to avoid regressing icons that render fine today.
function isMonochromeSvg(svg: string): boolean {
  if (!/currentColor/i.test(svg)) return false;
  // Proof the SVG paints an explicit color somewhere: a hex/rgb/hsl value, a
  // gradient, or a CSS named color (red, navy, …). Keywords that aren't real
  // colors — currentColor/none/inherit/transparent/unset/initial/context-* —
  // don't count, so an SVG that only pairs currentColor with those stays
  // monochrome. (Named-color check via negative lookahead so it doesn't match
  // currentColor itself, which would defeat the whole test.)
  const hasExplicitColor =
    /(?:fill|stroke|stop-color)\s*[:=]\s*["']?\s*(?:#|rgb|hsl)/i.test(svg) ||
    /(?:fill|stroke|stop-color)\s*[:=]\s*["']?\s*(?!currentcolor|none|inherit|transparent|unset|initial|context-)[a-z]/i.test(
      svg,
    ) ||
    /<(?:linear|radial)Gradient\b/i.test(svg);
  return !hasExplicitColor;
}

// Fetch a favicon and return it as an inline data URI, or undefined if the URL
// doesn't serve an image. Inlining the bytes (rather than handing Raycast a
// URL to fetch) sidesteps CORS, since some dev servers (notably Astro) don't set
// Access-Control-Allow-Origin on static assets, and Raycast's image loader
// refuses those.
//
// SVG uses URL-encoded payload, raster uses base64. That split mirrors what
// @raycast/utils does internally for its own SVG icons.
async function fetchFaviconDataUri(
  url: string,
  opts: { rejectMonochromeSvg?: boolean } = {},
): Promise<string | undefined> {
  const res = await fetchWithTimeout(url);
  if (!res || !res.ok) return undefined;
  const ct = (res.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!ct.startsWith("image/")) return undefined;
  if (ct.includes("svg")) {
    const svg = await res.text();
    // A monochrome/currentColor SVG would show as a black square; let the
    // caller fall through to a colored raster icon or the tinted fallback.
    if (opts.rejectMonochromeSvg && isMonochromeSvg(svg)) return undefined;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${ct};base64,${buf.toString("base64")}`;
}

interface ResolvedFavicons {
  // Best overall icon for the dashboard's List, which renders SVGs in color.
  best?: string;
  // Raster-only icon (PNG/ICO) for the menu bar, which renders SVG images as a
  // monochrome black template and so can't display an SVG favicon in color.
  raster?: string;
}

// Resolve favicons for a localhost dev server. Collects every icon <link> in
// the page HTML and fetches them best-first — that document order is arbitrary
// and routinely lists a monochrome Safari mask-icon (a black silhouette) ahead
// of the real icon, which is why some favicons render as a black blob. Ranking,
// high→low:
//   3. colored raster — apple-touch-icon, or an icon whose type/extension is
//      png/ico/jpg/webp/gif. Raster keeps its own colors, so it never blackens.
//   2. SVG icons — used only when they aren't currentColor-monochrome.
//   1. anything else icon-ish (type/extension unknown; content-type decides).
// `rel="mask-icon"` is skipped outright (monochrome by design).
//
// Returns two icons: `best` for the dashboard (SVG allowed), and a `raster`
// variant for the menu bar. When the page only declares an SVG, `raster` is
// filled from the conventional paths (/favicon.ico, /apple-touch-icon.png) so
// the menu bar can still show a real icon instead of falling back to a dot.
async function detectFavicons(port: string): Promise<ResolvedFavicons> {
  const origin = `http://localhost:${port}`;

  const html = await fetchWithTimeout(`${origin}/`).then((r) =>
    r ? r.text() : null,
  );

  const candidates: Array<{ url: string; rank: number }> = [];
  if (html) {
    const linkTags = html.match(/<link[^>]+>/gi) ?? [];
    for (const tag of linkTags) {
      const rel = tag.match(/rel=["']([^"']+)["']/i)?.[1].toLowerCase();
      if (!rel) continue;
      // Safari's pinned-tab icon is a black silhouette meant to be tinted by
      // the browser; taken as-is it renders as a black blob.
      if (rel.includes("mask-icon")) continue;
      const isAppleTouch = rel.includes("apple-touch-icon");
      if (!isAppleTouch && !/\bicon\b/.test(rel)) continue;

      const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
      if (!href) continue;
      const url = href.startsWith("http")
        ? href
        : `${origin}${href.startsWith("/") ? href : `/${href}`}`;

      const type = (
        tag.match(/type=["']([^"']+)["']/i)?.[1] ?? ""
      ).toLowerCase();
      const isSvg = type.includes("svg") || /\.svg(?:[?#]|$)/i.test(url);
      const isRaster =
        !isSvg &&
        (isAppleTouch ||
          type.startsWith("image/") ||
          /\.(?:png|ico|jpe?g|webp|gif)(?:[?#]|$)/i.test(url));
      candidates.push({ url, rank: isRaster ? 3 : isSvg ? 2 : 1 });
    }
  }

  // Array.sort is stable in V8, so document order is preserved within a rank.
  candidates.sort((a, b) => b.rank - a.rank);

  let best: string | undefined;
  let raster: string | undefined;
  const consider = (dataUri: string | undefined) => {
    if (!dataUri) return;
    if (!best) best = dataUri;
    if (!raster && !dataUri.startsWith("data:image/svg")) raster = dataUri;
  };

  for (const c of candidates) {
    if (best && raster) break;
    consider(await fetchFaviconDataUri(c.url, { rejectMonochromeSvg: true }));
  }

  // The page declared no usable raster (SVG-only, or no icons at all). Probe the
  // conventional raster paths so the menu bar still gets a real icon; these also
  // serve as the universal fallback when nothing was declared in the HTML.
  if (!best || !raster) {
    for (const path of ["/favicon.ico", "/apple-touch-icon.png"]) {
      if (best && raster) break;
      consider(await fetchFaviconDataUri(`${origin}${path}`));
    }
  }

  return { best, raster };
}

// On-demand view of a project's startup log. When a dev server fails to
// bind a port, the failure detail is in the spawn log (stdout+stderr) that
// `startDevServer` redirects to `spawnLogPath(cwd)`, not in any terminal
// the user can see. This surfaces that file so a misconfigured or custom
// setup (portless needing sudo, a missing binary, a crashing build) is
// diagnosable from inside Raycast instead of failing opaquely.
//
// Reached on demand only: from a per-row action, and from the "View
// Startup Log" action on the failure toast when a spawn isn't detected.
function SpawnLogView({ cwd, name }: { cwd: string; name: string }) {
  const logPath = spawnLogPath(cwd);
  const { data, isLoading, revalidate } = useCachedPromise(
    async (p: string): Promise<string> => {
      try {
        return await fs.promises.readFile(p, "utf8");
      } catch {
        return "";
      }
    },
    [logPath],
  );

  // Follow the file while the view is open so a server that's still booting
  // (or crashing) streams its output in like a live tail, instead of asking
  // the user to mash ⌘R while diagnosing.
  useEffect(() => {
    const id = setInterval(revalidate, 2000);
    return () => clearInterval(id);
  }, [revalidate]);

  const log = (data ?? "").trim();
  const exists = fs.existsSync(logPath);
  // The body is the log and nothing else. The heading used to repeat the
  // navigation title word for word, and the footer spelled out a tmpdir path
  // long enough to wrap mid-token; between them they took the top and bottom
  // of a view whose whole job is to show as many lines of output as possible.
  // The path is still one keystroke away as Copy Log Path.
  const markdown = log
    ? "```\n" + log + "\n```"
    : exists
      ? "_The log file exists but is empty. The process wrote no output before exiting._"
      : "_No startup log found. This server may have been started outside Dev Servers, so we never captured its output._";

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      navigationTitle={`Startup log: ${name}`}
      actions={
        <ActionPanel>
          {/* Refresh was the ↵ action, which this view had already made
              pointless by tailing the file every 2s. Copying the log is what
              you actually want next: into a search, an issue, or a chat. */}
          {log && <Action.CopyToClipboard title="Copy Log" content={log} />}
          {exists && (
            <Action.Open
              title="Open Log File"
              target={logPath}
              icon={Icon.BlankDocument}
            />
          )}
          <Action.CopyToClipboard
            title="Copy Log Path"
            icon={Icon.Clipboard}
            content={logPath}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
          {exists && <Action.ShowInFinder path={logPath} />}
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            onAction={revalidate}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
          />
        </ActionPanel>
      }
    />
  );
}

interface RowVisibility {
  branch: boolean;
  uptime: boolean;
  tool: boolean;
  localUrl: boolean;
}

interface ServerItemProps {
  // Stable List.Item id (the server pid as a string). Drives controlled
  // selection from the parent so we can focus a just-spawned server.
  id: string;
  server: DevServer;
  terminalApp: Application;
  // Unset when the user hasn't picked an editor; the action is hidden then.
  editorApp?: Application;
  // This Mac's LAN IPv4, when one exists. Combined with `server.lanExposed`
  // to offer a network URL other devices on the network can reach.
  lanIp?: string;
  show: RowVisibility;
  onKill: () => void;
  onKillProject: () => void;
  onKillAll: () => void;
  onRestart: () => void;
  onRefresh: () => void;
}

function ServerItem({
  id,
  server,
  terminalApp,
  editorApp,
  lanIp,
  show,
  onKill,
  onKillProject,
  onKillAll,
  onRestart,
  onRefresh,
}: ServerItemProps) {
  const { push } = useNavigation();
  // Cache the favicon URL by port. Survives revalidations and command
  // relaunches, so the icon doesn't flash back to a placeholder every
  // refresh interval. keepPreviousData keeps the prior URL visible while
  // a fresh fetch is in flight.
  const { data: favicons } = useCachedPromise(detectFavicons, [server.port], {
    keepPreviousData: true,
  });
  const faviconUrl = favicons?.best;
  const faviconRaster = favicons?.raster;
  // Persist resolved favicons onto the project's recents entry so the picker
  // (Start command) and the menu bar can render the real icon even when the
  // server is stopped. We cache both the best icon (SVG allowed, for the List)
  // and the raster variant (for the menu bar, which can't render SVGs).
  // updateRecentFavicon is a no-op when nothing changed, so this is cheap.
  useEffect(() => {
    if (!faviconUrl && !faviconRaster) return;
    updateRecentFavicon(server.cwd, {
      favicon: faviconUrl,
      faviconRaster,
    }).catch(() => {
      // Picker iconography is best-effort; failing to persist must not
      // disrupt the dashboard.
    });
  }, [server.cwd, faviconUrl, faviconRaster]);
  const icon: Image.ImageLike = faviconUrl
    ? { source: faviconUrl, fallback: Icon.Globe }
    : { source: Icon.Globe, tintColor: toolColor(server.tool) };

  // Branch goes in the left-rail subtitle (right next to the title). Raycast
  // dims subtitles automatically.
  const subtitle =
    show.branch && server.branch
      ? {
          value: server.branch,
          tooltip: `Branch: ${server.branch}\nWorktree: ${server.cwd}`,
        }
      : undefined;

  // When a custom domain (e.g. via portless) points at this port, promote
  // the domain to the title and demote `localhost:PORT` to a pill accessory.
  // The pill lives in accessories (right-aligned) because Raycast subtitles
  // are plain text, with no inline-pill primitive. The port stays
  // visible because it's still useful for env files, OAuth allowlists, CORS
  // rules, and tools that don't trust the local CA.
  const hasAlias = !!server.customUrls?.length;
  const titleHost = displayHost(server.url);
  const localBadgeTag =
    hasAlias && show.localUrl
      ? { tag: { value: `localhost:${server.port}` } }
      : undefined;

  return (
    <List.Item
      id={id}
      icon={icon}
      title={titleHost}
      subtitle={subtitle}
      keywords={[
        server.projectName,
        server.branch,
        ...(server.customUrls ?? []).map(displayHost),
      ].filter((v): v is string => Boolean(v))}
      accessories={[
        ...(show.uptime
          ? [
              {
                text: formatUptime(server.startedAt),
                tooltip: `Started ${server.startedAt.toLocaleString()}`,
              },
            ]
          : []),
        ...(localBadgeTag ? [localBadgeTag] : []),
        // Runtime tag is suppressed when it duplicates the tool tag (e.g.
        // tool is already "bun"), and rendered only when the user has the
        // tool tag visible; otherwise standalone "bun" would look orphaned.
        ...(show.tool && server.runtime === "bun" && server.tool !== "bun"
          ? [
              {
                tag: { value: "Bun", color: Color.Yellow },
                tooltip: "Listening process is running on the Bun runtime",
              },
            ]
          : []),
        ...(show.tool
          ? [
              {
                tag: {
                  value: toolLabel(server.tool),
                  color: toolColor(server.tool),
                },
              },
            ]
          : []),
      ]}
      actions={
        <ActionPanel>
          {/*
           * Action order is deliberate. Raycast auto-binds `↵` and `⌘↵` to
           * positions 1 and 2 (they can't be overridden), so we keep both
           * slots filled with benign "open" actions.
           *
           * Restart sits above Kill: restarting is the common iterate-on-
           * change action, while Kill is mostly end-of-session cleanup.
           * This also keeps `⌘↵` from auto-firing Kill when there's no
           * alias; it falls through to Restart (reversible by design).
           *
           * Kill stays high in the panel rather than at the conventional
           * "destructive at the bottom", because it's frequent and Raycast
           * paints it red as the visual safety signal. The bulk kill
           * actions further down keep convention; they're genuinely
           * high-blast-radius.
           */}
          <Action.OpenInBrowser url={server.url} title="Open in Browser" />
          {hasAlias && (
            <Action.OpenInBrowser
              url={server.localUrl}
              title="Open Localhost URL"
            />
          )}
          <Action
            title="Restart Server"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
            onAction={onRestart}
          />
          <Action
            title="Kill Server"
            icon={Icon.Stop}
            style={Action.Style.Destructive}
            shortcut={{ modifiers: ["ctrl"], key: "x" }}
            onAction={onKill}
          />
          <ActionPanel.Section>
            {/* CopyToClipboard already uses Cmd+C by default */}
            <Action.CopyToClipboard title="Copy URL" content={server.url} />
            {hasAlias && (
              <Action.CopyToClipboard
                title="Copy Localhost URL"
                content={server.localUrl}
                shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
              />
            )}
            {/* Network URL is for testing on a phone or another machine on
             * the same network. Only offered when the server actually binds
             * beyond loopback, so we never hand out a URL that can't connect. */}
            {server.lanExposed && lanIp && (
              <Action.CopyToClipboard
                title="Copy Network URL"
                content={`http://${lanIp}:${server.port}`}
                shortcut={{ modifiers: ["cmd", "opt"], key: "c" }}
              />
            )}
            <Action.CopyToClipboard
              title="Copy Port"
              content={server.port}
              shortcut={{ modifiers: ["cmd", "opt"], key: "p" }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            {editorApp && (
              <Action.Open
                title={`Open in ${editorApp.name}`}
                icon={Icon.Code}
                target={server.cwd}
                application={editorApp}
                shortcut={{ modifiers: ["cmd"], key: "e" }}
              />
            )}
            <Action.Open
              title={`Open in ${terminalApp.name}`}
              icon={Icon.Terminal}
              target={server.cwd}
              application={terminalApp}
              shortcut={{ modifiers: ["cmd"], key: "t" }}
            />
            <Action.ShowInFinder
              path={server.cwd}
              shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
            />
            <Action
              title="Start Dev Server"
              icon={Icon.Play}
              shortcut={{ modifiers: ["cmd"], key: "n" }}
              onAction={openStartCommand}
            />
            <Action
              title="View Startup Log"
              icon={Icon.Terminal}
              shortcut={{ modifiers: ["cmd"], key: "l" }}
              onAction={() =>
                push(
                  <SpawnLogView cwd={server.cwd} name={server.projectName} />,
                )
              }
            />
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              onAction={onRefresh}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Kill All for Project"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
              onAction={onKillProject}
            />
            <Action
              title="Kill All Servers"
              icon={Icon.XMarkCircle}
              style={Action.Style.Destructive}
              shortcut={{ modifiers: ["ctrl", "opt"], key: "x" }}
              onAction={onKillAll}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

// Spawn request handed off by the Start Dev Server command. The dashboard
// is the controller for the entire spawn flow (confirms, kill+spawn,
// toast lifecycle, and the eventual transition to a steady-state), so
// the user sees the dashboard immediately rather than waiting on a blank
// Start view for the pre-spawn `fetchServers` call.
interface SpawnRequest {
  targets: Array<{ cwd: string; name: string }>;
  // Multi-folder confirm gate, set by the Start command's preference.
  // Always false for single-target spawns (picker rows, folder picker).
  confirmMulti: boolean;
  // Open each new server's URL in the browser when it binds.
  autoOpen: boolean;
  // Attach a one-time "Auto-open in Browser?" CTA to the Starting toast.
  // The Start command pre-decides this based on a usage counter.
  showAutoOpenHint: boolean;
}

interface DashboardLaunchContext {
  spawn?: SpawnRequest;
}

// Format a list of names with English-style commas and "and":
//   ["A"]           -> "A"
//   ["A", "B"]      -> "A and B"
//   ["A", "B", "C"] -> "A, B, and C"
function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

// Single batch confirmation that covers any number of already-running
// targets in one prompt. Returns true to proceed, false to cancel.
async function confirmRestartBatch(
  runningTargets: Array<{
    target: { name: string };
    existing: DevServer;
  }>,
  totalCount: number,
): Promise<boolean> {
  if (runningTargets.length === 0) return true;
  const names = runningTargets.map((r) => r.target.name);
  const running = runningTargets.length;
  const total = totalCount;
  const remainingCount = total - running;

  if (total === 1) {
    return await confirmAlert({
      title: `${names[0]} is already running`,
      message: `A dev server is listening on ${runningTargets[0].existing.url}. Restart it?`,
      primaryAction: { title: "Restart" },
    });
  }
  if (running === total) {
    return await confirmAlert({
      title: `All ${total} already running`,
      message: `Restart ${joinNames(names)}?`,
      primaryAction: { title: "Restart All" },
    });
  }
  const remainingPhrase =
    remainingCount === 1 ? "the other one" : `the other ${remainingCount}`;
  return await confirmAlert({
    title: `${running} of ${total} already running`,
    message: `Restart ${joinNames(names)}, then start ${remainingPhrase}?`,
    primaryAction: { title: "Restart & Start All" },
  });
}

// Spawn phase state machine. The dashboard transitions:
//   idle      → no launchContext.spawn, normal dashboard
//   pending   → spawn request received, waiting for first fetchServers
//   confirming→ showing confirms (multi-folder and/or batch restart)
//   spawning  → toast visible, kill+spawn done, watching for servers
//   done      → terminal state (either success-hidden, timeout-hidden,
//               or user-cancelled)
type SpawnPhase =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "confirming" }
  | {
      phase: "spawning";
      // Keyed by cwd. `logStart` is the spawn log's byte size at spawn time:
      // the log is append-mode, so only bytes past this offset belong to the
      // current attempt (see diagnoseSpawnFailure).
      expecting: Map<string, { name: string; logStart: number }>;
      autoOpen: boolean;
    }
  | { phase: "done" };

// Spawn failures worth naming on the watchdog toast. Both read as "the
// extension broke" while the real cause, and the fix, sit outside the
// extension entirely, so the generic "check the startup log" wastes the
// user's time on a question we can already answer.
type SpawnFailure = "port-conflict" | "portless-proxy-down";

// How long a spawned server gets to bind a port before we call it failed.
// Shared so the pending row's progress ring runs out at the same instant the
// watchdog fires, rather than drifting from a second copy of the number.
const SPAWN_TIMEOUT_MS = 15000;

// A toast gives us one short line. The title is the only part that reliably
// survives, so the cause goes there and nothing that matters goes in the
// message, which gets elided to a word or two behind a long title. The fix,
// when we can name one, becomes an action instead of prose: a button can't be
// truncated, and it saves retyping the command.
const SPAWN_FAILURE: Record<SpawnFailure, { title: string; fix?: string }> = {
  "port-conflict": { title: "Port already in use" },
  "portless-proxy-down": {
    title: "Portless proxy isn't running",
    fix: "portless service install",
  },
};

function copyFixAction(command: string): Toast.ActionOptions {
  return {
    title: "Copy Fix Command",
    onAction: () => {
      Clipboard.copy(command).catch(() => {});
    },
  };
}

// Whether the chunk of the startup log written by this spawn (from byte
// `logStart`) shows the server dying for one of those reasons. Scoped to the
// new bytes because earlier runs in the same log may have hit the same error
// and since resolved it.
//
// Reads only this attempt's bytes rather than slurping the file: the log is
// opened append-only and never rotated, so it holds every run for this cwd
// until the OS clears tmpdir. Seeking past `logStart` also bounds the read to
// what one 15-second attempt managed to write.
function diagnoseSpawnFailure(
  cwd: string,
  logStart: number,
): SpawnFailure | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(spawnLogPath(cwd), "r");
    const length = fs.fstatSync(fd).size - logStart;
    if (length <= 0) return null;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, logStart);
    const tail = buf.toString("utf8");
    // Another process owns the port. The fix (kill the other server, or for
    // Shopify themes let the auto-port pick a free one) is nothing like
    // debugging a crashed build.
    if (/EADDRINUSE|address already in use/i.test(tail)) return "port-conflict";
    // A dev script wrapped in `portless run` needs the portless proxy up.
    // When it isn't, portless tries to auto-start it, finds no TTY to run
    // sudo on (always the case for our detached spawn) and exits before the
    // framework ever boots. Starting the proxy by hand once per reboot works
    // but is exactly the manual step the extension exists to remove; the
    // startup service makes it permanent.
    //
    // Matched on portless's full sentence, "Proxy is not running and no TTY
    // is available for sudo." Its shorter "Proxy is not running" lines come
    // from `portless proxy stop` and `portless doctor`, which say nothing
    // about a failed start, so the prefix alone would name this cause for a
    // server that is merely slow to boot.
    if (/proxy is not running and no tty/i.test(tail))
      return "portless-proxy-down";
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed / invalid fd; nothing to do.
      }
    }
  }
}

// A start the dashboard has fired but not yet seen bind a port, keyed by cwd
// in `pendingStarts`. It renders as a synthetic list row (see PendingItem)
// until the real server row takes over, or until the watchdog gives up on it.
type PendingStart = {
  // Project display name, from the spawn target.
  name: string;
  // Spawn-log byte offset at spawn time, copied from the phase's `expecting`
  // map so a failed row can diagnose itself from this attempt's bytes alone.
  logStart: number;
  status: "starting" | "failed";
  // Set when failed and diagnosable, else null.
  reason: SpawnFailure | null;
};

// Row ids for pending starts are namespaced so they can never collide with a
// server row's, which is a bare pid. The prefix is also how the render-time
// selection handoff recognizes a cursor parked on a pending row.
const PENDING_ID_PREFIX = "starting:";

function pendingRowId(cwd: string): string {
  return `${PENDING_ID_PREFIX}${cwd}`;
}

// Spinner timing. Smoothness is the size of each step, not the frame rate, so
// the two knobs pull apart: 18 frames over a revolution is a 20 degree step
// against the 30 degrees a 12-frame turn moved, and holding the frame rate
// steady spends that on a slower turn (810ms) rather than a choppier one.
// Slower also lands nearer the animated toast's spinner, which the 600ms
// version overshot.
//
// The frame rate itself is near its ceiling. Each frame costs one prop change
// on one row, the frames are precomputed (see SPINNER_ICONS), and the interval
// only runs while something is actually starting, so it is bounded by the 15s
// watchdog. But every frame is still a render round trip to Raycast, and the
// toast's own spinner is native and far smoother than anything reachable from
// here. Buy smoothness with degrees per step first; raise the rate only after
// that runs out.
const SPINNER_FRAMES = 18;
const SPINNER_FRAME_MS = 45;
// Neutral gray, readable on both the light and the dark theme. Hardcoded
// rather than tinted or drawn in currentColor: Raycast gives a data-URI SVG
// no surrounding color context, so a currentColor-only icon renders as a
// black square (the same trap isMonochromeSvg exists to dodge for favicons).
const SPINNER_COLOR = "#8E8E93";
const SPINNER_RADIUS = 5.5;
// Quarter of the circle is the moving head; the rest is the gap that rides
// around behind it.
const SPINNER_ARC = 2 * Math.PI * SPINNER_RADIUS * 0.25;
const SPINNER_GAP = 2 * Math.PI * SPINNER_RADIUS - SPINNER_ARC;

// One frame of a buffering spinner, as an SVG data URI. Raycast has no
// animated icons and no per-row loading state, so the animation is frames we
// swap ourselves: a faint full-circle track with a quarter-circle arc stepped
// around it one frame at a time, which is the same shape a CSS spinner draws
// with stroke-dasharray.
function spinnerFrame(frame: number): string {
  const angle = frame * (360 / SPINNER_FRAMES);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
    `<g fill="none" stroke="${SPINNER_COLOR}" stroke-width="1.8" stroke-linecap="round">` +
    `<circle cx="8" cy="8" r="${SPINNER_RADIUS}" opacity="0.22"/>` +
    `<circle cx="8" cy="8" r="${SPINNER_RADIUS}"` +
    ` stroke-dasharray="${SPINNER_ARC.toFixed(2)} ${SPINNER_GAP.toFixed(2)}"` +
    ` transform="rotate(${angle} 8 8)"/>` +
    `</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// The frames are a fixed set, so build them once at module load instead of
// re-encoding an SVG twenty times a second. Leaves the animation as an array
// index, which is what keeps the frame rate cheap enough to raise.
const SPINNER_ICONS: readonly string[] = Array.from(
  { length: SPINNER_FRAMES },
  (_, frame) => spinnerFrame(frame),
);

// The synthetic row for a pending start. While starting it spins; once the
// watchdog gives up it turns red and carries the remedies. A row can do that
// and a toast cannot: a toast's actions die with it, and it degrades to an
// actionless HUD as soon as the Raycast window closes, which is exactly when
// a 15-second failure lands.
//
// The spinner's frame counter lives here rather than in the dashboard so that
// ten re-renders a second stay inside this one row. Hoisting it would re-run
// the whole list, which is the churn sameServers and the polling cadence were
// both written to avoid.
function PendingItem({
  id,
  cwd,
  entry,
  terminalApp,
  onDismiss,
}: {
  id: string;
  cwd: string;
  entry: PendingStart;
  terminalApp: Application;
  onDismiss: () => void;
}) {
  const { push } = useNavigation();
  const [frame, setFrame] = useState(0);
  const spinning = entry.status === "starting";
  useEffect(() => {
    if (!spinning) return;
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES),
      SPINNER_FRAME_MS,
    );
    return () => clearInterval(id);
  }, [spinning]);

  if (entry.status === "starting") {
    return (
      <List.Item
        id={id}
        icon={SPINNER_ICONS[frame]}
        title={entry.name}
        accessories={[{ tag: { value: "Starting…", color: Color.Yellow } }]}
      />
    );
  }

  const failure = entry.reason ? SPAWN_FAILURE[entry.reason] : undefined;
  return (
    <List.Item
      id={id}
      icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }}
      title={entry.name}
      subtitle={failure?.title}
      accessories={[
        {
          tag: { value: "Failed", color: Color.Red },
          tooltip: failure ? failure.title : "Not detected after 15s",
        },
      ]}
      actions={
        <ActionPanel>
          <Action
            title="View Startup Log"
            icon={Icon.Terminal}
            shortcut={{ modifiers: ["cmd"], key: "l" }}
            onAction={() => push(<SpawnLogView cwd={cwd} name={entry.name} />)}
          />
          {failure?.fix && (
            <Action.CopyToClipboard
              title="Copy Fix Command"
              icon={Icon.Clipboard}
              content={failure.fix}
            />
          )}
          <Action.Open
            title={`Open in ${terminalApp.name}`}
            icon={Icon.Terminal}
            target={cwd}
            application={terminalApp}
            shortcut={{ modifiers: ["cmd"], key: "t" }}
          />
          <Action
            title="Dismiss"
            icon={Icon.XMarkCircle}
            shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
            onAction={onDismiss}
          />
        </ActionPanel>
      }
    />
  );
}

export default function Command(
  props: LaunchProps<{ launchContext?: DashboardLaunchContext }>,
) {
  const prefs = getPreferenceValues<Preferences.Index>();
  const { push } = useNavigation();
  // Capture launchContext once at mount. The destructured props are new
  // identities every render, so reading via a ref keeps every effect's
  // closure stable.
  const launchContextRef = useRef(props.launchContext);
  const spawnRequest = launchContextRef.current?.spawn;

  // Dedupe `servers` references when content is unchanged. Without this,
  // every poll (every 1s while expecting servers) hands React a new array
  // identity, triggering downstream effects/memos to re-evaluate even
  // when nothing actually changed. Raycast's dev runtime detects this as
  // "rendering a lot without any changes" and warns, and it's wasted
  // work regardless of the warning. Returning the previous reference
  // when pid+port content matches lets React's Object.is bail out of
  // the re-render entirely.
  const fetchStableServers = useMemo(() => {
    let last: DevServer[] = [];
    return async (): Promise<DevServer[]> => {
      const next = await fetchServers();
      writeSnapshot(next);
      if (sameServers(next, last)) return last;
      last = next;
      return next;
    };
  }, []);

  const {
    isLoading,
    data: servers = [],
    mutate,
    revalidate,
  } = useCachedPromise(fetchStableServers, [], {
    keepPreviousData: true,
  });

  // Mirror `servers` into a ref so async handlers can read the latest
  // value without going stale on closure capture.
  const serversRef = useRef(servers);
  useEffect(() => {
    serversRef.current = servers;
  }, [servers]);

  // `hasLoaded` flips true after the very first fetch completes and
  // never resets. We gate the List's `isLoading` on this so subsequent
  // background revalidations don't flicker the EmptyView into Raycast's
  // default "no results" placeholder (the docs explicitly say EmptyView
  // is hidden whenever isLoading is true with an empty search bar).
  const [hasLoaded, setHasLoaded] = useState(false);
  useEffect(() => {
    if (!isLoading) setHasLoaded(true);
  }, [isLoading]);
  const effectiveLoading = !hasLoaded && isLoading;

  // Spawn phase state machine; see SpawnPhase type for the transitions.
  const [spawnState, setSpawnState] = useState<SpawnPhase>(() =>
    spawnRequest ? { phase: "pending" } : { phase: "idle" },
  );
  const toastRef = useRef<Toast | null>(null);

  // Controlled list selection. We keep selection in state so we can jump the
  // cursor to a just-spawned (or just-restarted) server, while onSelectionChange
  // feeds the user's own navigation back in. This two-way wiring is what keeps
  // a pinned selectedItemId from yanking the cursor back to the new row on every
  // background poll — once the user moves, state follows them. The id is the
  // server pid as a string (see List.Item `id` below); undefined lets Raycast
  // manage selection itself (initial mount, or when a filter clears the list).
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(
    undefined,
  );
  // Mirrored for the watch effect, which must not take `selectedItemId` as a
  // dependency: that effect keys on `servers` and `spawnState`, and adding
  // selection to it would re-run the whole detection body every time the user
  // moved the cursor.
  const selectedIdRef = useRef(selectedItemId);
  useEffect(() => {
    selectedIdRef.current = selectedItemId;
  }, [selectedItemId]);

  // Starts in flight, keyed by cwd. Deliberately its own state slice rather
  // than synthetic entries in the useCachedPromise data: every kill and
  // restart handler runs an optimisticUpdate filter over that array typed as
  // DevServer[], and a fake entry would flow through all of them.
  const [pendingStarts, setPendingStarts] = useState<Map<string, PendingStart>>(
    new Map(),
  );

  // Forget entries whose cwd now has a real server row. This is bookkeeping
  // only: visible rows are derived from the same `servers` array (see
  // visiblePending), so the handoff already happened in the render that first
  // listed the server, and this cleanup can land whenever it likes.
  useEffect(() => {
    setPendingStarts((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const s of servers) next.delete(s.cwd);
      return next.size === prev.size ? prev : next;
    });
  }, [servers]);

  function dismissPending(cwd: string) {
    setPendingStarts((prev) => {
      if (!prev.has(cwd)) return prev;
      const next = new Map(prev);
      next.delete(cwd);
      return next;
    });
  }

  // Dashboard polling cadence. Faster only while actively watching for a
  // just-spawned server to bind a port, so it appears within ~1s. We do NOT
  // fast-poll during "pending"/"confirming": nothing is spawning yet, and
  // "confirming" can block indefinitely on a confirm dialog — polling at 1s
  // there just toggles isLoading every second, producing a burst of identical
  // re-renders that trips Raycast's "rendering a lot" warning for no benefit.
  useEffect(() => {
    const ms =
      spawnState.phase === "spawning"
        ? 1000
        : parseInt(prefs.refreshInterval) * 1000;
    const id = setInterval(revalidate, ms);
    return () => clearInterval(id);
  }, [spawnState.phase, prefs.refreshInterval, revalidate]);

  // Spawn flow: pending → confirming → spawning (or → done on cancel).
  // Fires once the initial fetch has completed (hasLoaded) so confirms
  // can be based on the actual current set of running servers.
  const spawnFlowFired = useRef(false);
  useEffect(() => {
    if (spawnFlowFired.current) return;
    if (spawnState.phase !== "pending") return;
    if (!hasLoaded) return;
    spawnFlowFired.current = true;

    void (async () => {
      const spawn = launchContextRef.current?.spawn;
      if (!spawn) {
        setSpawnState({ phase: "done" });
        return;
      }

      setSpawnState({ phase: "confirming" });

      // Snapshot current running servers for the confirm logic.
      const running = new Map(serversRef.current.map((s) => [s.cwd, s]));

      // 1. Multi-folder confirmation (only when N>1 and the pref is on).
      if (spawn.targets.length > 1 && spawn.confirmMulti) {
        const ok = await confirmAlert({
          title: `Start ${spawn.targets.length} dev servers?`,
          message: spawn.targets.map((t) => t.name).join(", "),
          primaryAction: { title: "Start All" },
        });
        if (!ok) {
          setSpawnState({ phase: "done" });
          return;
        }
      }

      // 2. Batch restart confirmation: one alert for any number of
      //    already-running targets.
      const runningTargets = spawn.targets
        .map((t) => ({ target: t, existing: running.get(t.cwd) }))
        .filter(
          (
            x,
          ): x is {
            target: { cwd: string; name: string };
            existing: DevServer;
          } => !!x.existing,
        );
      const proceed = await confirmRestartBatch(
        runningTargets,
        spawn.targets.length,
      );
      if (!proceed) {
        setSpawnState({ phase: "done" });
        return;
      }

      // 3. Show the "Starting…" toast before doing the kill+spawn work
      //    so the user has feedback the moment they confirm.
      const label =
        spawn.targets.length === 1
          ? spawn.targets[0].name
          : `${spawn.targets.length} dev servers`;
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: `Starting ${label}…`,
        primaryAction: spawn.showAutoOpenHint
          ? {
              title: "Auto-open in Browser?",
              onAction: async (t) => {
                await openExtensionPreferences();
                await t.hide();
              },
            }
          : undefined,
      });
      toastRef.current = toast;

      // 4. Kill running PIDs first so they release their ports before
      //    we spawn replacements. Parallelized, since they're independent processes.
      await Promise.all(
        runningTargets.map((rt) => killServer(rt.existing.pid)),
      );

      // 5. Spawn every approved target in parallel. The spawn itself
      //    returns immediately (detached process), so this is fast. A target
      //    whose spawn throws (e.g. no recognizable dev script) gets its own
      //    failure toast here and is dropped from the set we go on to watch —
      //    see step 6.
      const spawned = await Promise.all(
        spawn.targets.map(async (t) => {
          // Size of the (append-mode) spawn log before this attempt writes
          // to it, so the watchdog can inspect only this attempt's output.
          let logStart = 0;
          try {
            logStart = fs.statSync(spawnLogPath(t.cwd)).size;
          } catch {
            // No log yet; the spawn writes from byte 0.
          }
          try {
            await startDevServer(t.cwd);
            await recordSeen({
              cwd: t.cwd,
              projectName: t.name,
            });
            return { ...t, logStart };
          } catch (err) {
            await showFailureToast(err, {
              title: `Failed to start ${t.name}`,
            });
            return null;
          }
        }),
      );
      const succeeded = spawned.filter(
        (t): t is NonNullable<(typeof spawned)[number]> => Boolean(t),
      );

      // 6. Transition to spawning, watching ONLY the targets that actually
      //    spawned. Failed ones already showed their own failure toast above;
      //    including them in `expecting` would leave the animated "Starting…"
      //    toast hanging and let the 15s timeout escalate it into a second,
      //    duplicate failure for the same non-event. If nothing spawned, the
      //    per-target toasts have said it all — tear down the "Starting…" toast
      //    and finish without ever entering the watch/timeout cycle.
      if (succeeded.length === 0) {
        await toastRef.current?.hide();
        toastRef.current = null;
        setSpawnState({ phase: "done" });
        return;
      }

      // Give every spawned target a row of its own straight away, so the
      // dashboard shows what is in flight and already has somewhere to put the
      // failure if the watchdog fires. Writing by cwd also means starting a
      // project that currently shows a failed row resets that row instead of
      // stacking a second one.
      setPendingStarts((prev) => {
        const next = new Map(prev);
        for (const t of succeeded) {
          next.set(t.cwd, {
            name: t.name,
            logStart: t.logStart,
            status: "starting",
            reason: null,
          });
        }
        return next;
      });
      // Follow the thing the user just asked for, from the first row it has
      // through to the server row it becomes (the watch effect re-points
      // selection at the real pid on handoff). Without this the cursor sits
      // on whatever was selected before, and the row they are watching is
      // not the row ↵ would act on.
      setSelectedItemId(pendingRowId(succeeded[0].cwd));

      // The watch effect below takes over, flipping the toast to Success once
      // every spawned cwd appears in the servers state (driven by the normal
      // polling, now at 1s).
      setSpawnState({
        phase: "spawning",
        expecting: new Map(
          succeeded.map((t) => [t.cwd, { name: t.name, logStart: t.logStart }]),
        ),
        autoOpen: spawn.autoOpen,
      });
    })();
  }, [spawnState.phase, hasLoaded]);

  // Watch for every expected cwd to show up in the servers state.
  // Drives the toast to Success and auto-hides after a brief beat.
  useEffect(() => {
    if (spawnState.phase !== "spawning") return;
    const expecting = spawnState.expecting;
    const remaining = new Map(expecting);
    for (const s of servers) {
      if (remaining.has(s.cwd)) remaining.delete(s.cwd);
    }
    if (remaining.size > 0) return;

    // All expected servers detected. Move the cursor onto the newly started
    // server so the default ↵ action operates on it instead of whatever row
    // happened to be selected. When several were started at once, focus the
    // first; the user can step through the rest. Resolving by cwd picks
    // whichever server is now listening for that cwd, which is the freshly
    // spawned one even after a kill+respawn.
    //
    // Skipped while the cursor sits on a pending row: the render-time handoff
    // has already carried it to that row's server, and that is the one the
    // user was watching. Overriding it here would drag them to the first of a
    // batch for no reason.
    if (!selectedIdRef.current?.startsWith(PENDING_ID_PREFIX)) {
      const firstCwd = [...expecting.keys()][0];
      const focusTarget = servers.find((x) => x.cwd === firstCwd);
      if (focusTarget) setSelectedItemId(String(focusTarget.pid));
    }

    // Auto-open is the extension acting on its own, so it opens the tab
    // behind whatever the user is looking at. Raycast's `open()` activates
    // the browser, and Raycast hides itself the moment it loses focus, which
    // tore the dashboard away mid-glance a couple of seconds after a start.
    // Losing the window also loses everything else it was offering: copying
    // the URL for a different browser, opening a terminal on the project.
    if (spawnState.autoOpen) {
      for (const cwd of expecting.keys()) {
        const s = servers.find((x) => x.cwd === cwd);
        if (s) openInBackground(s.url).catch(() => {});
      }
    }
    pokeMenuBar();
    const toast = toastRef.current;
    if (toast) {
      toast.style = Toast.Style.Success;
      toast.title =
        expecting.size === 1
          ? `${[...expecting.values()][0].name} is running`
          : `${expecting.size} dev servers running`;
      setTimeout(() => {
        toast.hide().catch(() => {});
      }, 2500);
    }
    setSpawnState({ phase: "done" });
  }, [servers, spawnState]);

  // Hard 15s timeout. Any expected server that still hasn't bound a port turns
  // its pending row red. A server that exits before binding is otherwise
  // indistinguishable from one still booting, so without this the row would
  // spin forever and the user would have no thread to pull on.
  //
  // The failure lands on the row rather than the toast because the remedies
  // have to outlive the moment: a toast takes its actions with it when it
  // goes, and it degrades to an actionless HUD whenever the Raycast window is
  // closed, which is most of the time 15 seconds after a start. Each missing
  // target diagnoses itself, so several servers failing for different reasons
  // each say their own piece, which one toast line could never do.
  //
  // `servers` is read from the ref so we compare against the latest poll, not
  // the stale snapshot this effect closed over.
  useEffect(() => {
    if (spawnState.phase !== "spawning") return;
    const expecting = spawnState.expecting;
    const timer = setTimeout(() => {
      const present = new Set(serversRef.current.map((s) => s.cwd));
      const missing = [...expecting.entries()].filter(
        ([cwd]) => !present.has(cwd),
      );
      if (missing.length > 0) {
        const diagnosed = missing.map(
          ([cwd, target]) =>
            [cwd, diagnoseSpawnFailure(cwd, target.logStart)] as const,
        );
        setPendingStarts((prev) => {
          const next = new Map(prev);
          for (const [cwd, reason] of diagnosed) {
            const entry = next.get(cwd);
            if (entry) next.set(cwd, { ...entry, status: "failed", reason });
          }
          return next;
        });
        // Put the cursor on the first failed row so its remedies are one ↵
        // away. Safe to pin: this row has been on screen since the spawn, so
        // we are only re-pointing selection at an id the list already has.
        setSelectedItemId(pendingRowId(missing[0][0]));
      }
      // The rows carry the failure now, and the success path has its own
      // toast, so nothing is left for this one to say.
      toastRef.current?.hide().catch(() => {});
      setSpawnState({ phase: "done" });
    }, SPAWN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [spawnState.phase]);

  // Every observed server feeds the recents store, so the Start Recent
  // Dev Server picker has an up-to-date list of projects without the user
  // having to bookmark anything explicitly. Dedup by cwd within a single
  // tick so multi-server projects don't write themselves multiple times.
  useEffect(() => {
    if (servers.length === 0) return;
    const byCwd = new Map<string, ReturnType<typeof toRecent>>();
    for (const s of servers) {
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, toRecent(s));
    }
    recordSeenBatch([...byCwd.values()]).catch(() => {
      // Recents are a best-effort enhancement; a write failure must not
      // disrupt the dashboard, so swallow.
    });
  }, [servers]);

  async function kill(pid: number) {
    try {
      await mutate(killProcess(pid), {
        optimisticUpdate: (current) =>
          (current ?? []).filter((s) => s.pid !== pid),
        rollbackOnError: true,
      });
      pokeMenuBar();
    } catch (err) {
      await showFailureToast(err, { title: "Failed to kill server" });
    }
  }

  async function killProject(projectKey: string) {
    const targets = servers.filter((s) => s.projectKey === projectKey);
    if (targets.length === 0) return;
    const projectName = targets[0].projectName;
    const confirmed = await confirmAlert({
      title: `Kill all servers for ${projectName}?`,
      message: `This will stop ${targets.length} server${targets.length > 1 ? "s" : ""}.`,
      primaryAction: {
        title: "Kill",
        style: Alert.ActionStyle.Destructive,
      },
      rememberUserChoice: true,
    });
    if (!confirmed) return;
    try {
      await mutate(
        (async () => {
          await Promise.all(targets.map((s) => killProcess(s.pid)));
        })(),
        {
          optimisticUpdate: (current) =>
            (current ?? []).filter((s) => s.projectKey !== projectKey),
          rollbackOnError: true,
        },
      );
      pokeMenuBar();
    } catch (err) {
      await showFailureToast(err, {
        title: `Failed to kill servers for ${projectName}`,
      });
    }
  }

  async function killAll() {
    if (servers.length === 0) return;
    const confirmed = await confirmAlert({
      title: "Kill all dev servers?",
      message: `This will stop all ${servers.length} running server${servers.length > 1 ? "s" : ""} across every project.`,
      primaryAction: {
        title: "Kill All",
        style: Alert.ActionStyle.Destructive,
      },
      // Intentionally NO rememberUserChoice. The nuclear option always confirms.
    });
    if (!confirmed) return;
    try {
      await mutate(
        (async () => {
          await Promise.all(servers.map((s) => killProcess(s.pid)));
        })(),
        {
          optimisticUpdate: () => [],
          rollbackOnError: true,
        },
      );
      pokeMenuBar();
    } catch (err) {
      await showFailureToast(err, { title: "Failed to kill all servers" });
    }
  }

  async function restart(server: DevServer) {
    // Snapshot the project's server count BEFORE killing the old one so we
    // can detect when a new server has bound a port. We use serversRef.current
    // so we always see the latest state across the polling loop. The pid set
    // (excluding the one we're about to kill) lets us single out the
    // replacement afterwards so we can move the cursor onto it.
    const priorPids = new Set(
      serversRef.current
        .filter((s) => s.cwd === server.cwd && s.pid !== server.pid)
        .map((s) => s.pid),
    );
    const baseline = priorPids.size;
    // Same log baseline the spawn flow takes: a restart respawns through
    // startDevServer, so it fails for the same nameable reasons and deserves
    // the same diagnosis instead of a bare file path.
    let logStart = 0;
    try {
      logStart = fs.statSync(spawnLogPath(server.cwd)).size;
    } catch {
      // No log yet; the respawn writes from byte 0.
    }
    try {
      await mutate(restartServer(server), {
        optimisticUpdate: (current) =>
          (current ?? []).filter((s) => s.pid !== server.pid),
        rollbackOnError: false,
      });
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Restarting…",
        message: server.projectName,
      });
      // Poll at staggered intervals up to ~10s. Bail early as soon as the
      // server count for this project rises above baseline (new port bound).
      const delays = [1000, 2000, 3000, 4000];
      let restored = false;
      for (const delay of delays) {
        await new Promise((r) => setTimeout(r, delay));
        await revalidate();
        const current = serversRef.current.filter(
          (s) => s.cwd === server.cwd,
        ).length;
        if (current > baseline) {
          restored = true;
          break;
        }
      }
      if (restored) {
        toast.style = Toast.Style.Success;
        toast.title = "Restarted";
        // Focus the replacement: the cwd's server whose pid wasn't running
        // before the kill. Falls back to any current server for the cwd in the
        // unlikely case the new pid matches a prior one (pid reuse).
        const sameCwd = serversRef.current.filter((s) => s.cwd === server.cwd);
        const replacement =
          sameCwd.find((s) => !priorPids.has(s.pid)) ?? sameCwd[0];
        if (replacement) setSelectedItemId(String(replacement.pid));
        pokeMenuBar();
      } else {
        const reason = diagnoseSpawnFailure(server.cwd, logStart);
        const failure = reason ? SPAWN_FAILURE[reason] : undefined;
        // Same way in as the spawn watchdog, rather than making the user
        // hunt through tmpdir for the path we used to print.
        const viewLog: Toast.ActionOptions = {
          title: "View Startup Log",
          onAction: (t) => {
            t.hide().catch(() => {});
            push(<SpawnLogView cwd={server.cwd} name={server.projectName} />);
          },
        };
        toast.style = Toast.Style.Failure;
        toast.title = failure ? failure.title : "Restart timed out";
        // message stays as the project name set on the "Restarting…" toast.
        toast.primaryAction = failure?.fix
          ? copyFixAction(failure.fix)
          : viewLog;
        toast.secondaryAction = failure?.fix ? viewLog : undefined;
      }
    } catch (err) {
      await showFailureToast(err, {
        title: `Failed to restart ${server.projectName}`,
      });
    }
  }

  const terminalApp = prefs.terminalApp ?? DEFAULT_TERMINAL;
  const editorApp = prefs.editorApp;
  // Resolved once per mount; a Wi-Fi change mid-session is rare enough that
  // reopening the command is an acceptable refresh.
  const lanIp = useMemo(lanIPv4, []);
  const [toolFilter, setToolFilter] = useState<string>("all");

  // Visibility prefs default to true so first-time users see everything.
  // Raycast returns `undefined` for an unset checkbox on first launch.
  const show: RowVisibility = {
    branch: prefs.showBranch ?? true,
    uptime: prefs.showUptime ?? true,
    tool: prefs.showTool ?? true,
    localUrl: prefs.showLocalUrl ?? true,
  };

  // Manual refresh: useCachedPromise's revalidate is silent because
  // keepPreviousData keeps the list rendered. Show a brief animated toast so
  // the user knows their ⌘R actually did something.
  async function refresh() {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Refreshing…",
    });
    try {
      await revalidate();
      toast.style = Toast.Style.Success;
      toast.title = "Refreshed";
    } catch (err) {
      await showFailureToast(err, { title: "Refresh failed" });
    }
  }

  // Unique tools currently visible. Drives the dropdown options.
  const availableTools = useMemo(() => {
    const seen = new Set<string>();
    for (const s of servers) seen.add(s.tool);
    return Array.from(seen).sort();
  }, [servers]);

  const visible =
    toolFilter === "all"
      ? servers
      : servers.filter((s) => s.tool === toolFilter);

  // Newest first, both within a section and across sections. `ps` hands us
  // PID order, which only loosely tracks start time and wraps around, so a
  // server started an hour ago can outrank one started seconds ago.
  //
  // Recency is what makes the Starting section read as one continuous place:
  // a pending row at the top hands off to a server row immediately below it,
  // instead of the new server being flung to wherever its PID happens to sort.
  //
  // PID breaks ties on purpose. `ps lstart` resolves only to the second, so a
  // multi-target start produces identical timestamps, and a comparator that
  // returned 0 there would leave those rows free to swap places on every poll.
  // An unparseable lstart yields NaN, which is falsy, so it also falls through
  // to PID rather than ordering at random.
  const byRecency = (a: DevServer, b: DevServer) =>
    b.startedAt.getTime() - a.startedAt.getTime() || b.pid - a.pid;

  // Group by projectKey (git common-dir for git projects, cwd otherwise) so
  // sibling worktrees of the same repo collapse into one section. Each row
  // still carries its own cwd/branch so per-row actions stay correct. A
  // section sorts by its newest server, so starting one server promotes its
  // whole project.
  const grouped = Object.entries(
    visible.reduce(
      (acc, s) => {
        (acc[s.projectKey] ??= []).push(s);
        return acc;
      },
      {} as Record<string, DevServer[]>,
    ),
  )
    .map(
      ([key, list]) =>
        [key, [...list].sort(byRecency)] as [string, DevServer[]],
    )
    .sort(([, a], [, b]) => byRecency(a[0], b[0]));

  // Which pending starts still deserve a row. Derived every render, never
  // stored: an entry shows only while its cwd is absent from `servers`.
  // Reading the same array the server rows are built from is what makes the
  // handoff atomic, since the synthetic row can only vanish in the very
  // render that lists the real one. If this were a stored flag there would be
  // a frame with neither row, and selection would jump to a stranger.
  const visiblePending = [...pendingStarts].filter(
    ([cwd]) => !servers.some((s) => s.cwd === cwd),
  );

  // Hand the cursor across the same handoff the rows make, in render, for the
  // same reason the rows are derived: an effect runs *after* the commit that
  // dropped the pending row, so for one frame `selectedItemId` names a row
  // that no longer exists. Raycast reacts to that by picking a row itself and
  // reporting it through onSelectionChange, which lands in our state and wins
  // over whatever the effect set a moment later. Resolving it here means the
  // id never dangles, so there is nothing for Raycast to correct.
  //
  // Following the row the cursor is actually on also beats jumping to the
  // first of a batch: with several starting at once, the user is watching a
  // specific one.
  const selectedPendingCwd = selectedItemId?.startsWith(PENDING_ID_PREFIX)
    ? selectedItemId.slice(PENDING_ID_PREFIX.length)
    : undefined;
  const landed = selectedPendingCwd
    ? servers.find((s) => s.cwd === selectedPendingCwd)
    : undefined;
  const effectiveSelectedItemId = landed ? String(landed.pid) : selectedItemId;

  return (
    <List
      isLoading={effectiveLoading}
      searchBarPlaceholder="Filter servers..."
      // Search still filters natively, but the Starting section stays put:
      // a start in flight is the thing the user is waiting on, so a query
      // must not demote it below the servers already running.
      filtering={{ keepSectionOrder: true }}
      selectedItemId={effectiveSelectedItemId}
      onSelectionChange={(id) => setSelectedItemId(id ?? undefined)}
      searchBarAccessory={
        availableTools.length > 1 ? (
          <List.Dropdown
            tooltip="Filter by tool"
            value={toolFilter}
            onChange={setToolFilter}
          >
            <List.Dropdown.Item title="All Tools" value="all" />
            <List.Dropdown.Section>
              {availableTools.map((tool) => (
                <List.Dropdown.Item
                  key={tool}
                  title={toolLabel(tool)}
                  value={tool}
                />
              ))}
            </List.Dropdown.Section>
          </List.Dropdown>
        ) : undefined
      }
    >
      {servers.length === 0 &&
        visiblePending.length === 0 &&
        !effectiveLoading && (
          <List.EmptyView
            title="No Dev Servers Running"
            description={`Refreshing every ${prefs.refreshInterval}s.`}
            actions={
              <ActionPanel>
                <Action
                  title="Start Dev Server"
                  icon={Icon.Play}
                  onAction={openStartCommand}
                />
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={refresh}
                />
                <Action
                  title="Open Extension Preferences"
                  icon={Icon.Gear}
                  onAction={openExtensionPreferences}
                />
              </ActionPanel>
            }
          />
        )}
      {visiblePending.length > 0 && (
        <List.Section title="Starting">
          {visiblePending.map(([cwd, entry]) => (
            <PendingItem
              key={pendingRowId(cwd)}
              // Namespaced so a synthetic id can never collide with a server
              // row's, which is a bare pid.
              id={pendingRowId(cwd)}
              cwd={cwd}
              entry={entry}
              terminalApp={terminalApp}
              onDismiss={() => dismissPending(cwd)}
            />
          ))}
        </List.Section>
      )}
      {grouped.map(([projectKey, projectServers]) => (
        <List.Section
          key={projectKey}
          title={
            // When showFullPath is on, use the first row's cwd as a concrete
            // path hint. (For multi-worktree sections the per-row branch tag
            // and its tooltip distinguish which worktree each row belongs to.)
            prefs.showFullPath
              ? projectServers[0].cwd
              : projectServers[0].projectName
          }
          subtitle={`${projectServers.length} server${projectServers.length > 1 ? "s" : ""}`}
        >
          {projectServers.map((server) => (
            <ServerItem
              key={server.pid}
              id={String(server.pid)}
              server={server}
              terminalApp={terminalApp}
              editorApp={editorApp}
              lanIp={lanIp}
              show={show}
              onKill={() => kill(server.pid)}
              onKillProject={() => killProject(projectKey)}
              onKillAll={killAll}
              onRestart={() => restart(server)}
              onRefresh={refresh}
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
}
