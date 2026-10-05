/**
 * Offline verifier for a Sakshi evidence bundle. Needs no network and no trust in the
 * gateway: it checks the genesis, every validator certificate, Merkle proofs and the
 * recipient's ML-DSA-65 signature from the bundle alone.
 *
 *   npm run verify-evidence -- evidence.json [--genesis data/genesis.json]
 */
import fs from "node:fs";
import { verifyEvidence, type EvidenceBundle } from "../src/lib/core/evidence";

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: verify-evidence <bundle.json> [--genesis <genesis.json>]");
  process.exit(2);
}
const bundle = JSON.parse(fs.readFileSync(file, "utf8")) as EvidenceBundle;
const gi = rest.indexOf("--genesis");
if (gi >= 0) {
  // Pin the network: the bundle must be from the chain you already trust.
  const trusted = JSON.parse(fs.readFileSync(rest[gi + 1], "utf8"));
  if (trusted.chainId !== bundle.genesis.chainId) {
    console.error(`✘ bundle is from chain ${bundle.genesis.chainId}, expected ${trusted.chainId}`);
    process.exit(1);
  }
}
const v = verifyEvidence(bundle);
for (const c of v.checks) console.log(`${c.ok ? "✔" : c.optional ? "–" : "✘"} ${c.label}\n    ${c.detail}`);
console.log("");
if (v.verdict === "ATTRIBUTED" && v.subject) {
  const s = v.subject;
  console.log(`VERDICT: ATTRIBUTED`);
  console.log(`  recipient  ${s.name} <${s.userId}>, ${s.org}`);
  console.log(`  document   ${s.docTitle} (${s.docId})`);
  console.log(`  decrypted  ${new Date(s.decryptedAt).toISOString()} · session ${s.sessionId} · block #${s.blockHeight}`);
  console.log(`  record     ${s.decryptTxId}`);
  process.exit(0);
}
console.log("VERDICT: NOT_VERIFIED");
process.exit(1);
