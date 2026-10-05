// Deterministic ledger state machine. Every validator replays the same blocks through
// this code, so all honest nodes agree on the resulting state.
import { canonical, fromB64 } from "./bytes";
import {
  deriveWmId,
  verifyTxSignature,
  type AckBody,
  type CertBody,
  type CertRevokeBody,
  type ForensicQueryBody,
  type DecryptBody,
  type DeliveryBody,
  type DocPublishBody,
  type Genesis,
  type Role,
  type Tx,
  type TxType,
  txId as computeTxId,
  TX_TYPES,
} from "./ledger";
import { verify } from "./pq";

export const ENROL_DOMAIN = "sakshi/enrol/v1";
export const enrolPayload = (b: Pick<CertBody, "userId" | "name" | "org" | "dsaPk" | "kemPk">) =>
  canonical({ userId: b.userId, name: b.name, org: b.org, dsaPk: b.dsaPk, kemPk: b.kemPk });

export type CertRecord = {
  body: CertBody;
  txId: string;
  height: number;
  issuer: string;
  revoked?: { txId: string; height: number; reason: string };
};
export type DocRecord = { body: DocPublishBody; txId: string; height: number; sender: string };
export type DecryptRecord = { body: DecryptBody; txId: string; height: number };
export type DeliveryRecord = { body: DeliveryBody; txId: string; height: number };
export type AckRecord = { body: AckBody; txId: string; height: number };
export type TxLocation = { height: number; index: number; type: TxType; signer: string };

const USER_ID = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const ROLES: Role[] = ["sender", "recipient", "investigator"];
const CLOCK_SKEW_MS = 10 * 60 * 1000;

export class LedgerState {
  certs = new Map<string, CertRecord>();
  certHistory: CertRecord[] = [];
  docs = new Map<string, DocRecord>();
  decrypts = new Map<string, DecryptRecord>();
  wmIndex = new Map<string, string>(); // wmId -> decrypt txId
  sessions = new Set<string>();
  deliveries = new Map<string, DeliveryRecord>(); // decrypt txId -> delivery
  acks = new Map<string, AckRecord>(); // decrypt txId -> ack
  queries = new Set<string>();
  txIndex = new Map<string, TxLocation>();
  height = 0;

  constructor(public readonly genesis: Genesis) {}

  /** Cheap copy used to validate proposals without touching committed state. */
  clone(): LedgerState {
    const s = new LedgerState(this.genesis);
    s.certs = new Map(this.certs);
    s.certHistory = [...this.certHistory];
    s.docs = new Map(this.docs);
    s.decrypts = new Map(this.decrypts);
    s.wmIndex = new Map(this.wmIndex);
    s.sessions = new Set(this.sessions);
    s.deliveries = new Map(this.deliveries);
    s.acks = new Map(this.acks);
    s.queries = new Set(this.queries);
    s.txIndex = new Map(this.txIndex);
    s.height = this.height;
    return s;
  }

  activeCert(userId: string, at: number): CertRecord | null {
    const c = this.certs.get(userId);
    if (!c || c.revoked) return null;
    if (at > c.body.expiresAt) return null;
    return c;
  }

  /** Check a transaction against the current state without applying it. */
  check(tx: Tx, time: number): string | null {
    if (!tx || !TX_TYPES.includes(tx.type)) return "unknown transaction type";
    if (typeof tx.signer !== "string" || typeof tx.sig !== "string" || typeof tx.body !== "object" || !tx.body)
      return "malformed transaction";
    const id = computeTxId(tx);
    if (this.txIndex.has(id)) return "duplicate transaction";
    const g = this.genesis.body;

    // Resolve signer key and enforce who may submit which transaction.
    let pk: string | undefined;
    if (tx.type === "CERT_ISSUE" || tx.type === "CERT_REVOKE") {
      pk = g.registrars.find((r) => r.id === tx.signer)?.dsaPk;
      if (!pk) return "only a genesis registrar may issue or revoke certificates";
    } else if (tx.type === "DELIVERY") {
      if (tx.signer !== g.gateway.id) return "only the gateway may record deliveries";
      pk = g.gateway.dsaPk;
    } else {
      const cert = this.activeCert(tx.signer, time);
      if (!cert) return `signer ${tx.signer} has no active certificate`;
      pk = cert.body.dsaPk;
    }
    if (!verifyTxSignature(tx, pk)) return "invalid ML-DSA signature";

    switch (tx.type) {
      case "CERT_ISSUE": {
        const b = tx.body as CertBody;
        if (!USER_ID.test(b.userId ?? "")) return "invalid user id";
        if (!b.name || b.name.length > 120 || (b.org ?? "").length > 120) return "invalid name/org";
        if (!Array.isArray(b.roles) || b.roles.length === 0 || b.roles.some((r) => !ROLES.includes(r))) return "invalid roles";
        if (new Set(b.roles).size !== b.roles.length) return "duplicate roles";
        if (!(b.expiresAt > b.issuedAt) || b.issuedAt > time + CLOCK_SKEW_MS) return "invalid validity period";
        if (this.activeCert(b.userId, time)) return "user already has an active certificate (revoke it first)";
        try {
          if (fromB64(b.dsaPk).length !== 1952 || fromB64(b.kemPk).length !== 1184) return "public keys are not ML-DSA-65 / ML-KEM-768";
          if (!verify(fromB64(b.dsaPk), ENROL_DOMAIN, enrolPayload(b), fromB64(b.popSig)))
            return "proof of possession failed (enrolment not signed by the key owner)";
        } catch {
          return "malformed key material";
        }
        return null;
      }
      case "CERT_REVOKE": {
        const b = tx.body as CertRevokeBody;
        const c = this.certs.get(b.userId);
        if (!c || c.revoked) return "no active certificate to revoke";
        if (c.txId !== b.certTxId) return "certificate id mismatch";
        if (!b.reason || b.reason.length > 300) return "reason required";
        return null;
      }
      case "DOC_PUBLISH": {
        const b = tx.body as DocPublishBody;
        const sender = this.activeCert(tx.signer, time)!;
        if (!sender.body.roles.includes("sender")) return "signer is not authorised to send documents";
        if (!HEX(32).test(b.docId ?? "")) return "invalid doc id";
        if (this.docs.has(b.docId)) return "doc id already used";
        if (!HEX(64).test(b.ctSha256 ?? "") || !HEX(64).test(b.chunkRoot ?? "")) return "invalid hashes";
        if (!(b.chunkCount > 0) || !(b.size > 0)) return "empty document";
        if (!["pdf", "image"].includes(b.kind) || !["preserve", "flatten"].includes(b.pdfMode)) return "invalid kind/mode";
        if (!Array.isArray(b.recipients) || b.recipients.length === 0 || b.recipients.length > 500) return "invalid recipients";
        if (new Set(b.recipients).size !== b.recipients.length) return "duplicate recipient";
        for (const r of b.recipients) {
          const rc = this.activeCert(r, time);
          if (!rc || !rc.body.roles.includes("recipient")) return `recipient ${r} has no active recipient certificate`;
          if (!b.wrappedKeys?.[r]) return `missing wrapped key for ${r}`;
        }
        if (Object.keys(b.wrappedKeys).length !== b.recipients.length) return "wrapped keys do not match recipients";
        const vids = g.validators.map((v) => v.id).sort();
        if (canonical(Object.keys(b.validatorShares ?? {}).sort()) !== canonical(vids)) return "one key share per validator required";
        return null;
      }
      case "DECRYPT": {
        const b = tx.body as DecryptBody;
        if (b.recipientId !== tx.signer) return "a decryption record must be signed by the recipient";
        const cert = this.activeCert(tx.signer, time)!;
        if (!cert.body.roles.includes("recipient")) return "signer is not a recipient";
        const doc = this.docs.get(b.docId);
        if (!doc) return "unknown document";
        if (!doc.body.recipients.includes(b.recipientId)) return "recipient is not on the distribution list";
        if (!HEX(32).test(b.sessionId ?? "")) return "invalid session id";
        if (this.sessions.has(b.sessionId)) return "session id replayed";
        if (b.wmId !== deriveWmId(b.docId, b.recipientId, b.sessionId)) return "watermark id not derived from session";
        if (this.wmIndex.has(b.wmId)) return "watermark id collision";
        if (b.ctSha256 !== doc.body.ctSha256) return "record does not reference this document ciphertext";
        if (Math.abs(b.at - time) > CLOCK_SKEW_MS) return "decryption record timestamp outside the allowed window";
        return null;
      }
      case "DELIVERY": {
        const b = tx.body as DeliveryBody;
        const d = this.decrypts.get(b.decryptTxId);
        if (!d) return "unknown decryption record";
        if (this.deliveries.has(b.decryptTxId)) return "delivery already recorded";
        if (d.body.wmId !== b.wmId) return "watermark id mismatch";
        if (!HEX(64).test(b.deliveredSha256 ?? "")) return "invalid delivered hash";
        return null;
      }
      case "ACK": {
        const b = tx.body as AckBody;
        const d = this.decrypts.get(b.decryptTxId);
        if (!d) return "unknown decryption record";
        if (d.body.recipientId !== tx.signer) return "only the recipient can acknowledge";
        const del = this.deliveries.get(b.decryptTxId);
        if (!del) return "no delivery recorded yet";
        if (del.body.deliveredSha256 !== b.deliveredSha256) return "acknowledged file differs from the delivered file";
        if (this.acks.has(b.decryptTxId)) return "already acknowledged";
        return null;
      }
      case "FORENSIC_QUERY": {
        const cert = this.activeCert(tx.signer, time)!;
        if (!cert.body.roles.includes("investigator")) return "signer is not an investigator";
        const b = tx.body as ForensicQueryBody;
        if (!HEX(32).test(b.queryId ?? "") || !HEX(64).test(b.fileSha256 ?? "")) return "invalid query";
        if (this.queries.has(b.queryId)) return "duplicate query";
        return null;
      }
    }
    return "unhandled transaction type";
  }

  /** Apply a transaction that has already passed `check`. */
  apply(tx: Tx, height: number, index: number): void {
    const id = computeTxId(tx);
    this.txIndex.set(id, { height, index, type: tx.type, signer: tx.signer });
    switch (tx.type) {
      case "CERT_ISSUE": {
        const b = tx.body as CertBody;
        const rec: CertRecord = { body: b, txId: id, height, issuer: tx.signer };
        this.certs.set(b.userId, rec);
        this.certHistory.push(rec);
        break;
      }
      case "CERT_REVOKE": {
        const b = tx.body as CertRevokeBody;
        const c = this.certs.get(b.userId)!;
        // Records are never mutated in place, so clone() can share them safely.
        const revoked: CertRecord = { ...c, revoked: { txId: id, height, reason: b.reason } };
        this.certs.set(b.userId, revoked);
        this.certHistory = this.certHistory.map((r) => (r === c ? revoked : r));
        break;
      }
      case "DOC_PUBLISH": {
        const b = tx.body as DocPublishBody;
        this.docs.set(b.docId, { body: b, txId: id, height, sender: tx.signer });
        break;
      }
      case "DECRYPT": {
        const b = tx.body as DecryptBody;
        this.decrypts.set(id, { body: b, txId: id, height });
        this.wmIndex.set(b.wmId, id);
        this.sessions.add(b.sessionId);
        break;
      }
      case "DELIVERY": {
        const b = tx.body as DeliveryBody;
        this.deliveries.set(b.decryptTxId, { body: b, txId: id, height });
        break;
      }
      case "ACK": {
        const b = tx.body as AckBody;
        this.acks.set(b.decryptTxId, { body: b, txId: id, height });
        break;
      }
      case "FORENSIC_QUERY":
        this.queries.add((tx.body as ForensicQueryBody).queryId);
        break;
    }
  }

  /** Check-and-apply every tx of a block in order; returns the first error.
   *  Call on a clone() when the block is not yet known to be valid. */
  applyBlock(txs: Tx[], height: number, time: number): string | null {
    for (let i = 0; i < txs.length; i++) {
      const err = this.check(txs[i], time);
      if (err) return `tx ${i}: ${err}`;
      this.apply(txs[i], height, i);
    }
    this.height = height;
    return null;
  }
}

