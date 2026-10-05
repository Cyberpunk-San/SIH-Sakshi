/**
 * Starts the whole air-gapped stack on one machine:
 *   4 validator nodes, the watermark engine and (unless --no-web) the web gateway.
 *
 *   npm run stack            # production web build (run `npm run build` first)
 *   npm run stack:dev        # next dev
 *   npm run ledger           # validators + watermark engine only
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DATA = path.resolve(process.env.SAKSHI_DATA ?? path.join(process.cwd(), "data"));
const args = process.argv.slice(2);
const noWeb = args.includes("--no-web");
const dev = args.includes("--dev");
const only = args.includes("--nodes") ? args[args.indexOf("--nodes") + 1].split(",") : null;

if (!fs.existsSync(path.join(DATA, "genesis.json"))) {
  console.error("No network found. Run `npm run setup` first.");
  process.exit(1);
}
const genesis = JSON.parse(fs.readFileSync(path.join(DATA, "genesis.json"), "utf8"));
const COLORS = [36, 33, 35, 34, 32, 31, 37];
const children: ChildProcess[] = [];

function run(name: string, color: number, cmd: string, cmdArgs: string[], env: Record<string, string> = {}, cwd = process.cwd()) {
  const child = spawn(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, shell: process.platform === "win32" });
  const prefix = `\x1b[${color}m${name.padEnd(7)}\x1b[0m│ `;
  const pipe = (s: NodeJS.ReadableStream) => {
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) process.stdout.write(prefix + l + "\n");
    });
  };
  pipe(child.stdout!);
  pipe(child.stderr!);
  child.on("exit", (code) => process.stdout.write(`${prefix}exited with code ${code}\n`));
  children.push(child);
}

genesis.body.validators.forEach((v: { id: string }, i: number) => {
  if (only && !only.includes(v.id)) return;
  run(v.id, COLORS[i % COLORS.length], "npx", ["tsx", "ledger/node.ts", "--id", v.id], { SAKSHI_DATA: DATA });
});

const python = process.env.SAKSHI_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
run("wm", 32, python, ["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", process.env.SAKSHI_WM_PORT ?? "7200", "--timeout-keep-alive", "75", "--log-level", "warning"], {
  SAKSHI_WM_KEY_FILE: path.join(DATA, "secrets", "wm.key"),
  SAKSHI_INTERNAL_TOKEN: fs.readFileSync(path.join(DATA, "secrets", "internal.token"), "utf8").trim(),
}, path.join(process.cwd(), "wm-engine"));

if (!noWeb) {
  const port = process.env.PORT ?? "3000";
  if (dev) {
    run("web", 37, "npx", ["next", "dev", "-p", port, "-H", "0.0.0.0"], { SAKSHI_DATA: DATA });
  } else {
    const server = path.join(process.cwd(), ".next", "standalone", "server.js");
    if (!fs.existsSync(server)) {
      console.error("No production build found. Run `npm run build` first (or use `npm run stack:dev`).");
      process.exit(1);
    }
    run("web", 37, process.execPath, [server], { SAKSHI_DATA: DATA, PORT: port, HOSTNAME: process.env.HOSTNAME ?? "0.0.0.0" });
  }
}

const shutdown = () => {
  for (const c of children) {
    if (c.pid && !c.killed) {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"]);
      else c.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
