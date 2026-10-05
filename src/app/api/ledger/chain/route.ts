import { NextResponse, type NextRequest } from "next/server";
import { getGenesis } from "@/lib/server/config";
import { guard, HttpError } from "@/lib/server/http";

// Raw chain from one specific validator, so the browser can verify every block itself.
export const GET = guard(async (req: NextRequest) => {
  const id = req.nextUrl.searchParams.get("node");
  const from = Math.max(1, Number(req.nextUrl.searchParams.get("from") ?? 1) || 1);
  const v = getGenesis().body.validators.find((x) => x.id === id);
  if (!v) throw new HttpError(404, "unknown validator");
  const r = await fetch(`${v.url}/blocks?from=${from}&limit=500`, { signal: AbortSignal.timeout(8000), cache: "no-store" }).catch(() => null);
  if (!r?.ok) throw new HttpError(503, `${id} is offline`);
  return NextResponse.json(await r.json());
});
