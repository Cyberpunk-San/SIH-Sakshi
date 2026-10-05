import { NextResponse, type NextRequest } from "next/server";
import { guard } from "@/lib/server/http";
import { query } from "@/lib/server/ledger-client";

export const GET = guard(async (req: NextRequest) => {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  return NextResponse.json(await query(`/tx?id=${encodeURIComponent(id)}`));
});
