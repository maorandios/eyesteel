"use client";

import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format-numbers";

type Props = {
  visible: boolean;
  selectedCount: number;
  disabled?: boolean;
  onIsolate: () => void;
  onContext: () => void;
  onHide: () => void;
  onClear: () => void;
  onDone: () => void;
};

export function MultiSelectActionBar({
  visible,
  selectedCount,
  disabled,
  onIsolate,
  onContext,
  onHide,
  onClear,
  onDone,
}: Props) {
  if (!visible) return null;

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 bottom-24 z-[52] flex justify-center px-3 pb-[env(safe-area-inset-bottom)]"
      dir="rtl"
    >
      <div className="flex w-full max-w-lg flex-col gap-2 rounded-2xl border border-zinc-600 bg-zinc-950/96 px-3 py-2 shadow-xl backdrop-blur-sm">
        <p className="text-center text-sm font-semibold text-zinc-100">
          {formatCount(selectedCount)} אלמנטים נבחרו
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="secondary"
            className="min-h-10 px-4 text-sm font-semibold"
            disabled={disabled || selectedCount === 0}
            onClick={onIsolate}
          >
            בודד
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="min-h-10 px-4 text-sm font-semibold"
            disabled={disabled || selectedCount === 0}
            onClick={onContext}
          >
            הצג בהקשר
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="min-h-10 px-4 text-sm font-semibold"
            disabled={disabled || selectedCount === 0}
            onClick={onHide}
          >
            הסתר
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="min-h-10 border border-zinc-500 px-4 text-sm"
            disabled={disabled || selectedCount === 0}
            onClick={onClear}
          >
            נקה
          </Button>
          <Button type="button" variant="default" className="min-h-10 px-4 text-sm font-semibold" disabled={disabled} onClick={onDone}>
            סיום
          </Button>
        </div>
      </div>
    </div>
  );
}
