"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  DockSubmenuBar,
  DockSubmenuDotSep,
  DockSubmenuPill,
} from "@/components/viewer/dock-submenu";
import type { ViewerClippingUiSnapshot } from "@/lib/viewer/clipping-presets";
import { useClippingStore } from "@/lib/state/clipping-store";
import { CircleX, FlipHorizontal, FoldHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export type ClippingHudRowProps = {
  snapshot: ViewerClippingUiSnapshot;
  onDepthChange: (value: number) => void;
  onFlip: () => void;
  onSectionViewToggle: () => void;
  onCancel: () => void;
};

/** Single dock submenu rail: הצג כחתך · הפוך · סליידר · X — aligns with ViewerBottomDock submenus. */
export function ClippingHudRow({
  snapshot,
  onDepthChange,
  onFlip,
  onSectionViewToggle,
  onCancel,
}: ClippingHudRowProps) {
  const clipSectionOrthoActive = useClippingStore((s) => s.clipSectionOrthoActive);

  const step = useMemo(() => {
    const span = snapshot.depthMax - snapshot.depthMin;
    if (!(span > 0)) return 0.01;
    return Math.max(span / 256, 1e-4);
  }, [snapshot.depthMax, snapshot.depthMin]);

  return (
    <DockSubmenuBar className="w-fit max-w-[min(calc(100vw-1.75rem),40rem)] justify-center overflow-x-auto px-2 py-1 sm:px-2.5 sm:py-1.5">
      <DockSubmenuPill
        label={clipSectionOrthoActive ? "ביטול חתך" : "הצג כחתך"}
        title={clipSectionOrthoActive ? "יציאה מתצוגת חתך מותאמת" : "הצג חתך אורתוגונלי למישור הפעיל"}
        selected={clipSectionOrthoActive}
        aria-label={clipSectionOrthoActive ? "ביטול חתך" : "הצג כחתך"}
        className="min-w-[4rem] w-auto shrink-0 sm:min-w-[4.25rem]"
        onClick={onSectionViewToggle}
      >
        <FoldHorizontal aria-hidden />
      </DockSubmenuPill>
      <DockSubmenuPill
        label="הפוך כיוון"
        title={snapshot.flipped ? "כיוון מוסר הפוך: לחץ להחזיר" : "הפוך כיוון הקליפ"}
        aria-label="הפוך כיוון"
        selected={snapshot.flipped}
        className="min-w-[3.75rem] w-auto shrink-0 sm:min-w-[4rem]"
        onClick={onFlip}
      >
        <FlipHorizontal aria-hidden />
      </DockSubmenuPill>

      <DockSubmenuDotSep />

      <div
        className="flex min-h-[2.625rem] min-w-[5.75rem] max-w-[13rem] flex-[1_1_auto] shrink items-center px-1"
        dir="ltr"
      >
        <input
          type="range"
          className={cn(
            "h-5 w-full cursor-pointer appearance-none bg-transparent",
            "[&::-webkit-slider-runnable-track]:h-1",
            "[&::-webkit-slider-runnable-track]:rounded-full",
            "[&::-webkit-slider-runnable-track]:bg-zinc-300/95",
            "[&::-webkit-slider-thumb]:relative [&::-webkit-slider-thumb]:top-[-4px] [&::-webkit-slider-thumb]:box-border [&::-webkit-slider-thumb]:size-3",
            "[&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0",
            "[&::-webkit-slider-thumb]:bg-[#003CFF] [&::-webkit-slider-thumb]:shadow [&::-webkit-slider-thumb]:outline-none",
            "[&::-moz-range-thumb]:box-border [&::-moz-range-thumb]:size-3",
            "[&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[#003CFF]",
            "[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-zinc-300/95",
            "[&::-moz-range-progress]:h-1 [&::-moz-range-progress]:rounded-l-full [&::-moz-range-progress]:bg-[#003CFF]",
            "accent-[#003CFF]",
          )}
          min={snapshot.depthMin}
          max={snapshot.depthMax}
          step={step}
          value={snapshot.depthOffset}
          onChange={(e) => onDepthChange(Number(e.target.value))}
          aria-label="עומק חתך"
          aria-valuemin={snapshot.depthMin}
          aria-valuemax={snapshot.depthMax}
          aria-valuenow={snapshot.depthOffset}
        />
      </div>

      <DockSubmenuDotSep />

      <Button
        type="button"
        variant="ghost"
        aria-label="בטל קליפינג"
        title="בטל קליפינג"
        onClick={onCancel}
        className={cn(
          "flex h-auto min-h-0 shrink-0 items-center justify-center rounded-full border-0 px-2 py-1 font-normal shadow-none ring-0 sm:px-2.5 sm:py-1.5",
          "text-zinc-700 hover:bg-zinc-200/80 hover:text-zinc-950 active:scale-[0.99]",
          "focus-visible:ring-2 focus-visible:ring-zinc-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-[#e8ecef]",
        )}
      >
        <span className="flex min-h-[1.1rem] items-center justify-center [&_svg]:size-[1.05rem] sm:[&_svg]:size-[1.15rem]">
          <CircleX className="size-[1.05rem] shrink-0 sm:size-[1.15rem]" aria-hidden />
        </span>
      </Button>
    </DockSubmenuBar>
  );
}
