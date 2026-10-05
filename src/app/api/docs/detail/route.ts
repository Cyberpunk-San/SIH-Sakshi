import { NextResponse, type NextRequest } from "next/server";
import type { DocRecord } from "@/lib/core/state";
import { guard, HttpError, requireSession } from "@/lib/server/http";
import { query } from "@/lib/server/ledger-client";

/** The ledger record of a document, with only the caller's own wrapped key. */
export const GET = guard(async (req: NextRequest) => {
  const s = requireSession(req);
  const docId = req.nextUrl.searchParams.get("docId") ?? "";
  const d = await query<DocRecord>(`/state/doc?docId=${encodeURIComponent(docId)}`);
  const isRecipient = d.body.recipients.includes(s.principal);
  if (!isRecipient && d.sender !== s.principal) throw new HttpError(403, "not on the distribution list");
  return NextResponse.json({
    ...d,
    body: {
      ...d.body,
      wrappedKeys: isRecipient ? { [s.principal]: d.body.wrappedKeys[s.principal] } : {},
      validatorShares: undefined,
    },
  });
});
