import {
  Action,
  ActionPanel,
  Color,
  Icon,
  Image,
  List,
  Toast,
  getPreferenceValues,
  showToast,
} from "@raycast/api";
import { useExec } from "@raycast/utils";
import { useEffect, useState } from "react";
import {
  FETCH_SCRIPT,
  killProcess,
  parseServers,
  restartServer,
} from "./servers";
import { DevServer } from "./types";

interface Preferences {
  showFullPath: boolean;
  refreshInterval: string;
}

function formatUptime(startedAt: Date): string {
  const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  if (isNaN(seconds) || seconds < 0) return "?";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function toolColor(tool: string): Color {
  const colors: Record<string, Color> = {
    vite: Color.Purple,
    next: Color.SecondaryText,
    nuxt: Color.Green,
    astro: Color.Purple,
    webpack: Color.Blue,
    svelte: Color.Orange,
    sveltekit: Color.Orange,
    parcel: Color.Yellow,
    gatsby: Color.Purple,
    remix: Color.Magenta,
    turbo: Color.Blue,
    esbuild: Color.Yellow,
    node: Color.Green,
  };
  return colors[tool.toLowerCase()] ?? Color.Blue;
}

// Fetches the page HTML and extracts the href from the first <link rel="icon"> tag.
// Falls back to undefined if the page doesn't respond or has no icon link.
async function detectFaviconUrl(port: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: controller.signal,
    });
    const html = await res.text();
    const linkTags = html.match(/<link[^>]+>/gi) ?? [];
    for (const tag of linkTags) {
      if (/rel=["'][^"']*icon[^"']*["']/i.test(tag)) {
        const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
        if (hrefMatch) {
          const href = hrefMatch[1];
          return href.startsWith("http")
            ? href
            : `http://localhost:${port}${href.startsWith("/") ? href : `/${href}`}`;
        }
      }
    }
  } catch {
    // Server didn't respond or aborted — fall through to globe
  } finally {
    clearTimeout(timeout);
  }
  return undefined;
}

interface ServerItemProps {
  server: DevServer;
  showFullPath: boolean;
  onKill: () => void;
  onKillProject: () => void;
  onKillAll: () => void;
  onRestart: () => void;
}

function ServerItem({
  server,
  onKill,
  onKillProject,
  onKillAll,
  onRestart,
}: ServerItemProps) {
  const [icon, setIcon] = useState<Image.ImageLike>({
    source: Icon.Globe,
    tintColor: toolColor(server.tool),
  });

  useEffect(() => {
    let cancelled = false;
    detectFaviconUrl(server.port).then((url) => {
      if (!cancelled && url) setIcon({ source: url, fallback: Icon.Globe });
    });
    return () => {
      cancelled = true;
    };
  }, [server.port]);

  return (
    <List.Item
      icon={icon}
      title={`localhost:${server.port}`}
      accessories={[
        {
          text: formatUptime(server.startedAt),
          tooltip: `Started ${server.startedAt.toLocaleString()}`,
        },
        // Show the runtime tag only when it adds new information.
        // If the framework tag is already "bun", a second "bun" tag is just noise.
        ...(server.runtime === "bun" && server.tool !== "bun"
          ? [
              {
                tag: { value: "bun", color: Color.Yellow },
                tooltip: "Listening process is running on the Bun runtime",
              },
            ]
          : []),
        { tag: { value: server.tool, color: toolColor(server.tool) } },
      ]}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser url={server.url} title="Open in Browser" />
          <Action
            title="Kill"
            icon={Icon.Stop}
            style={Action.Style.Destructive}
            shortcut={{ modifiers: ["cmd"], key: "d" }}
            onAction={onKill}
          />
          {/* CopyToClipboard already uses Cmd+C by default */}
          <Action.CopyToClipboard title="Copy URL" content={server.url} />
          <Action
            title="Restart Server"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
            onAction={onRestart}
          />
          <ActionPanel.Section>
            <Action
              title="Kill All for Project"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
              onAction={onKillProject}
            />
            <Action
              title="Kill All Servers"
              icon={Icon.XMarkCircle}
              style={Action.Style.Destructive}
              shortcut={{ modifiers: ["cmd", "opt"], key: "d" }}
              onAction={onKillAll}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();

  const {
    isLoading,
    data: servers = [],
    mutate,
    revalidate,
  } = useExec("/bin/zsh", ["-c", FETCH_SCRIPT], {
    parseOutput: ({ stdout }) => parseServers(stdout),
    keepPreviousData: true,
  });

  useEffect(() => {
    const id = setInterval(revalidate, parseInt(prefs.refreshInterval) * 1000);
    return () => clearInterval(id);
  }, [prefs.refreshInterval, revalidate]);

  async function kill(pid: number) {
    await mutate(killProcess(pid), {
      optimisticUpdate: (current) =>
        (current ?? []).filter((s) => s.pid !== pid),
      rollbackOnError: true,
    });
  }

  async function killProject(cwd: string) {
    const targets = servers.filter((s) => s.cwd === cwd);
    await mutate(
      Promise.all(targets.map((s) => killProcess(s.pid))).then(() => {}),
      {
        optimisticUpdate: (current) =>
          (current ?? []).filter((s) => s.cwd !== cwd),
        rollbackOnError: true,
      },
    );
  }

  async function killAll() {
    await mutate(
      Promise.all(servers.map((s) => killProcess(s.pid))).then(() => {}),
      {
        optimisticUpdate: () => [],
        rollbackOnError: true,
      },
    );
  }

  async function restart(server: DevServer) {
    await mutate(restartServer(server), {
      optimisticUpdate: (current) =>
        (current ?? []).filter((s) => s.pid !== server.pid),
      rollbackOnError: false,
      shouldRevalidateAfter: false,
    });
    await showToast({
      style: Toast.Style.Animated,
      title: "Restarting…",
      message: server.projectName,
    });
    setTimeout(revalidate, 3000);
  }

  const grouped = Object.entries(
    servers.reduce(
      (acc, s) => {
        (acc[s.cwd] ??= []).push(s);
        return acc;
      },
      {} as Record<string, DevServer[]>,
    ),
  );

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter servers...">
      {servers.length === 0 && !isLoading && (
        <List.EmptyView
          title="No dev servers running"
          description="Start a dev server and it will appear here."
        />
      )}
      {grouped.map(([cwd, projectServers]) => (
        <List.Section
          key={cwd}
          title={prefs.showFullPath ? cwd : projectServers[0].projectName}
          subtitle={`${projectServers.length} server${projectServers.length > 1 ? "s" : ""}`}
        >
          {projectServers.map((server) => (
            <ServerItem
              key={server.pid}
              server={server}
              showFullPath={prefs.showFullPath}
              onKill={() => kill(server.pid)}
              onKillProject={() => killProject(cwd)}
              onKillAll={killAll}
              onRestart={() => restart(server)}
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
}
