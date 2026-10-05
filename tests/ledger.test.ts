// Ledger fault-tolerance tests on a private 4-validator network (ports 7301-7304).
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unlockIdentity, type KeyFile } from "../src/lib/core/keyfile";
import { generateIdentity, sign, type Identity } from "../src/lib/core/pq";
import { signTx, txId, type Genesis, type Tx } from "../src/lib/core/ledger";
import { ENROL_DOMAIN, enrolPayload } from "../src/lib/core/state";
import { toB64 } from "../src/lib/core/bytes";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "sakshi-ledger-test-"));
const procs = new Map<string, ChildProcess>();
let genesis: Genesis;
let registrar: Identity;

const url = (id: string) => genesis.body.validators.find((v) => v.id === id)!.url;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startNode(id: string) {
  const p = spawn(process.execPath, ["--import", "tsx", "ledger/node.ts", "--id", id], {
    env: { ...process.env, SAKSHI_DATA: DATA, SAKSHI_BIND: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout!.resume();
  p.stderr!.resume();
  procs.set(id, p);
}

async function stopNode(id: string) {
  const p = procs.get(id);
  if (!p) return;
  const done = new Promise((r) => p.once("exit", r));
  p.kill();
  await done;
  procs.delete(id);
}

async function status(id: string) {
  const r = await fetch(`${url(id)}/status`, { signal: AbortSignal.timeout(1500) });
  return r.json();
}

async function waitFor(cond: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond().catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}

async function submit(tx: Tx, via = "v1") {
  const r = await fetch(`${url(via)}/tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j.txId as string;
}

const committed = (id: string, node: string) => async () => (await (await fetch(`${url(node)}/tx?id=${id}`)).json()).status === "committed";

let n = 0;
function certTx(): Tx {
  const u = generateIdentity();
  const userId = `user-${++n}-${Date.now() % 100000}`;
  const dsaPk = toB64(u.dsa.publicKey);
  const kemPk = toB64(u.kem.publicKey);
  const base = { userId, name: "Test User", org: "QA", dsaPk, kemPk };
  const popSig = toB64(sign(u.dsa.secretKey, ENROL_DOMAIN, enrolPayload(base)));
  const now = Date.now();
  return signTx("CERT_ISSUE", { ...base, roles: ["recipient"], issuedAt: now, expiresAt: now + 86400_000, popSig }, "registrar", registrar.dsa.secretKey);
}

before(async () => {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/setup.ts", "--base-port", "7301"], { env: { ...process.env, SAKSHI_DATA: DATA } });
  genesis = JSON.parse(fs.readFileSync(path.join(DATA, "genesis.json"), "utf8"));
  const kf = JSON.parse(fs.readFileSync(path.join(DATA, "bootstrap", "registrar.sakshikey"), "utf8")) as KeyFile;
  registrar = await unlockIdentity(kf, fs.readFileSync(path.join(DATA, "bootstrap", "registrar.pass"), "utf8").trim());
  for (const v of genesis.body.validators) startNode(v.id);
  assert.ok(await waitFor(async () => (await Promise.all(["v1", "v2", "v3", "v4"].map(status))).length === 4, 20000), "nodes did not start");
});

after(async () => {
  for (const id of [...procs.keys()]) await stopNode(id);
  fs.rmSync(DATA, { recursive: true, force: true });
});

test("transactions commit with a 4/4 quorum and replicate to all nodes", async () => {
  const id = await submit(certTx());
  assert.ok(await waitFor(committed(id, "v1"), 10000));
  for (const v of ["v2", "v3", "v4"]) assert.ok(await waitFor(committed(id, v), 5000), `${v} missing tx`);
});

test("invalid transactions are rejected (forged registrar signature)", async () => {
  const tx = certTx();
  const forged = { ...tx, body: { ...tx.body, roles: ["investigator"] } } as Tx;
  await assert.rejects(submit(forged), /signature/);
});

test("liveness with one validator down (3 of 4)", async () => {
  await stopNode("v2");
  const id = await submit(certTx(), "v1");
  assert.ok(await waitFor(committed(id, "v1"), 20000), "did not commit with 3/4 validators");
});

test("fails safe with two validators down (no quorum, nothing commits)", async () => {
  await stopNode("v3");
  const id = await submit(certTx(), "v1");
  assert.equal(await waitFor(committed(id, "v1"), 6000), false);
  startNode("v3");
  assert.ok(await waitFor(committed(id, "v1"), 30000), "did not recover after quorum returned");
});

test("a node tampered with while offline detects it on restart and re-syncs from peers", async () => {
  // v2 has been down; it must catch up, then we stop it, forge its file and restart.
  startNode("v2");
  const h = (await status("v1")).height;
  assert.ok(await waitFor(async () => (await status("v2")).height >= h, 20000), "v2 did not catch up");
  await stopNode("v2");
  const file = path.join(DATA, "nodes", "v2", "chain.jsonl");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const b = JSON.parse(lines[0]);
  b.txs[0].body.name = "Forged Name";
  lines[0] = JSON.stringify(b);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  startNode("v2");
  assert.ok(await waitFor(async () => (await status("v2")).height >= h, 30000), "v2 did not heal");
  const s = await status("v2");
  assert.ok(s.incidents.some((i: { kind: string }) => i.kind === "CHAIN_TAMPERED"));
  assert.equal(s.headHash, (await status("v1")).headHash);
  assert.ok(!fs.readFileSync(file, "utf8").includes("Forged Name"));
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes("tampered")), "evidence file kept");
});

test("tx ids are content-addressed", () => {
  const tx = certTx();
  assert.equal(txId(tx), txId(JSON.parse(JSON.stringify(tx))));
});
