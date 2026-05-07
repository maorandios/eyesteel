"use client";

import { modeConfig } from "@/lib/modes/config";
import type { ViewerMode } from "@/types/domain";
import { cn } from "@/lib/utils";

interface Props {
  mode: ViewerMode;
  onModeChange: (mode: ViewerMode) => void;
}

export function BottomModeNav({ mode, onModeChange }: Props) {
  const modes = Object.keys(modeConfig) as ViewerMode[];
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-3 safe-bottom">
      {/* Full-width strip would steal canvas taps; pointer-events is not inherited — enable only on the bar. */}
      <div className="pointer-events-auto mx-auto grid max-w-4xl grid-cols-3 gap-2 rounded-2xl border border-zinc-700 bg-zinc-900/90 p-2">
        {modes.map((item) => (
          <button
            key={item}
            onClick={() => onModeChange(item)}
            className={cn(
              "h-12 rounded-xl text-sm font-semibold",
              mode === item ? "bg-blue-500 text-white" : "bg-zinc-800 text-zinc-200",
            )}
          >
            {modeConfig[item].label}
          </button>
        ))}
      </div>
    </div>
  );
}
