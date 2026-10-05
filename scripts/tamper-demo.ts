/**
 * Tamper demonstration: a rogue administrator with full disk access edits a validator's
 * chain file to erase who decrypted a document. Run against a live stack:
 *
 *   npm run tamper-demo -- [--node v3]
 *
 * Expected: the validator detects the edit within seconds, quarantines the altered file
 * as evidence, restores the verified chain, and the record is still intact on every node.
 */
import fs from "node:fs";
import path from "node:path";
import type { Block } from "../src/lib/core/ledger";

const DATA = path.resolve(process.env.SAKSHI_DATA ?? "data");
const nodeArg = process.argv.indexOf("--node");
const NODE = nodeArg >= 0 ? process.argv[nodeArg + 1] : "v3";
const genesis = JSON.parse(fs.readFileSync(path.join(DATA, "genesis.json"), "utf8"));
const url = genesis.body.validators.find((v: { id: string }) => v.id === NODE).url;
const file = path.join(DATA, "nodes", NODE, "chain.jsonl");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const idx = lines.findIndex((l) => (JSON.parse(l) as Block).txs.some((t) => t.type === "DECRYPT"));
  if (idx < 0) throw new Error("no DECRYPT record yet: decrypt a document first (or run npm run e2e)");
  const block = JSON.parse(lines[idx]) as Block;
  const tx = block.txs.find((t) => t.type === "DECRYPT")!;
  const body = tx.body as { recipientId: string; docId: string };
  console.log(`Target: ${NODE}, block #${block.header.height}: "${body.recipientId}" decrypted document ${body.docId.slice(0, 10)}…`);
  console.log(`Attack: rewriting the record on disk so it names "innocent-user" instead.\n`);

  body.recipientId = "innocent-user";
  lines[idx] = JSON.stringify(block);
  fs.writeFileSync(file, lines.join("\n") + "\n");

  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const s = await (await fetch(`${url}/status`)).json();
    const inc = (s.incidents as { kind: string; detail: string; quarantined?: string }[]).filter((x) => x.kind.startsWith("CHAIN_")).slice(-2);
    if (inc.length && fs.readFileSync(file, "utf8").includes(`"recipientId":"innocent-user"`) === false) {
      console.log(`Detected after ~${i + 1}s by ${NODE}'s integrity monitor:`);
      for (const x of inc) console.log(`  ${x.kind}: ${x.detail}${x.quarantined ? `  (evidence: ${x.quarantined})` : ""}`);
      const restored = JSON.parse(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)[idx]) as Block;
      const rb = restored.txs.find((t) => t.type === "DECRYPT")!.body as { recipientId: string };
      console.log(`\nRecord on disk now reads: "${rb.recipientId}" (restored from the quorum-certified copy).`);
      const heads = await Promise.all(
        genesis.body.validators.map(async (v: { id: string; url: string }) => {
          const st = await (await fetch(`${v.url}/status`)).json().catch(() => null);
          return `${v.id}@#${st?.height}:${st?.headHash?.slice(0, 10)}`;
        }),
      );
      console.log(`Validator heads: ${heads.join("  ")}`);
      console.log("\nWhy the forgery cannot win: the block hash covers the Merkle root of its transactions, and the");
      console.log(`block carries ${block.qc.length} ML-DSA-65 validator signatures over that hash. A changed record no longer`);
      console.log("matches, and producing a new certificate would require the private keys of a validator quorum.");
      return;
    }
  }
  console.error("Tamper was not detected within 20 s. Is the validator running?");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
