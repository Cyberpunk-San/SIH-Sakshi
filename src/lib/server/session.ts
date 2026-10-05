import "server-only";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { secrets, getGenesis } from "./config";
import { query, LedgerError } from "./ledger-client";
import type { CertRecord } from "@/lib/core/state";
import type { Role } from "@/lib/core/ledger";

// Passwordless login: the browser proves possession of its ML-DSA private key by signing
// a one-time server challenge. The session is an HMAC-signed cookie.

export const COOKIE = "sakshi_session";
const TTL_MS = 8 * 3600 * 1000;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

export type Session = {
  principal: string;
  kind: "user" | "registrar";
  name: string;
  roles: Role[];
  exp: number;
};

const challenges = ((globalThis as unknown as { __sakshiChallenges?: Map<string, { principal: string; exp: number }> }).__sakshiChallenges ??=
  new Map());

export const LOGIN_DOMAIN = "sakshi/login/v1";
export const loginMessage = (principal: string, nonce: string, chainId: string) => `${chainId}:${principal}:${nonce}`;

export function issueChallenge(principal: string): string {
  const nonce = randomBytes(24).toString("hex");
  const now = Date.now();
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
  challenges.set(nonce, { principal, exp: now + CHALLENGE_TTL_MS });
  return nonce;
}

export function consumeChallenge(nonce: string, principal: string): boolean {
  const c = challenges.get(nonce);
  challenges.delete(nonce);
  return !!c && c.principal === principal && c.exp > Date.now();
}

/** Resolve the public signing key and profile for a principal from genesis / the ledger. */
export async function resolvePrincipal(principal: string) {
  const g = getGenesis().body;
  const reg = g.registrars.find((r) => r.id === principal);
  if (reg) return { kind: "registrar" as const, name: reg.name, roles: [] as Role[], dsaPk: reg.dsaPk };
  try {
    const c = await query<CertRecord>(`/state/cert?userId=${encodeURIComponent(principal)}`);
    if (c.revoked) return null;
    if (Date.now() > c.body.expiresAt) return null;
    return { kind: "user" as const, name: c.body.name, roles: c.body.roles, dsaPk: c.body.dsaPk };
  } catch (e) {
    if (e instanceof LedgerError && e.status === 404) return null;
    throw e;
  }
}

function mac(payload: string) {
  return createHmac("sha256", Buffer.from(secrets().session, "hex")).update(payload).digest("base64url");
}

export function encodeSession(s: Omit<Session, "exp">): string {
  const payload = Buffer.from(JSON.stringify({ ...s, exp: Date.now() + TTL_MS })).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

export function readSession(req: NextRequest): Session | null {
  const raw = req.cookies.get(COOKIE)?.value;
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
  return s.exp > Date.now() ? s : null;
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.SAKSHI_SECURE_COOKIES === "1",
  path: "/",
  maxAge: TTL_MS / 1000,
};
