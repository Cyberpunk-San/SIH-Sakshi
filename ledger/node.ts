/**
 * Sakshi validator node — permissioned BFT ledger (no public chain, no cloud).
 *
 *   npx tsx ledger/node.ts --id v1
 *
 * Consensus: rotating leader per (height, round). A block commits when ≥ quorum (2f+1)
 * validators sign it with ML-DSA-65; the signatures travel with the block as its commit
 * certificate (QC). Each validator signs at most one block per height (it "locks" on the
 * first valid proposal it votes for, and new leaders re-propose an existing lock), so two
 * conflicting blocks can never both reach quorum while ≤ f validators are Byzantine.
 * Liveness tolerates f crashed validators.
 *
 * Tamper evidence: blocks are hash-chained and quorum-signed. A node re-verifies its own
 * chain file continuously; any edit is detected, the damaged file is quarantined for
 * forensics and the chain is restored from memory/peers (whose QCs are verified).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { canonical, fromB64, sha256Hex, toB64, utf8 } from "../src/lib/core/bytes";
import {
  blockHash,
  buildHeader,
  countValidVotes,
  inclusionFor,
  signVote,
  txId,
  verifyBlockShape,
  verifyGenesis,
  type Block,
  type BlockHeader,
  type Genesis,
  type Tx,
  type Vote,
} from "../src/lib/core/ledger";
import { LedgerState } from "../src/lib/core/state";
import { unlockIdentity, type KeyFile } from "../src/lib/core/keyfile";
import { seal, sign, verify, type Identity } from "../src/lib/core/pq";
import { encodeShare, openValidatorShare } from "../src/lib/core/vault";

// ------------------------------------------------------------------ config

const args = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const NODE_ID: string = args.id ?? process.env.SAKSHI_NODE_ID ?? "";
const DATA = path.resolve(process.env.SAKSHI_DATA ?? path.join(process.cwd(), "data"));
const NODE_DIR = path.join(DATA, "nodes", NODE_ID);
const CHAIN_FILE = path.join(NODE_DIR, "chain.jsonl");
const RELEASES_FILE = path.join(NODE_DIR, "releases.json");
const INCIDENTS_FILE = path.join(NODE_DIR, "incidents.json");

const PROPOSE_DOMAIN = "sakshi/propose/v1";
const RELEASE_DOMAIN = "sakshi/release/v1";
const RELEASE_WINDOW_MS = 10 * 60 * 1000;
const MAX_BLOCK_TXS = 500;
const ROUND_TIMEOUT_MS = 3000;
const MAX_CLOCK_DRIFT_MS = 30_000;

if (!NODE_ID) {
  console.error("usage: tsx ledger/node.ts --id <validatorId>");
  process.exit(2);
}

const genesis: Genesis = JSON.parse(fs.readFileSync(path.join(DATA, "genesis.json"), "utf8"));
const gcheck = verifyGenesis(genesis);
if (!gcheck.ok) {
  console.error("genesis invalid:", gcheck.reason);
  process.exit(1);
}
const G = genesis.body;
const ME = G.validators.find((v) => v.id === NODE_ID);
if (!ME) {
  console.error(`validator ${NODE_ID} not in genesis`);
  process.exit(1);
}
const PEERS = G.validators.filter((v) => v.id !== NODE_ID);
const PORT = Number(new URL(ME.url).port);
const BIND = process.env.SAKSHI_BIND ?? "0.0.0.0";

function log(...a: unknown[]) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] [${NODE_ID}]`, ...a);
}

// ------------------------------------------------------------------ state

let identity: Identity;
let state = new LedgerState(genesis);
let blocks: Block[] = []; // blocks[0] is height 1
const lineHashes: string[] = []; // sha256 of each persisted line, for the integrity monitor
const mempool = new Map<string, Tx>();
// Gossiped txs that are not valid *yet* (e.g. a delivery whose decryption block this node has
// not applied). Re-checked after every new block so any honest leader can include them.
const deferred = new Map<string, { tx: Tx; at: number }>();
const locks = new Map<number, { block: Omit<Block, "qc">; round: number; polka: Vote[] }>(); // height -> my current lock
let round = 0;
let lastProgress = Date.now();
let proposing = false;
let integrity = { ok: true, lastCheck: 0, checkedBlocks: 0 };
type Incident = { at: number; kind: string; detail: string; quarantined?: string };
let incidents: Incident[] = [];
const releases: Record<string, number> = {};
const seenReleaseNonces = new Map<string, number>();

const height = () => blocks.length;
const headHash = () => (blocks.length ? blocks[blocks.length - 1].hash : genesis.chainId);
const headTime = () => (blocks.length ? blocks[blocks.length - 1].header.time : G.createdAt);
const leaderFor = (h: number, r: number) => G.validators[(h + r) % G.validators.length].id;

function recordIncident(kind: string, detail: string, quarantined?: string) {
  const inc = { at: Date.now(), kind, detail, quarantined };
  incidents = [...incidents.slice(-49), inc];
  fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(incidents, null, 2));
  log(`INCIDENT ${kind}: ${detail}`);
}

// ------------------------------------------------------------------ persistence

function serialise(b: Block): string {
  return JSON.stringify(b);
}

function appendBlock(b: Block) {
  const line = serialise(b);
  fs.appendFileSync(CHAIN_FILE, line + "\n");
  lineHashes.push(sha256Hex(line));
}

function rewriteChainFile() {
  const tmp = CHAIN_FILE + ".tmp";
  const lines = blocks.map(serialise);
  fs.writeFileSync(tmp, lines.map((l) => l + "\n").join(""));
  fs.renameSync(tmp, CHAIN_FILE);
  lineHashes.length = 0;
  lines.forEach((l) => lineHashes.push(sha256Hex(l)));
}

function quarantine(reason: string): string {
  const q = `${CHAIN_FILE}.tampered-${Date.now()}`;
  fs.copyFileSync(CHAIN_FILE, q);
  recordIncident("CHAIN_TAMPERED", reason, path.basename(q));
  return q;
}

/** Verify a block against current state and apply it (state is replaced only on success). */
function tryApply(b: Block, persist: boolean): string | null {
  const err = verifyBlockShape(genesis, b, headHash(), height() + 1);
  if (err) return err;
  if (b.header.time <= headTime()) return "block time does not advance";
  const next = state.clone();
  const terr = next.applyBlock(b.txs, b.header.height, b.header.time);
  if (terr) return terr;
  state = next;
  blocks.push(b);
  if (persist) appendBlock(b);
  for (const t of b.txs) {
    mempool.delete(txId(t));
    deferred.delete(txId(t));
  }
  locks.delete(b.header.height);
  for (const k of prevoted.keys()) if (Number(k.split(":")[0]) <= b.header.height) prevoted.delete(k);
  promoteDeferred();
  round = 0;
  lastProgress = Date.now();
  return null;
}

function promoteDeferred() {
  const now = Date.now();
  for (const [id, d] of deferred) {
    if (state.txIndex.has(id) || now - d.at > 120_000) {
      deferred.delete(id);
      continue;
    }
    if (!state.check(d.tx, now)) {
      mempool.set(id, d.tx);
      deferred.delete(id);
    }
  }
}

function loadChain() {
  fs.mkdirSync(NODE_DIR, { recursive: true });
  if (fs.existsSync(RELEASES_FILE)) Object.assign(releases, JSON.parse(fs.readFileSync(RELEASES_FILE, "utf8")));
  if (fs.existsSync(INCIDENTS_FILE)) incidents = JSON.parse(fs.readFileSync(INCIDENTS_FILE, "utf8"));
  if (!fs.existsSync(CHAIN_FILE)) {
    fs.writeFileSync(CHAIN_FILE, "");
    return;
  }
  const lines = fs.readFileSync(CHAIN_FILE, "utf8").split("\n").filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    let b: Block;
    try {
      b = JSON.parse(lines[i]);
    } catch {
      quarantine(`line ${i + 1} is not valid JSON`);
      rewriteChainFile();
      return;
    }
    const err = tryApply(b, false);
    if (err) {
      quarantine(`block #${i + 1} failed verification on startup: ${err}`);
      rewriteChainFile(); // keep the verified prefix; the rest is re-synced from peers
      return;
    }
    lineHashes.push(sha256Hex(lines[i]));
  }
  log(`loaded ${blocks.length} verified blocks, head ${headHash().slice(0, 12)}`);
}

/** Continuous self-audit: the on-disk chain must match the verified in-memory chain. */
function integrityCheck() {
  try {
    const lines = fs.readFileSync(CHAIN_FILE, "utf8").split("\n").filter(Boolean);
    let problem: string | null = null;
    if (lines.length < blocks.length) problem = `chain file truncated: ${lines.length} of ${blocks.length} blocks present`;
    for (let i = 0; i < Math.min(lines.length, blocks.length) && !problem; i++) {
      if (sha256Hex(lines[i]) !== lineHashes[i]) {
        let detail = `block #${i + 1} was modified on disk`;
        try {
          const forged = JSON.parse(lines[i]) as Block;
          const why = verifyBlockShape(genesis, forged, i === 0 ? genesis.chainId : blocks[i - 1].hash, i + 1);
          detail += why ? ` — ${why}` : " — content differs from the committed block";
        } catch {
          detail += " — not valid JSON";
        }
        problem = detail;
      }
    }
    if (!problem && lines.length > blocks.length) problem = `${lines.length - blocks.length} unexpected block(s) appended to the file`;
    if (problem) {
      quarantine(problem);
      rewriteChainFile();
      recordIncident("CHAIN_RESTORED", `restored ${blocks.length} verified blocks from memory`);
      integrity = { ok: false, lastCheck: Date.now(), checkedBlocks: blocks.length };
      setTimeout(() => (integrity.ok = true), 30_000); // stays red on dashboards for a while
    } else {
      integrity = { ...integrity, lastCheck: Date.now(), checkedBlocks: blocks.length };
    }
  } catch (e) {
    recordIncident("CHAIN_UNREADABLE", (e as Error).message);
    rewriteChainFile();
  }
}

// ------------------------------------------------------------------ networking

async function post<T>(url: string, body: unknown, timeoutMs = 4000): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error ?? r.statusText), { body: j });
  return j as T;
}

async function get<T>(url: string, timeoutMs = 4000): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

/**
 * Settle as soon as `enough(results)` is true, every promise has settled, or `ms` passes.
 * A dead or unreachable peer must never hold up a healthy quorum.
 */
function gather<T>(ps: Promise<T>[], enough: (r: T[]) => boolean, ms: number): Promise<T[]> {
  return new Promise((resolve) => {
    const results: T[] = [];
    let settled = 0;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(results);
      }
    };
    const timer = setTimeout(finish, ms);
    if (ps.length === 0 || enough(results)) return finish();
    for (const p of ps) {
      p.then((v) => results.push(v)).catch(() => {}).finally(() => {
        settled++;
        if (enough(results) || settled === ps.length) finish();
      });
    }
  });
}

function gossipTx(tx: Tx) {
  for (const p of PEERS) post(`${p.url}/gossip/tx`, { tx }, 2000).catch(() => {});
}

// ------------------------------------------------------------------ consensus
//
// Two-phase BFT in the style of Tendermint, driven by the round's leader:
//   1. PROPOSE   leader -> all: block (+ proof-of-lock when it re-proposes a locked block)
//   2. PREVOTE   each node signs at most one prevote per (height, round)
//   3. POLKA     >= quorum prevotes for one block in one round
//   4. PRECOMMIT a node shown a polka locks on that block and signs a commit vote;
//                >= quorum commit votes form the block's certificate (QC).
// A node locked on B prevotes another block only when shown a polka for it from a round at
// least as new as its lock. Commits stay unique (no forks with <= f Byzantine validators),
// and validators that locked on different proposals still converge after crashes.

type Unsigned = Omit<Block, "qc">;
type Lock = { block: Unsigned; round: number; polka: Vote[] };
type Proposal = { block: Unsigned; sig: string; pol?: { round: number; votes: Vote[] } };
type PrevoteReply = { prevote?: Vote; lock?: Lock; error?: string; behind?: boolean };
type PrecommitRequest = { block: Unsigned; round: number; polka: Vote[] };
type PrecommitReply = { vote?: Vote; error?: string };

const PREVOTE_DOMAIN = "sakshi/prevote/v1";
const prevoted = new Map<string, string>(); // "height:round" -> block hash I prevoted

function proposalMessage(b: Unsigned) {
  return canonical({ hash: b.hash, height: b.header.height, round: b.round, proposer: b.proposer });
}

function prevoteMessage(h: number, r: number, hash: string) {
  return `${genesis.chainId}:${h}:${r}:${hash}`;
}

function signPrevote(h: number, r: number, hash: string): Vote {
  return { validatorId: NODE_ID, sig: toB64(sign(identity.dsa.secretKey, PREVOTE_DOMAIN, prevoteMessage(h, r, hash))) };
}

function polkaSize(h: number, r: number, hash: string, votes: Vote[]): number {
  const msg = prevoteMessage(h, r, hash);
  const ok = new Set<string>();
  for (const v of votes ?? []) {
    const val = G.validators.find((x) => x.id === v.validatorId);
    if (val && !ok.has(val.id) && verify(fromB64(val.dsaPk), PREVOTE_DOMAIN, msg, fromB64(v.sig))) ok.add(val.id);
  }
  return ok.size;
}

/** Linkage, integrity and state-machine validity of a candidate for the next height. */
function checkCandidate(b: Unsigned): string | null {
  const h = b.header;
  if (h.chainId !== genesis.chainId || h.prevHash !== headHash()) return "does not extend my head";
  if (blockHash(h) !== b.hash) return "hash mismatch";
  if (h.time <= headTime()) return "block time does not advance";
  if (buildHeader(h.chainId, h.height, h.prevHash, h.time, b.txs).txRoot !== h.txRoot) return "txRoot mismatch";
  return state.clone().applyBlock(b.txs, h.height, h.time);
}

function heightGate(hgt: number): { error: string; behind?: boolean } | null {
  if (hgt <= height()) return { error: "stale height" };
  if (hgt > height() + 1) {
    void syncFromPeers();
    return { error: "behind", behind: true };
  }
  return null;
}

/** Voter, phase 1: prevote for a proposal, or explain why not. */
function handleProposal(p: Proposal): PrevoteReply {
  const b = p.block;
  const h = b.header;
  const proposer = G.validators.find((v) => v.id === b.proposer);
  if (!proposer) return { error: "unknown proposer" };
  if (leaderFor(h.height, b.round) !== b.proposer) return { error: "proposer is not the leader for this round" };
  if (!verify(fromB64(proposer.dsaPk), PROPOSE_DOMAIN, proposalMessage(b), fromB64(p.sig))) return { error: "bad proposer signature" };
  const gate = heightGate(h.height);
  if (gate) return gate;
  const key = `${h.height}:${b.round}`;
  const already = prevoted.get(key);
  if (already && already !== b.hash) return { error: "already prevoted another block in this round" };
  const lock = locks.get(h.height);
  const pol =
    p.pol && p.pol.round < b.round && polkaSize(h.height, p.pol.round, b.hash, p.pol.votes) >= G.quorum ? p.pol : undefined;
  if (lock && lock.block.hash !== b.hash && !(pol && pol.round >= lock.round)) return { lock };
  // A fresh block needs a sane timestamp; a block already vouched for by a lock or a polka may
  // be committed late, so it is exempt from the drift check.
  const vouched = (lock !== undefined && lock.block.hash === b.hash) || pol !== undefined;
  if (!vouched && Math.abs(h.time - Date.now()) > MAX_CLOCK_DRIFT_MS) return { error: "block time out of range" };
  const err = checkCandidate(b);
  if (err) return { error: err };
  prevoted.set(key, b.hash);
  return { prevote: signPrevote(h.height, b.round, b.hash) };
}

/** Voter, phase 2: shown a polka, lock on the block and sign the commit vote. */
function handlePrecommit(req: PrecommitRequest): PrecommitReply {
  const b = req.block;
  const gate = heightGate(b.header.height);
  if (gate) return { error: gate.error };
  if (polkaSize(b.header.height, req.round, b.hash, req.polka) < G.quorum) return { error: "no polka for this block" };
  const lock = locks.get(b.header.height);
  if (lock && lock.round > req.round && lock.block.hash !== b.hash) return { error: "locked on a newer polka" };
  const err = checkCandidate(b);
  if (err) return { error: err };
  locks.set(b.header.height, { block: { ...b, round: req.round }, round: req.round, polka: req.polka });
  return { vote: signVote(identity.dsa.secretKey, NODE_ID, b.header) };
}

function validLock(l: Lock | undefined, h: number): l is Lock {
  return (
    !!l &&
    l.block?.header?.height === h &&
    l.block.header.prevHash === headHash() &&
    polkaSize(h, l.round, l.block.hash, l.polka) >= G.quorum
  );
}

async function propose() {
  if (proposing) return;
  const h = height() + 1;
  // Pin the round: the round timer may tick while we wait for peers, and a proposal must
  // carry the round in which this node actually is the leader.
  const r = round;
  if (leaderFor(h, r) !== NODE_ID) return;
  proposing = true;
  try {
    // Re-propose the most recent polka anyone holds at this height, if any.
    const peerLocks = await gather(
      PEERS.map((p) => get<{ lock?: Lock }>(`${p.url}/consensus/lock?height=${h}`, 800)),
      (res) => res.length === PEERS.length,
      900,
    );
    const candidates = [locks.get(h), ...peerLocks.map((x) => x.lock)].filter((l): l is Lock => validLock(l, h));
    const best = candidates.sort((a, b) => b.round - a.round)[0];
    let header: BlockHeader;
    let txs: Tx[];
    if (best) {
      header = best.block.header;
      txs = best.block.txs;
    } else {
      if (mempool.size === 0) return;
      const scratch = state.clone();
      const time = Math.max(Date.now(), headTime() + 1);
      txs = [];
      for (const [id, tx] of mempool) {
        if (txs.length >= MAX_BLOCK_TXS) break;
        const err = scratch.check(tx, time);
        if (err) {
          mempool.delete(id);
          log(`dropped tx ${id.slice(0, 10)}: ${err}`);
          continue;
        }
        scratch.apply(tx, h, txs.length);
        txs.push(tx);
      }
      if (txs.length === 0) return;
      header = buildHeader(genesis.chainId, h, headHash(), time, txs);
    }
    if (height() + 1 !== h) return; // a commit arrived while we were preparing
    const unsigned: Unsigned = { header, hash: blockHash(header), txs, proposer: NODE_ID, round: r };
    const proposal: Proposal = {
      block: unsigned,
      sig: toB64(sign(identity.dsa.secretKey, PROPOSE_DOMAIN, proposalMessage(unsigned))),
      pol: best && best.round < r ? { round: best.round, votes: best.polka } : undefined,
    };

    // Phase 1: prevotes. Stop waiting as soon as a quorum has said yes.
    const mine = handleProposal(proposal);
    const prevotes: Vote[] = mine.prevote ? [mine.prevote] : [];
    const replies = await gather(
      PEERS.map((p) => post<PrevoteReply>(`${p.url}/consensus/propose`, proposal, 2000)),
      (res) => prevotes.length + res.filter((x) => x.prevote).length >= G.quorum,
      2100,
    );
    for (const x of replies) if (x.prevote) prevotes.push(x.prevote);
    if (polkaSize(h, r, unsigned.hash, prevotes) < G.quorum) return;

    // Phase 2: commit votes against the polka.
    const req: PrecommitRequest = { block: unsigned, round: r, polka: prevotes };
    const own = handlePrecommit(req);
    const votes: Vote[] = own.vote ? [own.vote] : [];
    const pre = await gather(
      PEERS.map((p) => post<PrecommitReply>(`${p.url}/consensus/precommit`, req, 2000)),
      (res) => votes.length + res.filter((x) => x.vote).length >= G.quorum,
      2100,
    );
    for (const x of pre) if (x.vote) votes.push(x.vote);
    const block: Block = { ...unsigned, qc: votes };
    if (countValidVotes(G, header, votes) < G.quorum) return;
    const err = tryApply(block, true);
    if (err) {
      if (height() < h) log("own commit failed:", err);
      return;
    }
    log(`committed #${h} (${txs.length} tx, ${votes.length}/${G.validators.length} votes, round ${r})`);
    for (const p of PEERS) post(`${p.url}/consensus/commit`, { block }, 4000).catch(() => {});
  } finally {
    proposing = false;
  }
}

let syncing = false;
async function syncFromPeers() {
  if (syncing) return;
  syncing = true;
  try {
    for (const p of PEERS) {
      const st = await get<{ height: number }>(`${p.url}/status`, 1500).catch(() => null);
      if (!st || st.height <= height()) continue;
      while (height() < st.height) {
        const { blocks: more } = await get<{ blocks: Block[] }>(`${p.url}/blocks?from=${height() + 1}&limit=200`, 8000);
        if (!more.length) break;
        for (const b of more) {
          if (b.header.height <= height()) continue; // arrived meanwhile via a commit message
          const err = tryApply(b, true);
          if (err) {
            recordIncident("PEER_REJECTED", `block #${b.header.height} from ${p.id} rejected: ${err}`);
            break;
          }
        }
        if (more.length < 200) break;
      }
      if (height() >= st.height) log(`synced to #${height()} from ${p.id}`);
    }
  } catch (e) {
    log("sync error:", (e as Error).message);
  } finally {
    syncing = false;
  }
}

function tick() {
  if (mempool.size > 0 || locks.has(height() + 1)) {
    if (Date.now() - lastProgress > ROUND_TIMEOUT_MS * (round + 1)) {
      round++;
      lastProgress = Date.now();
      log(`round timeout at height ${height() + 1}, moving to round ${round} (leader ${leaderFor(height() + 1, round)})`);
    }
    void propose();
  } else {
    lastProgress = Date.now();
    round = 0;
  }
}

// ------------------------------------------------------------------ key share release

type ReleaseRequest = { decryptTxId: string; nonce: string; at: number; sig: string };

async function handleRelease(req: ReleaseRequest) {
  const msg = canonical({ decryptTxId: req.decryptTxId, nonce: req.nonce, at: req.at, validator: NODE_ID });
  if (!verify(fromB64(G.gateway.dsaPk), RELEASE_DOMAIN, msg, fromB64(req.sig))) throw httpError(401, "request not signed by the gateway");
  if (Math.abs(Date.now() - req.at) > 60_000) throw httpError(400, "stale request");
  if (seenReleaseNonces.has(req.nonce)) throw httpError(409, "replayed request");
  seenReleaseNonces.set(req.nonce, Date.now());
  // The record may be committed by the quorum but not yet applied here (commit messages are
  // asynchronous). Catch up from peers for a moment before refusing.
  let rec = state.decrypts.get(req.decryptTxId);
  for (let i = 0; !rec && i < 15; i++) {
    if (i === 0) void syncFromPeers();
    await new Promise((r) => setTimeout(r, 200));
    rec = state.decrypts.get(req.decryptTxId);
  }
  if (!rec) throw httpError(404, "decryption record is not committed on this node");
  const committedAt = blocks[rec.height - 1].header.time;
  if (Date.now() - committedAt > RELEASE_WINDOW_MS) throw httpError(410, "release window for this session has expired");
  if (state.deliveries.has(req.decryptTxId)) throw httpError(409, "session already delivered");
  if (releases[req.decryptTxId]) throw httpError(409, "share already released for this session");
  const doc = state.docs.get(rec.body.docId)!;
  if (state.activeCert(rec.body.recipientId, Date.now()) === null) throw httpError(403, "recipient certificate is no longer active");
  const share = openValidatorShare(identity.kem.secretKey, doc.body.docId, NODE_ID, doc.body.validatorShares[NODE_ID]);
  const sealed = seal(fromB64(G.gateway.kemPk), encodeShare(share), "release", utf8(`${req.decryptTxId}/${NODE_ID}`));
  share.y.fill(0);
  releases[req.decryptTxId] = Date.now();
  fs.writeFileSync(RELEASES_FILE, JSON.stringify(releases));
  log(`released K_G share for session ${req.decryptTxId.slice(0, 10)} (${rec.body.recipientId})`);
  return { validatorId: NODE_ID, share: sealed };
}

// ------------------------------------------------------------------ HTTP API

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function findTx(id: string): { tx: Tx; block: Block } | null {
  const loc = state.txIndex.get(id);
  if (!loc) return null;
  const block = blocks[loc.height - 1];
  return { tx: block.txs[loc.index], block };
}

function proofFor(id: string) {
  const f = findTx(id);
  if (!f) return null;
  return { tx: f.tx, inclusion: inclusionFor(f.block, id) };
}

function stripDoc<T extends { body: { wrappedKeys?: unknown; validatorShares?: unknown } }>(d: T) {
  return { ...d, body: { ...d.body, wrappedKeys: undefined, validatorShares: undefined } };
}

type Handler = (url: URL, body: any) => unknown | Promise<unknown>;
const routes: Record<string, Handler> = {
  "GET /status": () => ({
    id: NODE_ID,
    name: ME.name,
    chainId: genesis.chainId,
    height: height(),
    headHash: headHash(),
    headTime: headTime(),
    round,
    leader: leaderFor(height() + 1, round),
    mempool: mempool.size,
    integrity,
    incidents: incidents.slice(-10),
    time: Date.now(),
  }),
  "GET /genesis": () => genesis,
  "GET /blocks": (u) => {
    const from = Math.max(1, Number(u.searchParams.get("from") ?? 1));
    const limit = Math.min(500, Number(u.searchParams.get("limit") ?? 50));
    return { blocks: blocks.slice(from - 1, from - 1 + limit) };
  },
  "GET /blocks/recent": (u) => {
    const limit = Math.min(100, Number(u.searchParams.get("limit") ?? 20));
    return {
      height: height(),
      blocks: blocks.slice(-limit).reverse().map((b) => ({
        header: b.header,
        hash: b.hash,
        proposer: b.proposer,
        round: b.round,
        votes: b.qc.map((v) => v.validatorId),
        txs: b.txs.map((t) => ({ id: txId(t), type: t.type, signer: t.signer })),
      })),
    };
  },
  "POST /tx": (_u, body) => {
    const tx = body?.tx as Tx;
    const err = state.check(tx, Date.now());
    if (err) throw httpError(400, err);
    const id = txId(tx);
    if (!mempool.has(id)) {
      mempool.set(id, tx);
      gossipTx(tx);
    }
    return { txId: id };
  },
  "POST /gossip/tx": (_u, body) => {
    const tx = body?.tx as Tx;
    const err = state.check(tx, Date.now());
    if (!err) mempool.set(txId(tx), tx);
    else if (err !== "duplicate transaction" && deferred.size < 5000) deferred.set(txId(tx), { tx, at: Date.now() });
    return { ok: true };
  },
  "GET /tx": (u) => {
    const id = u.searchParams.get("id") ?? "";
    const p = proofFor(id);
    if (p) return { status: "committed", ...p };
    if (mempool.has(id)) return { status: "pending" };
    return { status: "unknown" };
  },
  "GET /wm": (u) => {
    const id = state.wmIndex.get(u.searchParams.get("id") ?? "");
    if (!id) throw httpError(404, "watermark id not found on the ledger");
    return { decryptTxId: id };
  },
  "GET /state/summary": () => ({
    height: height(),
    certs: [...state.certs.values()].filter((c) => !c.revoked).length,
    revoked: [...state.certs.values()].filter((c) => c.revoked).length,
    docs: state.docs.size,
    decrypts: state.decrypts.size,
    deliveries: state.deliveries.size,
    queries: state.queries.size,
  }),
  "GET /state/certs": () => ({ certs: state.certHistory }),
  "GET /state/cert": (u) => {
    const c = state.certs.get(u.searchParams.get("userId") ?? "");
    if (!c) throw httpError(404, "no certificate");
    return c;
  },
  "GET /state/docs": (u) => {
    const r = u.searchParams.get("recipient");
    const s = u.searchParams.get("sender");
    const docs = [...state.docs.values()].filter((d) => (!r || d.body.recipients.includes(r)) && (!s || d.sender === s));
    return { docs: docs.map(stripDoc) };
  },
  "GET /state/doc": (u) => {
    const d = state.docs.get(u.searchParams.get("docId") ?? "");
    if (!d) throw httpError(404, "unknown document");
    return d;
  },
  "GET /state/decrypts": (u) => {
    const docId = u.searchParams.get("docId");
    const r = u.searchParams.get("recipient");
    const list = [...state.decrypts.values()].filter((d) => (!docId || d.body.docId === docId) && (!r || d.body.recipientId === r));
    return {
      decrypts: list.map((d) => ({ ...d, delivery: state.deliveries.get(d.txId) ?? null, ack: state.acks.get(d.txId) ?? null })),
    };
  },
  "POST /consensus/propose": (_u, body) => {
    const r = handleProposal(body as Proposal);
    if (r.error && !r.behind && r.error !== "stale height") log(`rejected proposal #${(body as Proposal)?.block?.header?.height}: ${r.error}`);
    return r;
  },
  "POST /consensus/precommit": (_u, body) => handlePrecommit(body as PrecommitRequest),
  "POST /consensus/commit": async (_u, body) => {
    const b = body?.block as Block;
    if (!b?.header) throw httpError(400, "missing block");
    if (b.header.height <= height()) return { ok: true, already: true };
    if (b.header.height > height() + 1) {
      void syncFromPeers();
      return { ok: false, syncing: true };
    }
    const err = tryApply(b, true);
    if (err) {
      recordIncident("COMMIT_REJECTED", `block #${b.header.height} from ${b.proposer}: ${err}`);
      throw httpError(400, err);
    }
    return { ok: true };
  },
  "GET /consensus/lock": (u) => {
    const h = Number(u.searchParams.get("height"));
    return { lock: locks.get(h) };
  },
  "POST /release": (_u, body) => handleRelease(body as ReleaseRequest),
  "GET /audit": () => {
    integrityCheck();
    return { integrity, incidents };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  if (!handler) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  try {
    let body: unknown = undefined;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 16 * 1024 * 1024) throw httpError(413, "request too large");
        chunks.push(c as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    }
    const out = await handler(url, body);
    res.end(JSON.stringify(out));
  } catch (e) {
    const err = e as Error & { status?: number };
    res.statusCode = err.status ?? 500;
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ------------------------------------------------------------------ boot

async function main() {
  const keyFile: KeyFile = JSON.parse(fs.readFileSync(path.join(NODE_DIR, "key.json"), "utf8"));
  const passFile = path.join(DATA, "secrets", `${NODE_ID}.pass`);
  const pass = process.env.SAKSHI_NODE_PASSPHRASE ?? (fs.existsSync(passFile) ? fs.readFileSync(passFile, "utf8").trim() : "");
  identity = await unlockIdentity(keyFile, pass);
  if (toB64(identity.dsa.publicKey) !== ME!.dsaPk) throw new Error("key file does not match genesis entry");
  loadChain();
  server.listen(PORT, BIND, () => log(`validator listening on ${BIND}:${PORT} · chain ${genesis.chainId.slice(0, 12)} · quorum ${G.quorum}/${G.validators.length}`));
  setInterval(tick, 250);
  setInterval(() => void syncFromPeers(), 3000);
  setInterval(integrityCheck, 5000);
  setInterval(() => {
    const cutoff = Date.now() - 120_000;
    for (const [n, t] of seenReleaseNonces) if (t < cutoff) seenReleaseNonces.delete(n);
  }, 60_000);
  void syncFromPeers();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

