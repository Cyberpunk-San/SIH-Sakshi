import { NextResponse, type NextRequest } from "next/server";
import type { Tx } from "@/lib/core/ledger";
import { guard, HttpError, requireSession } from "@/lib/server/http";
import { runForensics } from "@/lib/server/pipeline";

export const maxDuration = 300;

/** Investigator uploads a leaked copy + a signed FORENSIC_QUERY record. */
export const POST = guard(async (req: NextRequest) => {
  const s = requireSession(req, { role: "investigator" });
  const form = await req.formData();
  const file = form.get("file");
  const tx = JSON.parse(String(form.get("tx"))) as Tx;
  if (!(file instanceof File)) throw new HttpError(400, "file required");
  if (file.size > 60 * 1024 * 1024) throw new HttpError(413, "file too large");
  const out = await runForensics(s.principal, new Uint8Array(await file.arrayBuffer()), file.name, tx);
  return NextResponse.json(out);
});
