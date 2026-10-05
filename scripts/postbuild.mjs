// Completes the standalone server bundle: Next leaves static assets out of it.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const out = path.join(root, ".next", "standalone");
if (!fs.existsSync(out)) process.exit(0);
fs.cpSync(path.join(root, ".next", "static"), path.join(out, ".next", "static"), { recursive: true });
if (fs.existsSync(path.join(root, "public"))) fs.cpSync(path.join(root, "public"), path.join(out, "public"), { recursive: true });
if (fs.existsSync(path.join(out, "data"))) throw new Error("runtime data leaked into the build output");
console.log("standalone bundle ready:", path.relative(root, out));
