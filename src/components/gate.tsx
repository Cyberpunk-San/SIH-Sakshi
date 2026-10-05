"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { Role } from "@/lib/core/ledger";
import type { Session } from "@/lib/client/flows";
import { useIdentity } from "./identity";
import { Notice } from "./ui";

export function Gate({ role, registrar, children }: { role?: Role; registrar?: boolean; children: (s: Session) => ReactNode }) {
  const { session, ready } = useIdentity();
  if (!ready) return <div className="py-16 text-center text-sm text-ink-3">Loading…</div>;
  if (!session)
    return (
      <div className="mx-auto max-w-md py-16">
        <Notice title="Sign in required">
          <Link href="/login" className="underline underline-offset-4">Sign in with your key</Link> to continue.
        </Notice>
      </div>
    );
  if ((registrar && session.kind !== "registrar") || (role && !session.roles.includes(role)))
    return (
      <div className="mx-auto max-w-md py-16">
        <Notice tone="warn" title="Not authorised">
          Your certificate does not include the {registrar ? "registrar" : role} role.
        </Notice>
      </div>
    );
  return <>{children(session)}</>;
}
