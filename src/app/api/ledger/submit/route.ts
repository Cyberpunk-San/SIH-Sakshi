import { NextResponse, type NextRequest } from "next/server";
import { guard, HttpError, requireSession } from "@/lib/server/http";
import { submitAndWait } from "@/lib/server/ledger-client";
import { removeEnrolment } from "@/lib/server/enrol-store";
import { txId, type Tx } from "@/lib/core/ledger";

const ALLOWED = new Set(["CERT_ISSUE", "CERT_REVOKE", "ACK"]);

// Relays transactions signed in the browser. The signer must be the signed-in principal;
// validators independently verify signature and authorisation.
export const POST = guard(async (req: NextRequest) => {
  const s = requireSession(req);
  const { tx } = (await req.json()) as { tx: Tx };
  if (!tx || !ALLOWED.has(tx.type)) throw new HttpError(400, "transaction type not accepted on this endpoint");
  if (tx.signer !== s.principal) throw new HttpError(403, "transaction must be signed by the signed-in identity");
  const p = await submitAndWait(tx);
  if (tx.type === "CERT_ISSUE") removeEnrolment((tx.body as { userId: string }).userId);
  return NextResponse.json({ txId: txId(tx), height: p.inclusion.header.height, votes: p.inclusion.qc.length });
});
