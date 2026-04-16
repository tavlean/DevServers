import { exec } from "child_process";
import { promisify } from "util";
import { DevServer } from "./types";

const execAsync = promisify(exec);

// Grabs all listening ports once up front to avoid repeated lsof calls,
// then iterates over node_modules/.bin/ processes to emit one pipe-delimited
// line per server: PID|PORT|CWD|STARTED|TOOL
//
// Uses `while read -r PID` (not `for PID in $PIDS`) to correctly iterate in zsh,
// where unquoted variable expansion does not word-split on newlines.
//
// lstart format: "Wed Apr 16 10:23:45 2026" — V8 parses this correctly via new Date().
// Known gap: bun dev / bunx processes don't match node_modules/.bin/ and are not detected.
export const FETCH_SCRIPT = `
PORTS=$(lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null | awk 'NR>1 {n=split($9,a,":"); print $2, a[n]}')
ps aux | grep 'node_modules/.bin/' | grep -v grep | awk '{print $2}' | while read -r PID; do
  CMD=$(ps -p $PID -o command= 2>/dev/null) || continue
  PORT=$(echo "$PORTS" | awk -v p=$PID '$1==p {print $2; exit}')
  CWD=$(lsof -p $PID -a -d cwd 2>/dev/null | awk 'NR>1 {print $NF}')
  STARTED=$(ps -p $PID -o lstart= 2>/dev/null)
  TOOL=$(echo "$CMD" | grep -oE 'node_modules/.bin/[^ ]+' | xargs basename 2>/dev/null)
  # SvelteKit runs under vite — detect it by the presence of svelte.config in the project root
  if [[ "$TOOL" == "vite" && (-f "$CWD/svelte.config.js" || -f "$CWD/svelte.config.ts") ]]; then
    TOOL="sveltekit"
  fi
  echo "$PID|$PORT|$CWD|$STARTED|$TOOL"
done
`;

export function parseServers(stdout: string): DevServer[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, port, cwd, started, tool] = line.split("|");
      return {
        pid: parseInt(pid),
        port,
        url: `http://localhost:${port}`,
        tool: tool?.trim() || "node",
        cwd,
        projectName: cwd?.split("/").pop() || cwd,
        startedAt: new Date(started?.trim() ?? ""),
      };
    })
    .filter((s) => s.port && !isNaN(s.pid));
}

export async function killProcess(pid: number): Promise<void> {
  await execAsync(`kill ${pid}`);
}

// Restart assumes npm run dev. Won't work for yarn dev, bun dev, npm start, etc.
// The UI shows a toast that communicates this limitation.
export async function restartServer(server: DevServer): Promise<void> {
  await execAsync(`kill ${server.pid}`);
  await execAsync(
    `cd "${server.cwd}" && nohup npm run dev > /tmp/dev-servers-restart-${server.pid}.log 2>&1 &`,
  );
}
