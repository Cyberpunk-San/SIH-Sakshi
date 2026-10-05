import { NextResponse, type NextRequest } from "next/server";
import type { AckRecord, DecryptRecord, DeliveryRecord, DocRecord } from "@/lib/core/state";
import { guard, HttpError, requireSession } from "@/lib/server/http";
import { query } from "@/lib/server/ledger-client";

type Row = DecryptRecord & { delivery: DeliveryRecord | null; ack: AckRecord | null };

/** Access log of a document: every decryption session, straight from the ledger. */
export const GET = guard(async (req: NextRequest) => {
  const s = requireSession(req);
  const docId = req.nextUrl.searchParams.get("docId") ?? "";
  const d = await query<DocRecord>(`/state/doc?docId=${encodeURIComponent(docId)}`);
  const isOwner = d.sender === s.principal;
  const isInvestigator = s.roles.includes("investigator");
  const isRecipient = d.body.recipients.includes(s.principal);
  if (!isOwner && !isInvestigator && !isRecipient) throw new HttpError(403, "not permitted");
  const { decrypts } = await query<{ decrypts: Row[] }>(`/state/decrypts?docId=${encodeURIComponent(docId)}`);
  const visible = isOwner || isInvestigator ? decrypts : decrypts.filter((x) => x.body.recipientId === s.principal);
  return NextResponse.json({
    sessions: visible
      .sort((a, b) => b.height - a.height)
      .map((x) => ({
        decryptTxId: x.txId,
        recipientId: x.body.recipientId,
        sessionId: x.body.sessionId,
        wmId: x.body.wmId,
        at: x.body.at,
        height: x.height,
        delivered: x.delivery ? { sha256: x.delivery.body.deliveredSha256, bytes: x.delivery.body.deliveredBytes, height: x.delivery.height } : null,
        acknowledged: x.ack ? { height: x.ack.height } : null,
      })),
  });
});
