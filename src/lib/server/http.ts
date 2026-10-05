import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { readSession, type Session } from "./session";
import { LedgerError } from "./ledger-client";
import type { Role } from "@/lib/core/ledger";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function fail(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
  if (e instanceof LedgerError) return NextResponse.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
  console.error("[gateway]", e);
  return NextResponse.json({ error: (e as Error)?.message ?? "internal error" }, { status: 500 });
}

type Opts = { role?: Role; registrar?: boolean };

export function requireSession(req: NextRequest, opts: Opts = {}): Session {
  const s = readSession(req);
  if (!s) throw new HttpError(401, "sign in required");
  if (opts.registrar && s.kind !== "registrar") throw new HttpError(403, "registrar only");
  if (opts.role && !s.roles.includes(opts.role)) throw new HttpError(403, `requires the ${opts.role} role`);
  return s;
}

export function guard<C>(handler: (req: NextRequest, ctx: C) => Promise<Response>) {
  return async (req: NextRequest, ctx: C) => {
    try {
      return await handler(req, ctx);
    } catch (e) {
      return fail(e);
    }
  };
}
