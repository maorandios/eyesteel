"use client";

import { useSmartMeasureStore } from "@/lib/state/smart-measure-store";

function cell(label: string, value: string) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-zinc-700/80 py-2 last:border-b-0">
      <span className="text-[11px] text-zinc-400">{label}</span>
      <span className="text-base font-semibold tabular-nums text-zinc-100" dir="ltr">
        {value}
      </span>
    </div>
  );
}

export function SmartMeasurementCard() {
  const open = useSmartMeasureStore((s) => s.measurementDetailsOpen);
  const directMm = useSmartMeasureStore((s) => s.directMm);
  const heightMm = useSmartMeasureStore((s) => s.heightMm);
  const horizontalMm = useSmartMeasureStore((s) => s.horizontalMm);
  const hintHe = useSmartMeasureStore((s) => s.hintHe);

  const fmt = (mm: number | null) =>
    mm !== null && Number.isFinite(mm) ? `${Math.round(mm).toLocaleString("he-IL")} מ״מ` : "—";

  if (!open) return null;

  return (
    <div
      className="pointer-events-auto absolute bottom-[5.75rem] left-1/2 z-40 w-[min(22rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl border border-zinc-600 bg-zinc-950/95 px-4 py-3 shadow-2xl backdrop-blur-sm"
      dir="rtl"
    >
      <p className="mb-2 text-xs leading-snug text-amber-200/95">{hintHe}</p>
      <div className="divide-y divide-zinc-800 rounded-xl bg-zinc-900/60 px-3 py-1">
        {cell("מרחק ישיר", fmt(directMm))}
        {cell("גובה", fmt(heightMm))}
        {cell("מרחק אופקי", fmt(horizontalMm))}
      </div>
    </div>
  );
}
