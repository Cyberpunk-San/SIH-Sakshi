// Client-side protocol flows. Used by the browser UI and by the headless end-to-end test,
// so both exercise exactly the same cryptography. Private keys never leave this code.
import { fromB64, randomHex, sha256Hex, toB64 } from "@/lib/core/bytes";
import {
  deriveWmId,
  signTx,
  txId,
  type CertBody,
  type DocPublishBody,
  type Genesis,
  type Role,
  type Tx,
} from "@/lib/core/ledger";
import { seal, sign, type Identity, type Sealed } from "@/lib/core/pq";
import { ENROL_DOMAIN, enrolPayload } from "@/lib/core/state";
import { encryptDocument, krAad, unwrapRecipientKey } from "@/lib/core/vault";
import { verifyEvidence, type EvidenceBundle, type Verdict } from "@/lib/core/evidence";

export type NetConfig = {
  chainId: string;
  network: string;
  quorum: number;
  shareThreshold: number;
  validators: { id: string; name: string; kemPk: string; dsaPk: string }[];
  registrars: { id: string; name: string; dsaPk: string }[];
  gateway: { id: string; dsaPk: string; kemPk: string };
  genesis: Genesis;
};

export type Session = { principal: string; kind: "user" | "registrar"; name: string; roles: Role[] };

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export class Api {
  constructor(private base = "", private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  async raw(path: string, init?: RequestInit): Promise<Response> {
    const r = await this.fetchFn(this.base + path, init);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new ApiError(j.error ?? `${r.status} ${r.statusText}`, r.status);
    }
    return r;
  }

  async get<T>(path: string): Promise<T> {
    return (await this.raw(path, { cache: "no-store" })).json();
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.raw(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  }

  config = () => this.get<NetConfig>("/api/config");
}

// ------------------------------------------------------------------ identity

export function enrolmentRequest(id: Identity, userId: string, name: string, org: string, roles: Role[], note = "") {
  const dsaPk = toB64(id.dsa.publicKey);
  const kemPk = toB64(id.kem.publicKey);
  const popSig = toB64(sign(id.dsa.secretKey, ENROL_DOMAIN, enrolPayload({ userId, name, org, dsaPk, kemPk })));
  return { userId, name, org, dsaPk, kemPk, popSig, requestedRoles: roles, note };
}

export async function login(api: Api, principal: string, id: Identity): Promise<Session> {
  const ch = await api.post<{ nonce: string; domain: string; message: string }>("/api/auth/challenge", { principal });
  const sig = toB64(sign(id.dsa.secretKey, ch.domain, ch.message));
  return api.post<Session>("/api/auth/login", { principal, nonce: ch.nonce, sig });
}

export type Enrolment = ReturnType<typeof enrolmentRequest> & { submittedAt: number };

/** Registrar approves an enrolment: signs a CERT_ISSUE record with the registrar key. */
export async function approveEnrolment(api: Api, registrar: Identity, registrarId: string, e: Enrolment, roles: Role[], validDays = 365) {
  const now = Date.now();
  const body: CertBody = {
    userId: e.userId,
    name: e.name,
    org: e.org,
    roles,
    dsaPk: e.dsaPk,
    kemPk: e.kemPk,
    issuedAt: now,
    expiresAt: now + validDays * 86400_000,
    popSig: e.popSig,
  };
  const tx = signTx("CERT_ISSUE", body, registrarId, registrar.dsa.secretKey);
  return api.post<{ txId: string; height: number }>("/api/ledger/submit", { tx });
}

export async function revokeCertificate(api: Api, registrar: Identity, registrarId: string, userId: string, certTxId: string, reason: string) {
  const tx = signTx("CERT_REVOKE", { userId, certTxId, reason, at: Date.now() }, registrarId, registrar.dsa.secretKey);
  return api.post<{ txId: string; height: number }>("/api/ledger/submit", { tx });
}

// ------------------------------------------------------------------ sender

export type Person = { userId: string; name: string; org: string; roles: Role[]; kemPk: string; dsaPk: string; status: string };

export function sniffKind(bytes: Uint8Array): "pdf" | "image" | null {
  const h = (n: number) => Array.from(bytes.subarray(0, n));
  const eq = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (eq([0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (eq([0x89, 0x50, 0x4e, 0x47]) || eq([0xff, 0xd8, 0xff]) || eq([0x42, 0x4d]) || eq([0x49, 0x49, 0x2a, 0]) || eq([0x4d, 0x4d, 0, 0x2a])) return "image";
  if (eq([0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...h(12).slice(8)) === "WEBP") return "image";
  return null;
}

export async function sendDocument(
  api: Api,
  cfg: NetConfig,
  sender: Identity,
  senderId: string,
  file: { bytes: Uint8Array; name: string; mime: string },
  title: string,
  recipients: Person[],
  pdfMode: "preserve" | "flatten",
  onStep?: (s: string) => void,
) {
  const kind = sniffKind(file.bytes);
  if (!kind) throw new Error("Only PDF and image files (PNG, JPEG, WEBP, BMP, TIFF) are supported.");
  const docId = randomHex(16);
  onStep?.("Encrypting with AES-256-GCM and wrapping keys with ML-KEM-768");
  const enc = encryptDocument(
    file.bytes,
    docId,
    recipients.map((r) => ({ userId: r.userId, kemPk: r.kemPk })),
    cfg.validators.map((v) => ({ id: v.id, kemPk: v.kemPk })),
    cfg.shareThreshold,
  );
  const body: DocPublishBody = {
    docId,
    title: title.slice(0, 200),
    fileName: file.name.slice(0, 200),
    mime: file.mime || (kind === "pdf" ? "application/pdf" : "application/octet-stream"),
    size: file.bytes.length,
    kind,
    pdfMode,
    ctSha256: enc.ctSha256,
    chunkCount: enc.chunks.length,
    chunkRoot: enc.chunkRoot,
    recipients: recipients.map((r) => r.userId),
    wrappedKeys: enc.wrappedKeys,
    validatorShares: enc.validatorShares,
    createdAt: Date.now(),
  };
  onStep?.("Signing the distribution record with ML-DSA-65");
  const tx = signTx("DOC_PUBLISH", body, senderId, sender.dsa.secretKey);
  const all = new Uint8Array(enc.chunks.reduce((n, c) => n + c.blob.length, 0));
  let off = 0;
  for (const c of enc.chunks) {
    all.set(c.blob, off);
    off += c.blob.length;
  }
  const form = new FormData();
  form.append("tx", JSON.stringify(tx));
  form.append("names", JSON.stringify(enc.chunks.map((c) => c.name)));
  form.append("chunks", new Blob([all as BlobPart]), "chunks.bin");
  onStep?.(`Uploading ${enc.chunks.length} jumbled chunk(s) and committing to the ledger`);
  const r = await api.raw("/api/docs", { method: "POST", body: form });
  return (await r.json()) as { docId: string; txId: string; height: number; chunks: number; decoys: number };
}

// ------------------------------------------------------------------ recipient

export type DecryptMeta = {
  decryptTxId: string;
  deliveryTxId: string;
  wmId: string;
  sha256: string;
  blockHeight: number;
  validators: string[];
  steps: { step: string; ms: number; detail?: string }[];
  fileName: string;
};

export async function decryptDocument(
  api: Api,
  cfg: NetConfig,
  me: Identity,
  myId: string,
  docId: string,
  userAgent: string,
  onStep?: (s: string) => void,
): Promise<{ bytes: Uint8Array; mime: string; meta: DecryptMeta; ackTxId: string }> {
  const doc = await api.get<{ body: DocPublishBody }>(`/api/docs/detail?docId=${docId}`);
  const wrapped = doc.body.wrappedKeys[myId];
  if (!wrapped) throw new Error("You are not on this document's distribution list.");
  onStep?.("Recovering your key half with your ML-KEM-768 private key");
  const kr = unwrapRecipientKey(me.kem.secretKey, docId, myId, wrapped);
  const sessionId = randomHex(16);
  onStep?.("Signing the decryption record with your ML-DSA-65 private key");
  const tx = signTx(
    "DECRYPT",
    {
      docId,
      recipientId: myId,
      sessionId,
      wmId: deriveWmId(docId, myId, sessionId),
      ctSha256: doc.body.ctSha256,
      at: Date.now(),
      userAgent: userAgent.slice(0, 160),
    },
    myId,
    me.dsa.secretKey,
  );
  const sealedKr: Sealed = seal(fromB64(cfg.gateway.kemPk), kr, "kr", krAad(txId(tx)));
  kr.fill(0);
  onStep?.("Committing record to the ledger, collecting validator key shares, watermarking");
  const r = await api.raw("/api/decrypt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx, sealedKr }),
  });
  const meta = JSON.parse(new TextDecoder().decode(fromB64(r.headers.get("x-sakshi-meta") ?? ""))) as DecryptMeta;
  const bytes = new Uint8Array(await r.arrayBuffer());
  const sha = sha256Hex(bytes);
  if (sha !== meta.sha256) throw new Error("Delivered file does not match the gateway's delivery record.");
  onStep?.("Signing receipt of the exact file you received");
  const ack = signTx("ACK", { decryptTxId: meta.decryptTxId, deliveredSha256: sha, at: Date.now() }, myId, me.dsa.secretKey);
  const ackRes = await api.post<{ txId: string }>("/api/ledger/submit", { tx: ack });
  return { bytes, mime: r.headers.get("content-type") ?? "application/octet-stream", meta, ackTxId: ackRes.txId };
}

// ------------------------------------------------------------------ investigator

export type ForensicResult = {
  queryTxId: string;
  extraction: {
    found: boolean;
    wm_id?: string | null;
    reason?: string;
    pilot_z?: number;
    match_sigma?: number;
    false_match_probability?: number;
    bit_agreement?: number;
    scale?: number;
    kind?: string;
    elapsed_ms?: number;
  };
  bundle?: EvidenceBundle;
  verdict?: Verdict;
  message?: string;
};

export async function investigate(api: Api, me: Identity, myId: string, file: { bytes: Uint8Array; name: string }) {
  const tx: Tx = signTx(
    "FORENSIC_QUERY",
    { queryId: randomHex(16), fileSha256: sha256Hex(file.bytes), fileName: file.name.slice(0, 200), at: Date.now() },
    myId,
    me.dsa.secretKey,
  );
  const form = new FormData();
  form.append("tx", JSON.stringify(tx));
  form.append("file", new Blob([file.bytes as BlobPart]), file.name);
  const r = await api.raw("/api/forensics", { method: "POST", body: form });
  const out = (await r.json()) as ForensicResult;
  // Independent re-verification on this machine: do not just trust the gateway's verdict.
  const local = out.bundle ? verifyEvidence(out.bundle) : undefined;
  return { ...out, localVerdict: local };
}
