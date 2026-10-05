import { type NextRequest } from "next/server";
import type { Tx } from "@/lib/core/ledger";
import type { Sealed } from "@/lib/core/pq";
import { guard, requireSession } from "@/lib/server/http";
import { runDecryption } from "@/lib/server/pipeline";

export const maxDuration = 300;

/**
 * Body: { tx: DECRYPT record signed by the recipient, sealedKr: K_R sealed to the gateway }
 * Returns the watermarked document. Metadata travels in headers so the body stays binary.
 */
export const POST = guard(async (req: NextRequest) => {
  const s = requireSession(req, { role: "recipient" });
  const { tx, sealedKr } = (await req.json()) as { tx: Tx; sealedKr: Sealed };
  const out = await runDecryption(s.principal, tx, sealedKr);
  const meta = {
    decryptTxId: out.decryptTxId,
    deliveryTxId: out.deliveryTxId,
    wmId: out.wmId,
    sha256: out.sha256,
    blockHeight: out.blockHeight,
    validators: out.validators,
    steps: out.steps,
    fileName: out.fileName,
  };
  return new Response(out.bytes as BodyInit, {
    headers: {
      "content-type": out.mime,
      "content-disposition": `attachment; filename="${out.fileName.replace(/[^\w.\- ]/g, "_")}"`,
      "x-sakshi-meta": Buffer.from(JSON.stringify(meta)).toString("base64"),
      "cache-control": "no-store",
    },
  });
});
