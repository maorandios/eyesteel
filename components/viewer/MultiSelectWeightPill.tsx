"use client";

import { formatKgPlain } from "@/lib/format-numbers";

export function MultiSelectWeightPill({
  totalWeightKg,
}: {
  totalWeightKg: number | null;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-center p-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
      aria-live="polite"
    >
      <div
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-zinc-600/90 bg-zinc-950/95 px-4 py-2 text-zinc-100 shadow-2xl backdrop-blur-md"
        dir="rtl"
        role="status"
        aria-label={`משקל כללי ${formatKgPlain(totalWeightKg)} קילוגרם`}
      >
        <span className="text-[11px] font-medium leading-none text-zinc-400 sm:text-xs">
          משקל כללי
        </span>
        <span className="h-1 w-1 rounded-full bg-zinc-500/85" aria-hidden />
        <span
          className="inline-flex flex-row items-center gap-1 text-[11px] font-semibold leading-none sm:text-[13px]"
          dir="ltr"
        >
          <span>ק״ג</span>
          <span>{formatKgPlain(totalWeightKg)}</span>
        </span>
      </div>
    </div>
  );
}
