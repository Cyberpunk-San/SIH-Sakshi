// Unit tests for the shared crypto core.  Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, randomBytes, sha256Hex, toB64, fromB64, utf8 } from "../src/lib/core/bytes";
import { split, combine } from "../src/lib/core/shamir";
import { merkleRoot, merkleProof, verifyMerkleProof } from "../src/lib/core/merkle";
import { generateIdentity, seal, open, sign, verify } from "../src/lib/core/pq";
import {
  encryptDocument,
  unwrapRecipientKey,
  openValidatorShare,
  reassembleAndDecrypt,
  CHUNK_BLOB,
} from "../src/lib/core/vault";
import { lockIdentity, unlockIdentity } from "../src/lib/core/keyfile";

test("base64 roundtrip", () => {
  for (const n of [0, 1, 2, 3, 4, 100, 1001]) {
    const b = randomBytes(n);
    assert.deepEqual(fromB64(toB64(b)), b);
    assert.equal(toB64(b), Buffer.from(b).toString("base64"));
  }
});

test("canonical JSON is key-order independent", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: "x" }] }), canonical({ a: [2, { c: "x", d: 1 }], b: 1 }));
  assert.throws(() => canonical({ x: 1.5 }));
});

test("shamir 3-of-4 any subset reconstructs, 2 do not", () => {
  const secret = randomBytes(32);
  const shares = split(secret, 3, 4);
  for (const idx of [[0, 1, 2], [0, 1, 3], [1, 2, 3], [0, 2, 3], [0, 1, 2, 3]]) {
    assert.deepEqual(combine(idx.map((i) => shares[i])), secret);
  }
  assert.notDeepEqual(combine([shares[0], shares[1]]), secret);
});

test("merkle proofs for odd and even trees", () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const leaves = Array.from({ length: n }, (_, i) => sha256Hex(String(i)));
    const root = merkleRoot(leaves);
    leaves.forEach((l, i) => assert.ok(verifyMerkleProof(l, merkleProof(leaves, i), root)));
    if (n > 1) assert.ok(!verifyMerkleProof(leaves[0], merkleProof(leaves, 1), root));
  }
});

test("ML-DSA domain separation and ML-KEM sealing", () => {
  const id = generateIdentity();
  const sig = sign(id.dsa.secretKey, "a", "msg");
  assert.ok(verify(id.dsa.publicKey, "a", "msg", sig));
  assert.ok(!verify(id.dsa.publicKey, "b", "msg", sig));
  const s = seal(id.kem.publicKey, utf8("secret"), "label", utf8("aad"));
  assert.equal(new TextDecoder().decode(open(id.kem.secretKey, s, "label", utf8("aad"))), "secret");
  assert.throws(() => open(id.kem.secretKey, s, "label", utf8("other-aad")));
});

test("broadcast encryption: recipient half + 3 validator shares rebuild the document", () => {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const vals = Array.from({ length: 4 }, (_, i) => ({ id: `v${i + 1}`, key: generateIdentity() }));
  const file = randomBytes(200_000);
  const docId = "ab".repeat(16);
  const enc = encryptDocument(
    file,
    docId,
    [
      { userId: "alice", kemPk: toB64(alice.kem.publicKey) },
      { userId: "bob", kemPk: toB64(bob.kem.publicKey) },
    ],
    vals.map((v) => ({ id: v.id, kemPk: toB64(v.key.kem.publicKey) })),
    3,
  );
  assert.equal(enc.chunks.length, 4);
  enc.chunks.forEach((c) => assert.equal(c.blob.length, CHUNK_BLOB));
  const store = new Map(enc.chunks.map((c) => [c.name, c.blob]));
  const kr = unwrapRecipientKey(bob.kem.secretKey, docId, "bob", enc.wrappedKeys.bob);
  const shares = [0, 2, 3].map((i) => openValidatorShare(vals[i].key.kem.secretKey, docId, vals[i].id, enc.validatorShares[vals[i].id]));
  const out = reassembleAndDecrypt(kr, shares, docId, enc.chunks.length, enc.chunkRoot, enc.ctSha256, (n) => store.get(n)!);
  assert.deepEqual(out, file);
  // Alice cannot use Bob's wrapped key.
  assert.throws(() => unwrapRecipientKey(alice.kem.secretKey, docId, "bob", enc.wrappedKeys.bob));
  // Two validator shares are not enough.
  const two = [0, 1].map((i) => openValidatorShare(vals[i].key.kem.secretKey, docId, vals[i].id, enc.validatorShares[vals[i].id]));
  assert.throws(() => reassembleAndDecrypt(kr, two, docId, enc.chunks.length, enc.chunkRoot, enc.ctSha256, (n) => store.get(n)!));
  // A swapped chunk is detected.
  const names = enc.chunks.map((c) => c.name);
  const swapped = new Map(store);
  swapped.set(names[0], store.get(names[1])!);
  swapped.set(names[1], store.get(names[0])!);
  assert.throws(() => reassembleAndDecrypt(kr, shares, docId, enc.chunks.length, enc.chunkRoot, enc.ctSha256, (n) => swapped.get(n)!));
});

test("key file locks with argon2id passphrase", async () => {
  const id = generateIdentity();
  const kf = await lockIdentity(id, "alice", "user", "correct horse battery");
  const back = await unlockIdentity(kf, "correct horse battery");
  assert.deepEqual(back.dsa.secretKey, id.dsa.secretKey);
  await assert.rejects(unlockIdentity(kf, "wrong passphrase!!"));
});
