// Broadcast encryption of a document + jumbled chunk storage.
//
//   DEK = HKDF(K_R || K_G, docId)
//   K_R  -> sealed (ML-KEM-768) to every recipient          : recipient's half
//   K_G  -> Shamir t-of-n, one share sealed to each validator : released only after the
//                                                              decryption record is committed
//   file -> AES-256-GCM(K_file)            = document ciphertext (hash recorded on ledger)
//   ciphertext -> fixed-size chunks, each AES-GCM(K_chunk, aad = docId||i), stored under
//   name HMAC(K_name, docId||i). Names reveal neither the document nor the order; decoys
//   of the same size are mixed in by the store.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, equalBytes, randomBytes, sha256Hex, fromB64, toHex, u32be, utf8 } from "./bytes";
import { merkleRoot } from "./merkle";
import { aeadDecrypt, aeadEncrypt, kdf, open, seal, type Sealed } from "./pq";
import { combine, split, type Share } from "./shamir";

export const CHUNK_PLAIN = 64 * 1024;
export const CHUNK_BLOB = 12 + 4 + CHUNK_PLAIN + 16; // nonce + length + data + tag

export function deriveDek(kr: Uint8Array, kg: Uint8Array, docId: string): Uint8Array {
  return kdf(concat(kr, kg), "dek/" + docId);
}

export function docKeys(dek: Uint8Array, docId: string) {
  return {
    file: kdf(dek, "file/" + docId),
    chunk: kdf(dek, "chunk/" + docId),
    name: kdf(dek, "name/" + docId),
  };
}

export function chunkName(nameKey: Uint8Array, docId: string, index: number): string {
  return toHex(hmac(sha256, nameKey, concat(utf8(docId), u32be(index))));
}

const chunkAad = (docId: string, index: number) => concat(utf8("sakshi/chunk/v1/" + docId), u32be(index));

export type StoredChunk = { name: string; blob: Uint8Array };

export function chunkCiphertext(ciphertext: Uint8Array, docId: string, keys: ReturnType<typeof docKeys>): StoredChunk[] {
  const out: StoredChunk[] = [];
  const count = Math.max(1, Math.ceil(ciphertext.length / CHUNK_PLAIN));
  for (let i = 0; i < count; i++) {
    const slice = ciphertext.subarray(i * CHUNK_PLAIN, (i + 1) * CHUNK_PLAIN);
    const frame = new Uint8Array(4 + CHUNK_PLAIN); // fixed size: every blob looks the same
    frame.set(u32be(slice.length), 0);
    frame.set(slice, 4);
    out.push({ name: chunkName(keys.name, docId, i), blob: aeadEncrypt(keys.chunk, frame, chunkAad(docId, i)) });
  }
  return out;
}

export function openChunk(blob: Uint8Array, docId: string, index: number, keys: ReturnType<typeof docKeys>): Uint8Array {
  const frame = aeadDecrypt(keys.chunk, blob, chunkAad(docId, index));
  const len = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
  if (len > CHUNK_PLAIN) throw new Error("corrupt chunk frame");
  return frame.slice(4, 4 + len);
}

export function decoyBlob(): Uint8Array {
  return randomBytes(CHUNK_BLOB);
}

export type Recipient = { userId: string; kemPk: string };
export type ValidatorKey = { id: string; kemPk: string };

export type EncryptedDocument = {
  docId: string;
  ciphertext: Uint8Array;
  ctSha256: string;
  chunks: StoredChunk[];
  chunkRoot: string;
  wrappedKeys: Record<string, Sealed>;
  validatorShares: Record<string, Sealed>;
};

export const wrapAad = (docId: string, userId: string) => utf8(`sakshi/wrap/v1/${docId}/${userId}`);
/** K_R travels to the gateway sealed to its ML-KEM key and bound to one decryption record. */
export const krAad = (decryptTxId: string) => utf8(`sakshi/kr/v1/${decryptTxId}`);
export const shareAad = (docId: string, validatorId: string) => utf8(`sakshi/share/v1/${docId}/${validatorId}`);

/** Sender side (runs in the sender's browser). */
export function encryptDocument(
  file: Uint8Array,
  docId: string,
  recipients: Recipient[],
  validators: ValidatorKey[],
  shareThreshold: number,
): EncryptedDocument {
  const kr = randomBytes(32);
  const kg = randomBytes(32);
  const dek = deriveDek(kr, kg, docId);
  const keys = docKeys(dek, docId);
  const ciphertext = aeadEncrypt(keys.file, file, utf8("sakshi/doc/v1/" + docId));
  const chunks = chunkCiphertext(ciphertext, docId, keys);

  const wrappedKeys: Record<string, Sealed> = {};
  for (const r of recipients) wrappedKeys[r.userId] = seal(fromB64(r.kemPk), kr, "wrap", wrapAad(docId, r.userId));

  const shares = split(kg, shareThreshold, validators.length);
  const validatorShares: Record<string, Sealed> = {};
  validators.forEach((v, i) => {
    const payload = concat(new Uint8Array([shares[i].x]), shares[i].y);
    validatorShares[v.id] = seal(fromB64(v.kemPk), payload, "share", shareAad(docId, v.id));
  });

  kr.fill(0);
  kg.fill(0);
  dek.fill(0);
  shares.forEach((s) => s.y.fill(0));
  return {
    docId,
    ciphertext,
    ctSha256: sha256Hex(ciphertext),
    chunks,
    chunkRoot: merkleRoot(chunks.map((c) => sha256Hex(c.blob))),
    wrappedKeys,
    validatorShares,
  };
}

/** Recipient side: recover K_R with the recipient's ML-KEM secret key. */
export function unwrapRecipientKey(kemSk: Uint8Array, docId: string, userId: string, wrapped: Sealed): Uint8Array {
  return open(kemSk, wrapped, "wrap", wrapAad(docId, userId));
}

/** Validator side: open this validator's Shamir share. */
export function openValidatorShare(kemSk: Uint8Array, docId: string, validatorId: string, sealed: Sealed): Share {
  const raw = open(kemSk, sealed, "share", shareAad(docId, validatorId));
  return { x: raw[0], y: raw.slice(1) };
}

export function encodeShare(s: Share): Uint8Array {
  return concat(new Uint8Array([s.x]), s.y);
}

export function decodeShare(raw: Uint8Array): Share {
  return { x: raw[0], y: raw.slice(1) };
}

/** Gateway side: rebuild ciphertext from stored chunks and decrypt it. */
export function reassembleAndDecrypt(
  kr: Uint8Array,
  kgShares: Share[],
  docId: string,
  chunkCount: number,
  expectedChunkRoot: string,
  expectedCtSha256: string,
  fetchBlob: (name: string) => Uint8Array,
): Uint8Array {
  const kg = combine(kgShares);
  const dek = deriveDek(kr, kg, docId);
  const keys = docKeys(dek, docId);
  try {
    const blobs: Uint8Array[] = [];
    for (let i = 0; i < chunkCount; i++) blobs.push(fetchBlob(chunkName(keys.name, docId, i)));
    if (merkleRoot(blobs.map((b) => sha256Hex(b))) !== expectedChunkRoot) throw new Error("stored chunks do not match the ledger Merkle root");
    const ciphertext = concat(...blobs.map((b, i) => openChunk(b, docId, i, keys)));
    if (!equalBytes(utf8(sha256Hex(ciphertext)), utf8(expectedCtSha256))) throw new Error("ciphertext hash does not match the ledger");
    return aeadDecrypt(keys.file, ciphertext, utf8("sakshi/doc/v1/" + docId));
  } finally {
    kg.fill(0);
    dek.fill(0);
    keys.file.fill(0);
    keys.chunk.fill(0);
    keys.name.fill(0);
  }
}

