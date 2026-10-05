import { NextResponse, type NextRequest } from "next/server";
import { readSession } from "@/lib/server/session";

export async function GET(req: NextRequest) {
  return NextResponse.json({ session: readSession(req) });
}
