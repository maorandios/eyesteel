"use client";

import { Button } from "@/components/ui/button";
import type { IsolationMode } from "@/lib/state/isolation-store";

type Props = {
  visible: boolean;
  isolationMode: IsolationMode;
  disabled?: boolean;
  onIsolate: () => void;
  onContext: () => void;
  onHide: () => void;
  onShowAll: () => void;
};

export function IsolationActionBar({
  visible,
  isolationMode,
  disabled,
  onIsolate,
  onContext,
  onHide,
  onShowAll,
}: Props) {
  if (!visible) return null;

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 top-[calc(4.75rem+env(safe-area-inset-top))] z-[48] flex justify-center px-3"
      dir="rtl"
    >
      <div className="flex max-w-lg flex-wrap items-center justify-center gap-2 rounded-2xl border border-zinc-600 bg-zinc-950/96 px-3 py-2 shadow-xl backdrop-blur-sm">
        <Button
          type="button"
          variant={isolationMode === "isolated" ? "default" : "secondary"}
          className="min-h-10 px-4 text-sm font-semibold"
          disabled={disabled}
          onClick={onIsolate}
        >
          בודד
        </Button>
        <Button
          type="button"
          variant={isolationMode === "context" ? "default" : "secondary"}
          className="min-h-10 px-4 text-sm font-semibold"
          disabled={disabled}
          onClick={onContext}
        >
          הצג בהקשר
        </Button>
        <Button
          type="button"
          variant={isolationMode === "hidden" ? "default" : "secondary"}
          className="min-h-10 px-4 text-sm font-semibold"
          disabled={disabled}
          onClick={onHide}
        >
          הסתר
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="min-h-10 border border-zinc-500 px-4 text-sm"
          disabled={disabled || isolationMode === "none"}
          onClick={onShowAll}
        >
          הצג הכל
        </Button>
      </div>
    </div>
  );
}
