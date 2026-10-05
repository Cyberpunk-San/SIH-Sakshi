import "server-only";
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { CHUNK_BLOB, decoyBlob, type StoredChunk } from "@/lib/core/vault";
import { VAULT_DIR } from "./config";

// Flat, content-addressed-looking store. Every blob has the same size and a 256-bit
// pseudorandom name; real chunks are mixed with decoys, written in shuffled order and
// given randomised timestamps, so the store reveals neither which blobs belong
// together, nor their order, nor how many documents exist.

const NAME = /^[0-9a-f]{64}$/;
const blobPath = (name: string) => path.join(VAULT_DIR, name.slice(0, 2), name + ".blob");

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomPast(): Date {
  return new Date(Date.now() - randomInt(0, 90 * 24 * 3600) * 1000);
}

export function storeChunks(chunks: StoredChunk[]): { stored: number; decoys: number } {
  for (const c of chunks) {
    if (!NAME.test(c.name)) throw new Error("invalid chunk name");
    if (c.blob.length !== CHUNK_BLOB) throw new Error("invalid chunk size");
    if (fs.existsSync(blobPath(c.name))) throw new Error("chunk name collision");
  }
  const decoyCount = Math.max(2, Math.ceil(chunks.length * (0.5 + Math.random())));
  const items: StoredChunk[] = [
    ...chunks,
    ...Array.from({ length: decoyCount }, () => ({ name: Buffer.from(decoyBlob().subarray(0, 32)).toString("hex"), blob: decoyBlob() })),
  ];
  for (const item of shuffle(items)) {
    const p = blobPath(item.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, item.blob, { flag: "wx" });
    const t = randomPast();
    fs.utimesSync(p, t, t);
  }
  return { stored: chunks.length, decoys: decoyCount };
}

export function removeChunks(names: string[]) {
  for (const n of names) if (NAME.test(n)) fs.rmSync(blobPath(n), { force: true });
}

export function readChunk(name: string): Uint8Array {
  if (!NAME.test(name)) throw new Error("invalid chunk name");
  const p = blobPath(name);
  if (!fs.existsSync(p)) throw new Error("a chunk of this document is missing from the vault");
  return new Uint8Array(fs.readFileSync(p));
}

export function vaultStats() {
  let blobs = 0;
  if (fs.existsSync(VAULT_DIR)) for (const d of fs.readdirSync(VAULT_DIR)) blobs += fs.readdirSync(path.join(VAULT_DIR, d)).length;
  return { blobs, blobBytes: CHUNK_BLOB };
}
