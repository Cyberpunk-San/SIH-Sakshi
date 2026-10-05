import { NextResponse, type NextRequest } from "next/server";
import { sha256Hex } from "@/lib/core/bytes";
import { merkleRoot } from "@/lib/core/merkle";
import { txId, type DocPublishBody, type Tx } from "@/lib/core/ledger";
import { CHUNK_BLOB, type StoredChunk } from "@/lib/core/vault";
import type { DecryptRecord, DocRecord } from "@/lib/core/state";
import { guard, HttpError, requireSession } from "@/lib/server/http";
import { query, submitAndWait } from "@/lib/server/ledger-client";
import { removeChunks, storeChunks } from "@/lib/server/vault-store";

const MAX_DOC_BYTES = 50 * 1024 * 1024;

/** Sender uploads an already-encrypted document: chunk blobs + signed DOC_PUBLISH record. */
export const POST = guard(async (req: NextRequest) => {
  const s = requireSession(req, { role: "sender" });
  const form = await req.formData();
  const tx = JSON.parse(String(form.get("tx"))) as Tx;
  const names = JSON.parse(String(form.get("names"))) as string[];
  const blob = form.get("chunks");
  if (tx?.type !== "DOC_PUBLISH" || tx.signer !== s.principal) throw new HttpError(400, "a DOC_PUBLISH record signed by you is required");
  const body = tx.body as DocPublishBody;
  if (body.size > MAX_DOC_BYTES) throw new HttpError(413, "documents are limited to 50 MB");
  if (!(blob instanceof Blob)) throw new HttpError(400, "missing chunk data");
  const raw = new Uint8Array(await blob.arrayBuffer());
  if (!Array.isArray(names) || names.length !== body.chunkCount || raw.length !== names.length * CHUNK_BLOB)
    throw new HttpError(400, "chunk data does not match the record");
  const chunks: StoredChunk[] = names.map((name, i) => ({ name, blob: raw.subarray(i * CHUNK_BLOB, (i + 1) * CHUNK_BLOB) }));
  if (merkleRoot(chunks.map((c) => sha256Hex(c.blob))) !== body.chunkRoot) throw new HttpError(400, "chunks do not match the signed Merkle root");

  const stats = storeChunks(chunks);
  try {
    const p = await submitAndWait(tx);
    return NextResponse.json({ docId: body.docId, txId: txId(tx), height: p.inclusion.header.height, chunks: stats.stored, decoys: stats.decoys });
  } catch (e) {
    removeChunks(names);
    throw e;
  }
});

/** Inbox (documents addressed to me) and outbox (documents I sent, with access log). */
export const GET = guard(async (req: NextRequest) => {
  const s = requireSession(req);
  const me = encodeURIComponent(s.principal);
  const [inbox, sent, mine] = await Promise.all([
    s.roles.includes("recipient") ? query<{ docs: DocRecord[] }>(`/state/docs?recipient=${me}`) : { docs: [] },
    s.roles.includes("sender") ? query<{ docs: DocRecord[] }>(`/state/docs?sender=${me}`) : { docs: [] },
    s.roles.includes("recipient") ? query<{ decrypts: DecryptRecord[] }>(`/state/decrypts?recipient=${me}`) : { decrypts: [] },
  ]);
  const sessionsByDoc: Record<string, number> = {};
  for (const d of mine.decrypts) sessionsByDoc[d.body.docId] = (sessionsByDoc[d.body.docId] ?? 0) + 1;
  return NextResponse.json({
    inbox: inbox.docs.map((d) => ({ ...summary(d), mySessions: sessionsByDoc[d.body.docId] ?? 0 })),
    sent: sent.docs.map(summary),
  });
});

function summary(d: DocRecord) {
  const b = d.body;
  return {
    docId: b.docId,
    title: b.title,
    fileName: b.fileName,
    mime: b.mime,
    size: b.size,
    kind: b.kind,
    pdfMode: b.pdfMode,
    recipients: b.recipients,
    sender: d.sender,
    createdAt: b.createdAt,
    height: d.height,
    txId: d.txId,
  };
}
