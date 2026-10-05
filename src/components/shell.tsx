"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useIdentity } from "./identity";
import { cx } from "./ui";

type NavItem = { href: string; label: string; show: (roles: string[], kind?: string) => boolean };

const NAV: NavItem[] = [
  { href: "/inbox", label: "Inbox", show: (r) => r.includes("recipient") },
  { href: "/send", label: "Distribute", show: (r) => r.includes("sender") },
  { href: "/sent", label: "Access log", show: (r) => r.includes("sender") },
  { href: "/forensics", label: "Forensics", show: (r) => r.includes("investigator") },
  { href: "/admin", label: "Registry", show: (_r, k) => k === "registrar" },
  { href: "/ledger", label: "Ledger", show: () => true },
];

export function Shell({ children }: { children: ReactNode }) {
  const { session, identity, signOut, configError } = useIdentity();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => (session ? n.show(session.roles, session.kind) : n.href === "/ledger"));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-rule bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Sakshi home">
            <Seal />
            <span className="font-serif text-xl tracking-tight">Sakshi</span>
          </Link>
          <nav className="hidden flex-1 items-center gap-1 md:flex" aria-label="Main">
            {items.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cx(
                  "rounded-[4px] px-2.5 py-1.5 text-sm",
                  path.startsWith(n.href) ? "bg-paper-2 text-ink" : "text-ink-2 hover:text-ink",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            {session ? (
              <div className="hidden items-center gap-3 md:flex">
                <div className="text-right leading-tight">
                  <div className="text-sm">{session.name}</div>
                  <div className="font-mono text-[11px] text-ink-3">
                    {session.principal} · {identity ? "key unlocked" : "key locked"}
                  </div>
                </div>
                <button
                  className="rounded-[4px] border border-rule-2 px-2.5 py-1.5 text-sm text-ink-2 hover:text-ink"
                  onClick={async () => {
                    await signOut();
                    router.push("/login");
                  }}
                >
                  Sign out
                </button>
              </div>
            ) : (
              <div className="hidden gap-2 md:flex">
                <Link href="/enrol" className="rounded-[4px] px-2.5 py-1.5 text-sm text-ink-2 hover:text-ink">Enrol</Link>
                <Link href="/login" className="rounded-[4px] bg-ink px-3 py-1.5 text-sm text-paper">Sign in</Link>
              </div>
            )}
            <button className="rounded-[4px] border border-rule-2 px-2 py-1 text-sm md:hidden" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu">
              Menu
            </button>
          </div>
        </div>
        {open && (
          <div className="border-t border-rule bg-paper px-4 py-3 md:hidden">
            {items.map((n) => (
              <Link key={n.href} href={n.href} className="block py-2 text-sm" onClick={() => setOpen(false)}>{n.label}</Link>
            ))}
            {session ? (
              <button className="mt-2 py-2 text-sm text-seal" onClick={async () => { await signOut(); router.push("/login"); }}>
                Sign out {session.principal}
              </button>
            ) : (
              <>
                <Link href="/enrol" className="block py-2 text-sm">Enrol</Link>
                <Link href="/login" className="block py-2 text-sm">Sign in</Link>
              </>
            )}
          </div>
        )}
      </header>
      {configError && (
        <div className="border-b border-seal/40 bg-seal-soft px-4 py-2 text-center text-sm text-seal">
          Gateway not ready: {configError}
        </div>
      )}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">{children}</main>
      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-ink-3 sm:px-6">
          <span>Sakshi · runs fully offline · ML-KEM-768 · ML-DSA-65 · AES-256-GCM</span>
          <span>No cloud KMS · no public blockchain</span>
        </div>
      </footer>
    </div>
  );
}

function Seal() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="var(--seal)" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="var(--seal)" strokeWidth="0.75" strokeDasharray="1.5 1.5" />
      <path d="M10.5 16.5c1.8-3.6 4-5.4 5.5-5.4s3.7 1.8 5.5 5.4c-1.8 3.4-4 5.1-5.5 5.1s-3.7-1.7-5.5-5.1z" fill="none" stroke="var(--seal)" strokeWidth="1.3" />
      <circle cx="16" cy="16.3" r="2" fill="var(--seal)" />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string | null>(null);
  // The theme lives on <html> (set before paint); read it once after hydration.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setTheme(document.documentElement.dataset.theme ?? null), []);
  const next = theme === "dark" ? "light" : theme === "light" ? null : "dark";
  const label = theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Auto";
  return (
    <button
      className="rounded-[4px] px-2 py-1.5 text-xs text-ink-3 hover:text-ink"
      title="Theme: auto → dark → light"
      onClick={() => {
        if (next) document.documentElement.dataset.theme = next;
        else delete document.documentElement.dataset.theme;
        try {
          if (next) localStorage.setItem("sakshi.theme", next);
          else localStorage.removeItem("sakshi.theme");
        } catch {}
        setTheme(next);
      }}
    >
      {label}
    </button>
  );
}
