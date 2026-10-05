// Self-contained forensic evidence bundle and its verifier. The verifier needs nothing but
// the bundle: it runs in the browser, in the gateway and in the offline CLI.
import { canonical, fromB64, toB64 } from "./bytes";
import {
  deriveWmId,
  verifyGenesis,
  verifyInclusion,
  verifyTxSignature,
  txId,
  type AckBody,
  type CertBody,
  type DecryptBody,
  type DeliveryBody,
  type DocPublishBody,
  type ForensicQueryBody,
  type Genesis,
  type Inclusion,
  type Tx,
} from "./ledger";
import { sign, verify } from "./pq";

export type Proven<T> = { tx: Tx & { body: T }; inclusion: Inclusion };

// Statistical values are strings: canonical JSON (what gets signed) only admits integers.
export type Extraction = {
  wmId: string;
  matchSigma: string;
  falseMatchProbability: string;
  pilotZ: string;
  bitAgreement: string;
  kind: string;
  fileSha256: string;
  fileName: string;
  extractedAt: number;
};

export type EvidenceBody = {
  format: "sakshi-evidence/v1";
  genesis: Genesis;
  extraction: Extraction;
  decrypt: Proven<DecryptBody>;
  recipientCert: Proven<CertBody>;
  doc: Proven<DocPublishBody>;
  senderCert: Proven<CertBody>;
  delivery?: Proven<DeliveryBody>;
  ack?: Proven<AckBody>;
  query?: Proven<ForensicQueryBody>;
};

export type EvidenceBundle = EvidenceBody & { attestation: { signer: string; sig: string } };

export const EVIDENCE_DOMAIN = "sakshi/evidence/v1";

export function attestEvidence(body: EvidenceBody, gatewayId: string, gatewaySk: Uint8Array): EvidenceBundle {
  const sig = toB64(sign(gatewaySk, EVIDENCE_DOMAIN, canonical(body)));
  return { ...body, attestation: { signer: gatewayId, sig } };
}

export type Check = { id: string; label: string; ok: boolean; detail: string; optional?: boolean };

export type Verdict = {
  verdict: "ATTRIBUTED" | "NOT_VERIFIED";
  checks: Check[];
  subject?: {
    userId: string;
    name: string;
    org: string;
    docId: string;
    docTitle: string;
    sessionId: string;
    decryptedAt: number;
    blockHeight: number;
    decryptTxId: string;
    exactCopy: boolean;
    acknowledged: boolean;
  };
};

export function verifyEvidence(bundle: EvidenceBundle): Verdict {
  const checks: Check[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string, optional = false) =>
    checks.push({ id, label, ok, detail, optional });
  const g = bundle.genesis;

  try {
    const gv = verifyGenesis(g);
    add("genesis", "Ledger genesis is signed by every founding validator", gv.ok, gv.ok ? `chain ${g.chainId.slice(0, 16)}…` : gv.reason!);

    const { attestation, ...body } = bundle;
    const att = attestation.signer === g.body.gateway.id &&
      verify(fromB64(g.body.gateway.dsaPk), EVIDENCE_DOMAIN, canonical(body), fromB64(attestation.sig));
    add("attestation", "Bundle attested by the forensic gateway (ML-DSA-65)", att, att ? "gateway signature valid" : "attestation signature invalid");

    const d = bundle.decrypt;
    const ex = bundle.extraction;
    add("wm-match", "Extracted watermark matches the decryption record", ex.wmId === d.tx.body.wmId,
      `extracted ${ex.wmId} · ledger ${d.tx.body.wmId} · ${ex.matchSigma}σ (false-match p ≈ ${ex.falseMatchProbability})`);
    const derived = deriveWmId(d.tx.body.docId, d.tx.body.recipientId, d.tx.body.sessionId);
    add("wm-derived", "Watermark is bound to this recipient's session", derived === d.tx.body.wmId,
      `H(doc, recipient, session) = ${derived}`);

    const di = verifyInclusion(g, d.tx, d.inclusion);
    add("decrypt-ledger", "Decryption record is committed on the ledger", di === null,
      di ?? `block #${d.inclusion.header.height}, ${d.inclusion.qc.length} validator signatures, Merkle proof valid`);

    const c = bundle.recipientCert;
    const ci = verifyInclusion(g, c.tx, c.inclusion);
    const registrar = g.body.registrars.find((r) => r.id === c.tx.signer);
    const certSig = !!registrar && verifyTxSignature(c.tx, registrar.dsaPk);
    const certOk = ci === null && certSig && c.tx.type === "CERT_ISSUE" && c.tx.body.userId === d.tx.signer &&
      c.inclusion.header.height <= d.inclusion.header.height;
    add("identity", "Recipient identity certificate issued by a genesis registrar", certOk,
      certOk ? `${c.tx.body.name} (${c.tx.body.org}) certified by ${registrar!.name} at block #${c.inclusion.header.height}` : ci ?? "certificate does not match signer");

    const nonRep = verifyTxSignature(d.tx, c.tx.body.dsaPk);
    add("non-repudiation", "Decryption record signed with the recipient's own ML-DSA-65 key", nonRep,
      nonRep ? "only the holder of this private key could have produced this signature" : "signature does not verify");

    const doc = bundle.doc;
    const docI = verifyInclusion(g, doc.tx, doc.inclusion);
    const sc = bundle.senderCert;
    const scI = verifyInclusion(g, sc.tx, sc.inclusion);
    const docOk = docI === null && scI === null && sc.tx.body.userId === doc.tx.signer &&
      verifyTxSignature(doc.tx, sc.tx.body.dsaPk) && doc.tx.body.docId === d.tx.body.docId &&
      doc.tx.body.ctSha256 === d.tx.body.ctSha256 && doc.tx.body.recipients.includes(d.tx.body.recipientId);
    add("distribution", "Document was distributed to this recipient by an authorised sender", docOk,
      docOk ? `"${doc.tx.body.title}" sent by ${sc.tx.body.name} to ${doc.tx.body.recipients.length} recipient(s)` : docI ?? scI ?? "document record mismatch");

    let exactCopy = false;
    if (bundle.delivery) {
      const del = bundle.delivery;
      const ok = verifyInclusion(g, del.tx, del.inclusion) === null && del.tx.signer === g.body.gateway.id &&
        verifyTxSignature(del.tx, g.body.gateway.dsaPk) && del.tx.body.wmId === d.tx.body.wmId;
      exactCopy = ok && del.tx.body.deliveredSha256 === ex.fileSha256;
      add("delivery", "Gateway recorded delivery of the watermarked copy", ok,
        ok ? (exactCopy ? "leaked file is byte-identical to the delivered copy" : "leaked file was modified after delivery (watermark survived)") : "delivery record invalid", true);
    }
    let acknowledged = false;
    if (bundle.ack) {
      const a = bundle.ack;
      acknowledged = verifyInclusion(g, a.tx, a.inclusion) === null && a.tx.signer === d.tx.signer &&
        verifyTxSignature(a.tx, c.tx.body.dsaPk) && a.tx.body.decryptTxId === bundle.delivery?.tx.body.decryptTxId &&
        a.tx.body.deliveredSha256 === bundle.delivery?.tx.body.deliveredSha256;
      add("ack", "Recipient signed receipt of exactly that file", acknowledged,
        acknowledged ? "receipt signed with the recipient's key" : "receipt invalid", true);
    }

    const required = checks.filter((x) => !x.optional);
    const verdict = required.every((x) => x.ok) ? "ATTRIBUTED" : "NOT_VERIFIED";
    return {
      verdict,
      checks,
      subject: {
        userId: d.tx.body.recipientId,
        name: c.tx.body.name,
        org: c.tx.body.org,
        docId: d.tx.body.docId,
        docTitle: doc.tx.body.title,
        sessionId: d.tx.body.sessionId,
        decryptedAt: d.tx.body.at,
        blockHeight: d.inclusion.header.height,
        decryptTxId: txId(d.tx),
        exactCopy,
        acknowledged,
      },
    };
  } catch (e) {
    add("format", "Evidence bundle is well-formed", false, (e as Error).message);
    return { verdict: "NOT_VERIFIED", checks };
  }
}
