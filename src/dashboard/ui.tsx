import type { ButtonHTMLAttributes, ReactNode } from "react";

type Tone = "cyan" | "red" | "amber" | "slate";

const toneOn: Record<Tone, string> = {
  cyan: "border-cyan-400/70 bg-cyan-400/15 text-cyan-200 shadow-[0_0_14px_-4px_rgba(34,211,238,0.7)]",
  red: "border-red-500/70 bg-red-500/15 text-red-200 shadow-[0_0_14px_-4px_rgba(239,68,68,0.8)]",
  amber: "border-amber-400/70 bg-amber-400/15 text-amber-200",
  slate: "border-slate-400/50 bg-slate-400/10 text-slate-100",
};

export function ToolButton({
  active,
  tone = "cyan",
  children,
  className = "",
  title,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; tone?: Tone; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[11px] tracking-wide transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 disabled:opacity-40 ${
        active ? toneOn[tone] : "border-ink-500/70 bg-ink-800/80 text-slate-400 hover:border-slate-500 hover:text-slate-200"
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-slate-600/70 bg-ink-700 px-1 py-px font-mono text-[10px] text-slate-300">{children}</kbd>;
}
