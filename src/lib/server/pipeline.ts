import "server-only";
import { canonical, randomHex, sha256Hex, toB64, utf8 } from "@/lib/core/bytes";
import {
  signTx,
  txId,
  type CertBody,
  type DecryptBody,
  type DocPublishBody,
  type ForensicQueryBody,
  type Tx,
} from "@/lib/core/ledger";
import { open, sign, type Sealed } from "@/lib/core/pq";
import { decodeShare, krAad, reassembleAndDecrypt } from "@/lib/core/vault";
import { attestEvidence, verifyEvidence, type EvidenceBody, type EvidenceBundle, type Proven, type Verdict } from "@/lib/core/evidence";
import type { CertRecord, DocRecord, DecryptRecord, DeliveryRecord, AckRecord } from "@/lib/core/state";
import { gatewayIdentity, getGenesis } from "./config";
import { HttpError } from "./http";
import { proof, query, submitAndWait, LedgerError } from "./ledger-client";
import { readChunk } from "./vault-store";
import { embedWatermark, extractWatermark, type ExtractResult } from "./wm-client";

export const RELEASE_DOMAIN = "sakshi/release/v1";

type Step = { step: string; ms: number; detail?: string };

function timer() {
  const steps: Step[] = [];
  let t = Date.now();
  return {
    steps,
    mark(step: string, detail?: string) {
      const now = Date.now();
      steps.push({ step, ms: now - t, detail });
      t = now;
    },
  };
}

/** Ask every validator for its K_G share; succeed once the threshold is met. */
async function collectShares(decryptTxId: string) {
  const g = getGenesis().body;
  const gw = await gatewayIdentity();
  const ask = (v: (typeof g.validators)[number]) =>
    (async () => {
      const at = Date.now();
      const nonce = randomHex(16);
      const sig = toB64(sign(gw.dsa.secretKey, RELEASE_DOMAIN, canonical({ decryptTxId, nonce, at, validator: v.id })));
      try {
        const r = await fetch(`${v.url}/release`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decryptTxId, nonce, at, sig }),
          signal: AbortSignal.timeout(5000),
        });
        const j = await r.json();
        if (!r.ok) return { id: v.id, error: j.error as string };
        const raw = open(gw.kem.secretKey, j.share as Sealed, "release", utf8(`${decryptTxId}/${v.id}`));
        return { id: v.id, share: decodeShare(raw) };
      } catch (e) {
        return { id: v.id, error: (e as Error).message };
      }
    })();
  const results = await Promise.all(g.validators.map(ask));
  if (results.filter((r) => r.share).length < g.shareThreshold) {
    // A validator may still be applying the block; ask the ones that refused once more.
    await new Promise((r) => setTimeout(r, 800));
    for (let i = 0; i < results.length; i++) {
      if (!results[i].share) results[i] = await ask(g.validators[i]);
    }
  }
  const ok = results.filter((r) => r.share);
  if (ok.length < g.shareThreshold) {
    const why = results.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`).join("; ");
    throw new HttpError(503, `only ${ok.length}/${g.shareThreshold} validators released their key share (${why})`);
  }
  return { shares: ok.slice(0, g.shareThreshold).map((r) => r.share!), released: ok.map((r) => r.id), refused: results.filter((r) => r.error) };
}

export type DecryptOutcome = {
  bytes: Uint8Array;
  mime: string;
  fileName: string;
  decryptTxId: string;
  deliveryTxId: string;
  wmId: string;
  sha256: string;
  blockHeight: number;
  steps: Step[];
  validators: string[];
};

export async function runDecryption(principal: string, tx: Tx, sealedKr: Sealed): Promise<DecryptOutcome> {
  if (tx?.type !== "DECRYPT") throw new HttpError(400, "expected a DECRYPT record");
  if (tx.signer !== principal) throw new HttpError(403, "the decryption record must be signed by the signed-in recipient");
  const body = tx.body as DecryptBody;
  const t = timer();
  let doc: DocRecord;
  try {
    doc = await query<DocRecord>(`/state/doc?docId=${encodeURIComponent(body.docId)}`);
  } catch (e) {
    if (e instanceof LedgerError && e.status === 404) throw new HttpError(404, "unknown document");
    throw e;
  }

  // 1. Commit the recipient-signed record first. No commit, no plaintext (fail closed).
  const committed = await submitAndWait(tx);
  const decryptTxId = txId(tx);
  t.mark("record-committed", `block #${committed.inclusion.header.height}, ${committed.inclusion.qc.length} validator signatures`);

  // 2. Threshold release of K_G by the validators (each re-checks the committed record).
  const { shares, released } = await collectShares(decryptTxId);
  t.mark("shares-released", `${released.length} of ${getGenesis().body.validators.length} validators released (${released.join(", ")})`);

  // 3. Recipient half, bound to this exact record.
  const gw = await gatewayIdentity();
  let kr: Uint8Array;
  try {
    kr = open(gw.kem.secretKey, sealedKr, "kr", krAad(decryptTxId));
  } catch {
    throw new HttpError(400, "recipient key half could not be opened for this session");
  }

  // 4. Unjumble chunks, verify against the ledger, decrypt in memory.
  let plaintext: Uint8Array;
  try {
    plaintext = reassembleAndDecrypt(kr, shares, doc.body.docId, doc.body.chunkCount, doc.body.chunkRoot, doc.body.ctSha256, readChunk);
  } finally {
    kr.fill(0);
    shares.forEach((s) => s.y.fill(0));
  }
  t.mark("decrypted", `${doc.body.chunkCount} chunk(s) located and verified against Merkle root`);

  // 5. Session-specific invisible watermark (engine self-verifies before returning).
  const marked = await embedWatermark(plaintext, body.wmId, doc.body.pdfMode);
  plaintext.fill(0);
  t.mark("watermarked", `wm ${body.wmId} embedded and read back (${marked.selfCheckSigma}σ)`);

  // 6. Delivery record: binds the exact bytes handed to the recipient.
  const deliveredSha256 = sha256Hex(marked.bytes);
  const delivery = signTx(
    "DELIVERY",
    {
      decryptTxId,
      wmId: body.wmId,
      deliveredSha256,
      deliveredBytes: marked.bytes.length,
      mime: marked.mime,
      selfCheckSigma: Math.round(marked.selfCheckSigma * 100),
      at: Date.now(),
    },
    getGenesis().body.gateway.id,
    gw.dsa.secretKey,
  );
  const deliveryProof = await submitAndWait(delivery);
  t.mark("delivery-recorded", `block #${deliveryProof.inclusion.header.height}`);

  return {
    bytes: marked.bytes,
    mime: marked.mime,
    fileName: doc.body.fileName,
    decryptTxId,
    deliveryTxId: txId(delivery),
    wmId: body.wmId,
    sha256: deliveredSha256,
    blockHeight: committed.inclusion.header.height,
    steps: t.steps,
    validators: released,
  };
}

// ------------------------------------------------------------------ forensics

function certActiveAt(history: CertRecord[], userId: string, height: number): CertRecord | undefined {
  return history
    .filter((c) => c.body.userId === userId && c.height <= height && (!c.revoked || c.revoked.height > height))
    .sort((a, b) => b.height - a.height)[0];
}

async function proven<T>(id: string): Promise<Proven<T>> {
  const p = await proof(id);
  if (!p) throw new HttpError(500, `ledger record ${id.slice(0, 12)} missing`);
  return p as unknown as Proven<T>;
}

export type ForensicOutcome = {
  queryTxId: string;
  extraction: ExtractResult;
  bundle?: EvidenceBundle;
  verdict?: Verdict;
  message?: string;
};

export async function runForensics(principal: string, file: Uint8Array, fileName: string, queryTx: Tx): Promise<ForensicOutcome> {
  if (queryTx?.type !== "FORENSIC_QUERY" || queryTx.signer !== principal) throw new HttpError(400, "a signed forensic query is required");
  const q = queryTx.body as ForensicQueryBody;
  const fileSha256 = sha256Hex(file);
  if (q.fileSha256 !== fileSha256) throw new HttpError(400, "query does not reference the uploaded file");

  // The investigation itself is logged immutably before any result is produced.
  const queryProof = await submitAndWait(queryTx);
  const queryTxId = txId(queryTx);

  const extraction = await extractWatermark(file, fileName);
  if (!extraction.found || !extraction.wm_id) {
    return { queryTxId, extraction, message: extraction.reason ?? "no Sakshi watermark found in this file" };
  }

  let decryptTxId: string;
  try {
    decryptTxId = (await query<{ decryptTxId: string }>(`/wm?id=${extraction.wm_id}`)).decryptTxId;
  } catch (e) {
    if (e instanceof LedgerError && e.status === 404)
      return { queryTxId, extraction, message: "a watermark was recovered but no decryption on this ledger carries it" };
    throw e;
  }

  const decrypt = await proven<DecryptBody>(decryptTxId);
  const dh = decrypt.inclusion.header.height;
  const { certs } = await query<{ certs: CertRecord[] }>("/state/certs");
  const rc = certActiveAt(certs, decrypt.tx.body.recipientId, dh);
  if (!rc) throw new HttpError(500, "recipient certificate not found");
  const docRec = await query<DocRecord>(`/state/doc?docId=${decrypt.tx.body.docId}`);
  const sc = certActiveAt(certs, docRec.sender, docRec.height);
  if (!sc) throw new HttpError(500, "sender certificate not found");
  const { decrypts } = await query<{ decrypts: (DecryptRecord & { delivery: DeliveryRecord | null; ack: AckRecord | null })[] }>(
    `/state/decrypts?docId=${decrypt.tx.body.docId}`,
  );
  const rec = decrypts.find((d) => d.txId === decryptTxId);

  const body: EvidenceBody = {
    format: "sakshi-evidence/v1",
    genesis: getGenesis(),
    extraction: {
      wmId: extraction.wm_id,
      matchSigma: (extraction.match_sigma ?? 0).toFixed(2),
      falseMatchProbability: (extraction.false_match_probability ?? 1).toExponential(2),
      pilotZ: (extraction.pilot_z ?? 0).toFixed(2),
      bitAgreement: (extraction.bit_agreement ?? 0).toFixed(4),
      kind: extraction.kind ?? "unknown",
      fileSha256,
      fileName: fileName.slice(0, 200),
      extractedAt: Date.now(),
    },
    decrypt,
    recipientCert: await proven<CertBody>(rc.txId),
    doc: await proven<DocPublishBody>(docRec.txId),
    senderCert: await proven<CertBody>(sc.txId),
    delivery: rec?.delivery ? await proven(rec.delivery.txId) : undefined,
    ack: rec?.ack ? await proven(rec.ack.txId) : undefined,
    query: { tx: queryProof.tx as Tx & { body: ForensicQueryBody }, inclusion: queryProof.inclusion },
  };
  const gw = await gatewayIdentity();
  const bundle = attestEvidence(body, getGenesis().body.gateway.id, gw.dsa.secretKey);
  return { queryTxId, extraction, bundle, verdict: verifyEvidence(bundle) };
}
