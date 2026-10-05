"use client";

import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "outline" | "ghost" | "danger";

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-[4px] px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45";
  const v: Record<Variant, string> = {
    primary: "bg-ink text-paper hover:bg-ink/85",
    outline: "border border-rule-2 bg-card text-ink hover:bg-paper-2",
    ghost: "text-ink-2 hover:bg-paper-2 hover:text-ink",
    danger: "bg-seal text-white hover:bg-seal/85",
  };
  return <button className={cx(base, v[variant], className)} {...p} />;
}

export const inputClass =
  "w-full rounded-[4px] border border-rule-2 bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-verdigris focus:outline-none";

export function Field({ label, hint, className, children }: { label: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-xs font-medium uppercase tracking-[0.08em] text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cx("rounded-md border border-rule bg-card", className)}>{children}</section>;
}

export function CardHeader({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-5 py-3">
      <h2 className="font-serif text-lg leading-tight">{title}</h2>
      {meta && <div className="text-xs text-ink-3">{meta}</div>}
      {children}
    </div>
  );
}

type Tone = "neutral" | "good" | "bad" | "warn" | "info";
export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  const t: Record<Tone, string> = {
    neutral: "bg-paper-2 text-ink-2 border-rule",
    good: "bg-verdigris-soft text-verdigris border-verdigris/30",
    bad: "bg-seal-soft text-seal border-seal/30",
    warn: "bg-ochre-soft text-ochre border-ochre/30",
    info: "bg-card text-ink-2 border-rule-2",
  };
  return <span className={cx("inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide", t[tone], className)}>{children}</span>;
}

export function Hash({ value, chars = 10, className }: { value: string; chars?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > chars * 2 + 1 ? `${value.slice(0, chars)}…${value.slice(-4)}` : value;
  return (
    <button
      type="button"
      title={copied ? "Copied" : `${value}\n(click to copy)`}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cx("font-mono text-[12px] text-ink-2 hover:text-ink", className)}
    >
      {copied ? "copied" : short}
    </button>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "bad" | "good" | "warn"; title?: string; children: ReactNode }) {
  const t = {
    info: "border-rule-2 bg-paper-2",
    bad: "border-seal/40 bg-seal-soft",
    good: "border-verdigris/40 bg-verdigris-soft",
    warn: "border-ochre/40 bg-ochre-soft",
  }[tone];
  return (
    <div className={cx("rounded-[4px] border px-4 py-3 text-sm", t)} role={tone === "bad" ? "alert" : undefined}>
      {title && <div className="font-medium">{title}</div>}
      <div className={title ? "mt-0.5 text-ink-2" : ""}>{children}</div>
    </div>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <header className="mb-8 border-b border-rule pb-6">
      {eyebrow && <div className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-ink-3">{eyebrow}</div>}
      <h1 className="font-serif text-3xl leading-tight sm:text-4xl">{title}</h1>
      {children && <div className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-2">{children}</div>}
    </header>
  );
}

export function Dot({ tone }: { tone: "good" | "bad" | "warn" | "idle" }) {
  const c = { good: "bg-verdigris", bad: "bg-seal", warn: "bg-ochre", idle: "bg-ink-3" }[tone];
  return <span className={cx("inline-block h-2 w-2 rounded-full", c, tone === "good" && "pulse-dot")} aria-hidden />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-5 py-12 text-center">
      <div className="font-serif text-lg">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-ink-3">{children}</div>}
    </div>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
