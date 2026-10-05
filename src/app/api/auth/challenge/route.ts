import { NextResponse, type NextRequest } from "next/server";
import { guard, HttpError } from "@/lib/server/http";
import { issueChallenge, loginMessage, LOGIN_DOMAIN } from "@/lib/server/session";
import { getGenesis } from "@/lib/server/config";

export const POST = guard(async (req: NextRequest) => {
  const { principal } = await req.json();
  if (typeof principal !== "string" || principal.length > 64) throw new HttpError(400, "principal required");
  const nonce = issueChallenge(principal);
  return NextResponse.json({ nonce, domain: LOGIN_DOMAIN, message: loginMessage(principal, nonce, getGenesis().chainId) });
});
