"use client";

import { Button } from "@/components/ui/button";

interface Props {
  onFinish: () => void;
  onClear: () => void;
}

/** Compact touch-first controls while מדידה mode is active. */
export function MeasurementToolBar({ onFinish, onClear }: Props) {
  return (
    <div
      className="safe-bottom absolute bottom-32 left-1/2 z-50 flex -translate-x-1/2 gap-3 px-2"
      dir="rtl"
    >
      <Button
        type="button"
        size="lg"
        className="min-h-12 min-w-[9rem] text-base font-medium shadow-lg"
        onClick={onFinish}
      >
        סיים מדידה
      </Button>
      <Button
        type="button"
        size="lg"
        variant="secondary"
        className="min-h-12 min-w-[9rem] text-base font-medium shadow-lg"
        onClick={onClear}
      >
        נקה מדידות
      </Button>
    </div>
  );
}
