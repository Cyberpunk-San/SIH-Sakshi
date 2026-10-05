import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { Genesis } from "@/lib/core/ledger";
import { verifyGenesis } from "@/lib/core/ledger";
import { unlockIdentity, type KeyFile } from "@/lib/core/keyfile";
import type { Identity } from "@/lib/core/pq";

// Resolved at runtime only; `turbopackIgnore` keeps the bundler from tracing the data directory.
export const DATA_DIR = path.resolve(process.env.SAKSHI_DATA ?? path.join(/* turbopackIgnore: true */ process.cwd(), "data"));
export const VAULT_DIR = path.join(DATA_DIR, "vault");
export const GATEWAY_DIR = path.join(DATA_DIR, "gateway");
export const WM_URL = process.env.SAKSHI_WM_URL ?? "http://127.0.0.1:7200";

function readSecret(name: string): string {
  const p = path.join(DATA_DIR, "secrets", name);
  if (!fs.existsSync(p)) throw new Error(`missing secret ${name}: run \`npm run setup\``);
  return fs.readFileSync(p, "utf8").trim();
}

type Cache = { genesis?: Genesis; identity?: Promise<Identity>; secrets?: { internal: string; session: string } };
const g = globalThis as unknown as { __sakshi?: Cache };
const cache: Cache = (g.__sakshi ??= {});

export function getGenesis(): Genesis {
  if (!cache.genesis) {
    const p = path.join(DATA_DIR, "genesis.json");
    if (!fs.existsSync(p)) throw new Error("network not initialised: run `npm run setup`");
    const genesis = JSON.parse(fs.readFileSync(p, "utf8")) as Genesis;
    const v = verifyGenesis(genesis);
    if (!v.ok) throw new Error(`genesis invalid: ${v.reason}`);
    cache.genesis = genesis;
  }
  return cache.genesis;
}

export function gatewayIdentity(): Promise<Identity> {
  if (!cache.identity) {
    const kf = JSON.parse(fs.readFileSync(path.join(GATEWAY_DIR, "key.json"), "utf8")) as KeyFile;
    const pass = process.env.SAKSHI_GATEWAY_PASSPHRASE ?? readSecret("gateway.pass");
    cache.identity = unlockIdentity(kf, pass);
    cache.identity.catch(() => (cache.identity = undefined));
  }
  return cache.identity;
}

export function secrets() {
  if (!cache.secrets) cache.secrets = { internal: readSecret("internal.token"), session: readSecret("session.key") };
  return cache.secrets;
}
