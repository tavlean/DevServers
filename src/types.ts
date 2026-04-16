export interface DevServer {
  pid: number;
  port: string;
  url: string; // http://localhost:PORT
  tool: string; // vite | next | webpack | etc.
  cwd: string; // /Users/tav/Dev/MyProject
  projectName: string; // MyProject
  startedAt: Date;
}
