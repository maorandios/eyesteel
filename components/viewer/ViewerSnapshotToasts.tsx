"use client";

import { CircleCheck } from "lucide-react";

type Props = {
  /** Clipboard succeeded — brief top confirmation with circle-check right of label (RTL). */
  copyToastVisible: boolean;
};

export function ViewerSnapshotToasts({ copyToastVisible }: Props) {
  if (!copyToastVisible) return null;

  return (
    <div
      className="pointer-events-none fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[200] flex w-[min(22rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col gap-2"
      dir="rtl"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-emerald-600/50 bg-zinc-950/95 px-4 py-3 text-sm font-medium text-emerald-100 shadow-lg backdrop-blur-sm">
        <CircleCheck className="h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
        <span>הועתק לקליפ-בורד</span>
      </div>
    </div>
  );
}
