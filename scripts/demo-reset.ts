/**
 * Wipes the demo network and creates a fresh one (stop the demo stack first).
 *
 *   npm run demo:reset
 *   SAKSHI_DATA=demo/data npm run stack          # then, in another terminal:
 *   npm run demo:seed && npm run demo:visuals && npm run demo:capture
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEMO = path.resolve("demo");
for (const d of ["data", "keys", "delivered", "leak", "evidence", "assets", "demo-state.json"]) {
  fs.rmSync(path.join(DEMO, d), { recursive: true, force: true });
}
execFileSync(process.execPath, ["--import", "tsx", "scripts/setup.ts", "--network", "sakshi-demo"], {
  env: { ...process.env, SAKSHI_DATA: path.join(DEMO, "data") },
  stdio: "inherit",
});
console.log("Fresh demo network in demo/data. Start it with SAKSHI_DATA=demo/data npm run stack, then npm run demo:seed.");
