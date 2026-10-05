// Ledger data model shared by validator nodes, the gateway, browsers and the offline verifier.
import { canonical, canonicalHash, fromB64, sha256Hex, toB64 } from "./bytes";
import { merkleProof, merkleRoot, verifyMerkleProof, type ProofStep } from "./merkle";
import { sign, verify, type Sealed } from "./pq";

// ------------------------------------------------------------------ genesis

export type ValidatorInfo = { id: string; name: string; url: string; dsaPk: string; kemPk: string };
export type RegistrarInfo = { id: string; name: string; dsaPk: string };

export type GenesisBody = {
  network: string;
  createdAt: number;
  quorum: number; // votes required to commit a block (2f+1)
  shareThreshold: number; // validator key shares required to release K_G
  validators: ValidatorInfo[];
  registrars: RegistrarInfo[];
  gateway: { id: string; dsaPk: string; kemPk: string };
};

export type Genesis = {
  body: GenesisBody;
  chainId: string; // sha256(canonical(body))
  signatures: Vote[]; // every founding validator signs the chain id
};

export function chainIdOf(body: GenesisBody): string {
  return canonicalHash(body);
}

// ------------------------------------------------------------------ transactions

export type Role = "sender" | "recipient" | "investigator";

export type CertBody = {
  userId: string;
  name: string;
  org: string;
  roles: Role[];
  dsaPk: string; // base64 ML-DSA-65 public key
  kemPk: string; // base64 ML-KEM-768 public key
  issuedAt: number;
  expiresAt: number;
  popSig: string; // proof of possession: user's signature over their own enrolment request
};

export type CertRevokeBody = { userId: string; certTxId: string; reason: string; at: number };

export type DocPublishBody = {
  docId: string;
  title: string;
  fileName: string;
  mime: string;
  size: number;
  kind: "pdf" | "image";
  pdfMode: "preserve" | "flatten";
  ctSha256: string; // hash of the AES-GCM ciphertext of the whole document
  chunkCount: number;
  chunkRoot: string; // Merkle root of stored chunk blobs, in order
  recipients: string[];
  wrappedKeys: Record<string, Sealed>; // userId -> K_R sealed to the recipient's ML-KEM key
  validatorShares: Record<string, Sealed>; // validatorId -> Shamir share of K_G sealed to that validator
  createdAt: number;
};

export type DecryptBody = {
  docId: string;
  recipientId: string;
  sessionId: string; // 16 random bytes, hex
  wmId: string; // 64-bit watermark id derived from (docId, recipientId, sessionId)
  ctSha256: string;
  at: number;
  userAgent: string;
};

export type DeliveryBody = {
  decryptTxId: string;
  wmId: string;
  deliveredSha256: string;
  deliveredBytes: number;
  mime: string;
  selfCheckSigma: number;
  at: number;
};

export type AckBody = { decryptTxId: string; deliveredSha256: string; at: number };

export type ForensicQueryBody = {
  queryId: string;
  fileSha256: string;
  fileName: string;
  at: number;
};

export type TxBodies = {
  CERT_ISSUE: CertBody;
  CERT_REVOKE: CertRevokeBody;
  DOC_PUBLISH: DocPublishBody;
  DECRYPT: DecryptBody;
  DELIVERY: DeliveryBody;
  ACK: AckBody;
  FORENSIC_QUERY: ForensicQueryBody;
};
export type TxType = keyof TxBodies;
export const TX_TYPES: TxType[] = ["CERT_ISSUE", "CERT_REVOKE", "DOC_PUBLISH", "DECRYPT", "DELIVERY", "ACK", "FORENSIC_QUERY"];

export type Tx<T extends TxType = TxType> = {
  type: T;
  body: TxBodies[T];
  signer: string; // userId, registrar id or "gateway"
  sig: string; // base64 ML-DSA-65 signature
};

export const txDomain = (type: TxType) => `sakshi/tx/v1/${type}`;

export function txPayload(type: TxType, body: unknown, signer: string): string {
  return canonical({ type, body, signer });
}

export function txId(tx: Pick<Tx, "type" | "body" | "signer">): string {
  return sha256Hex(txPayload(tx.type, tx.body, tx.signer));
}

export function signTx<T extends TxType>(type: T, body: TxBodies[T], signer: string, secretKey: Uint8Array): Tx<T> {
  const sig = sign(secretKey, txDomain(type), txPayload(type, body, signer));
  return { type, body, signer, sig: toB64(sig) };
}

export function verifyTxSignature(tx: Tx, publicKeyB64: string): boolean {
  try {
    return verify(fromB64(publicKeyB64), txDomain(tx.type), txPayload(tx.type, tx.body, tx.signer), fromB64(tx.sig));
  } catch {
    return false;
  }
}

/** Watermark id: first 64 bits of a hash over the session tuple. */
export function deriveWmId(docId: string, recipientId: string, sessionId: string): string {
  return sha256Hex(canonical(["sakshi/wm-id/v1", docId, recipientId, sessionId])).slice(0, 16);
}

// ------------------------------------------------------------------ blocks

export type BlockHeader = {
  chainId: string;
  height: number;
  prevHash: string;
  time: number; // ms since epoch, proposer clock (checked by voters)
  txRoot: string;
  txCount: number;
};

export type Vote = { validatorId: string; sig: string };

export type Block = {
  header: BlockHeader;
  hash: string;
  txs: Tx[];
  proposer: string;
  round: number;
  qc: Vote[]; // commit certificate: >= quorum validator signatures over the block hash
};

export const COMMIT_DOMAIN = "sakshi/commit/v1";
export const GENESIS_DOMAIN = "sakshi/genesis/v1";

export function blockHash(header: BlockHeader): string {
  return canonicalHash(header);
}

export function commitMessage(chainId: string, height: number, hash: string): string {
  return `${chainId}:${height}:${hash}`;
}

export function buildHeader(chainId: string, height: number, prevHash: string, time: number, txs: Tx[]): BlockHeader {
  return { chainId, height, prevHash, time, txRoot: merkleRoot(txs.map(txId)), txCount: txs.length };
}

export function signVote(secretKey: Uint8Array, validatorId: string, header: BlockHeader): Vote {
  const hash = blockHash(header);
  return { validatorId, sig: toB64(sign(secretKey, COMMIT_DOMAIN, commitMessage(header.chainId, header.height, hash))) };
}

export function countValidVotes(genesis: GenesisBody, header: BlockHeader, votes: Vote[]): number {
  const hash = blockHash(header);
  const msg = commitMessage(header.chainId, header.height, hash);
  const seen = new Set<string>();
  for (const v of votes) {
    if (seen.has(v.validatorId)) continue;
    const val = genesis.validators.find((x) => x.id === v.validatorId);
    if (!val) continue;
    if (verify(fromB64(val.dsaPk), COMMIT_DOMAIN, msg, fromB64(v.sig))) seen.add(v.validatorId);
  }
  return seen.size;
}

export function verifyGenesis(g: Genesis): { ok: boolean; reason?: string } {
  if (chainIdOf(g.body) !== g.chainId) return { ok: false, reason: "genesis body does not match chain id" };
  const ok = new Set<string>();
  for (const s of g.signatures) {
    const v = g.body.validators.find((x) => x.id === s.validatorId);
    if (v && verify(fromB64(v.dsaPk), GENESIS_DOMAIN, g.chainId, fromB64(s.sig))) ok.add(v.id);
  }
  if (ok.size !== g.body.validators.length) return { ok: false, reason: "genesis not signed by every founding validator" };
  if (g.body.quorum <= (2 * g.body.validators.length) / 3) return { ok: false, reason: "quorum below BFT bound" };
  return { ok: true };
}

/** Structural + certificate checks for a block (transaction semantics are checked by the state machine). */
export function verifyBlockShape(genesis: Genesis, block: Block, prevHash: string, height: number): string | null {
  const h = block.header;
  if (h.chainId !== genesis.chainId) return "wrong chain id";
  if (h.height !== height) return `expected height ${height}, got ${h.height}`;
  if (h.prevHash !== prevHash) return "prevHash does not link to the previous block";
  if (blockHash(h) !== block.hash) return "block hash mismatch (header altered)";
  if (h.txCount !== block.txs.length) return "tx count mismatch";
  if (merkleRoot(block.txs.map(txId)) !== h.txRoot) return "transaction Merkle root mismatch (transactions altered)";
  const votes = countValidVotes(genesis.body, h, block.qc);
  if (votes < genesis.body.quorum) return `commit certificate has ${votes} valid votes, needs ${genesis.body.quorum}`;
  return null;
}

// ------------------------------------------------------------------ inclusion proofs

export type Inclusion = {
  header: BlockHeader;
  hash: string;
  qc: Vote[];
  index: number;
  proof: ProofStep[];
};

export function inclusionFor(block: Block, id: string): Inclusion {
  const ids = block.txs.map(txId);
  const index = ids.indexOf(id);
  if (index < 0) throw new Error("tx not in block");
  return { header: block.header, hash: block.hash, qc: block.qc, index, proof: merkleProof(ids, index) };
}

export function verifyInclusion(genesis: Genesis, tx: Tx, inc: Inclusion): string | null {
  if (inc.header.chainId !== genesis.chainId) return "inclusion is for a different chain";
  if (blockHash(inc.header) !== inc.hash) return "block header hash mismatch";
  if (!verifyMerkleProof(txId(tx), inc.proof, inc.header.txRoot)) return "Merkle inclusion proof invalid";
  const votes = countValidVotes(genesis.body, inc.header, inc.qc);
  if (votes < genesis.body.quorum) return `block certificate has ${votes}/${genesis.body.quorum} validator signatures`;
  return null;
}
