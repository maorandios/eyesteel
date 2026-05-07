"use client";

import { modeConfig } from "@/lib/modes/config";
import type { ViewerMode } from "@/types/domain";
import { cn } from "@/lib/utils";

interface Props {
  mode: ViewerMode;
  onModeChange: (mode: ViewerMode) => void;
}

/** Small mode switcher — top‑right (management / production / assembly). */
export function CompactModeNav({ mode, onModeChange }: Props) {
  const modes = Object.keys(modeConfig) as ViewerMode[];
  return (
    <div
      className="pointer-events-auto absolute right-3 top-3 z-30 flex gap-1 rounded-xl border border-zinc-600 bg-zinc-950/92 p-1 shadow-lg safe-top"
      dir="rtl"
    >
      {modes.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onModeChange(item)}
          className={cn(
            "rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors",
            mode === item ? "bg-blue-600 text-white" : "bg-zinc-800/90 text-zinc-300 hover:bg-zinc-700",
          )}
        >
          {modeConfig[item].label}
        </button>
      ))}
    </div>
  );
}
