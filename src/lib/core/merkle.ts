// Domain-separated SHA-256 Merkle tree (RFC 6962 style: odd nodes are promoted,
// never duplicated, so different leaf lists cannot produce the same root).
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, fromHex, toHex } from "./bytes";

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

export function leafHash(leafHex: string): string {
  return toHex(sha256(concat(LEAF, fromHex(leafHex))));
}

function nodeHash(l: string, r: string): string {
  return toHex(sha256(concat(NODE, fromHex(l), fromHex(r))));
}

export function merkleRoot(leavesHex: string[]): string {
  if (leavesHex.length === 0) return toHex(sha256(new Uint8Array()));
  let level = leavesHex.map(leafHash);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

export type ProofStep = { side: "L" | "R"; hash: string };

export function merkleProof(leavesHex: string[], index: number): ProofStep[] {
  if (index < 0 || index >= leavesHex.length) throw new Error("index out of range");
  let level = leavesHex.map(leafHash);
  let idx = index;
  const proof: ProofStep[] = [];
  while (level.length > 1) {
    const sibling = idx ^ 1;
    if (sibling < level.length) proof.push({ side: idx % 2 === 0 ? "R" : "L", hash: level[sibling] });
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyMerkleProof(leafHex: string, proof: ProofStep[], root: string): boolean {
  let h = leafHash(leafHex);
  for (const step of proof) h = step.side === "R" ? nodeHash(h, step.hash) : nodeHash(step.hash, h);
  return h === root;
}
