"use client";

import { Button } from "@/components/ui/button";
import { DockSubmenuBar, DockSubmenuPill } from "@/components/viewer/dock-submenu";
import { CircleX, EyeOff, RotateCcw, Scan, SquaresSubtract } from "lucide-react";
import { cn } from "@/lib/utils";

const multiPillLabelClass =
  "max-w-[4.75rem] text-zinc-700 sm:max-w-[5.85rem]";

export type MultiSelectHudProps = {
  selectedCount: number;
  disabled?: boolean;
  onIsolate: () => void;
  onContext: () => void;
  onHide: () => void;
  onClear: () => void;
  onDone: () => void;
};

const exitBtnClass =
  "flex h-auto min-h-0 shrink-0 items-center justify-center rounded-full border-0 px-2 py-1 font-normal shadow-none ring-0 sm:px-2.5 sm:py-1.5";

/**
 * Pill rail for בחירה מרובה — matches {@link DockSubmenuBar} / clipping HUD styling.
 */
export function MultiSelectActionBar({
  selectedCount,
  disabled,
  onIsolate,
  onContext,
  onHide,
  onClear,
  onDone,
}: MultiSelectHudProps) {
  const noSel = disabled || selectedCount === 0;

  return (
    <div className="flex w-full shrink-0 justify-center" dir="rtl" role="region" aria-label="בחירה מרובה">
      <DockSubmenuBar className="max-w-[min(calc(100vw-2rem),36rem)] w-fit justify-center overflow-x-auto px-2 py-1 sm:px-2.5 sm:py-1.5">
        <DockSubmenuPill
          label="בידוד חלק"
          labelClassName={multiPillLabelClass}
          title="בודד אלמנטים נבחרים"
          aria-label="בידוד חלק"
          className="min-w-[3.5rem] shrink-0 sm:min-w-[3.85rem]"
          disabled={noSel}
          onClick={onIsolate}
        >
          <Scan aria-hidden />
        </DockSubmenuPill>
        <DockSubmenuPill
          label="הצג בשקיפות"
          labelClassName={multiPillLabelClass}
          title="הצג בהקשר — שאר המודל כהה"
          aria-label="הצג בשקיפות"
          className="min-w-[3.5rem] shrink-0 sm:min-w-[3.85rem]"
          disabled={noSel}
          onClick={onContext}
        >
          <SquaresSubtract aria-hidden />
        </DockSubmenuPill>
        <DockSubmenuPill
          label="הסתרה"
          labelClassName={multiPillLabelClass}
          title="הסתר אלמנטים שלא נבחרו"
          aria-label="הסתרה"
          className="min-w-[3.25rem] shrink-0 sm:min-w-[3.65rem]"
          disabled={noSel}
          onClick={onHide}
        >
          <EyeOff aria-hidden />
        </DockSubmenuPill>
        <DockSubmenuPill
          label="איפוס"
          labelClassName={multiPillLabelClass}
          title="נקה בחירה והצג את כל המודל (כמו הצג הכל)"
          aria-label="איפוס בחירה והצגת המודל המלא"
          className="min-w-[3.25rem] shrink-0 sm:min-w-[3.65rem]"
          disabled={noSel}
          onClick={onClear}
        >
          <RotateCcw aria-hidden />
        </DockSubmenuPill>
        <Button
          type="button"
          variant="ghost"
          aria-label="סיום בחירה מרובה"
          title="סיום"
          disabled={disabled}
          className={cn(
            exitBtnClass,
            "text-zinc-700 hover:bg-zinc-200/80 hover:text-zinc-950 active:scale-[0.99]",
            "focus-visible:ring-2 focus-visible:ring-zinc-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-[#e8ecef]",
          )}
          onClick={onDone}
        >
          <span className="flex min-h-[1.1rem] items-center justify-center [&_svg]:size-[1.05rem] sm:[&_svg]:size-[1.15rem]">
            <CircleX className="size-[1.05rem] shrink-0 sm:size-[1.15rem]" aria-hidden />
          </span>
        </Button>
      </DockSubmenuBar>
    </div>
  );
}
