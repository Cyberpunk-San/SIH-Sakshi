import { NextResponse, type NextRequest } from "next/server";
import { guard } from "@/lib/server/http";
import { query } from "@/lib/server/ledger-client";

export const GET = guard(async (req: NextRequest) => {
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 25);
  return NextResponse.json(await query(`/blocks/recent?limit=${Math.min(100, Math.max(1, limit || 25))}`));
});
