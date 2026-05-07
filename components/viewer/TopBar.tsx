"use client";

import { he } from "@/lib/i18n/he";

export function TopBar({ modeLabel }: { modeLabel: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 p-3 safe-top">
      {/* Inner panel must stay non-interactive; pointer-events is not inherited, so children would steal taps otherwise. */}
      <div className="pointer-events-none mx-auto flex max-w-4xl items-center justify-between rounded-2xl border border-zinc-700 bg-zinc-900/85 px-3 py-2">
        <span className="text-sm font-bold text-zinc-100">{he.appName}</span>
        <span className="text-sm text-zinc-300">{modeLabel}</span>
      </div>
    </div>
  );
}
