"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Binoculars, EyeOff, Scan, SquaresSubtract } from "lucide-react";
import { cn } from "@/lib/utils";

/** Marker for global dismiss handlers (see viewer page). */
export const ELEMENT_PICK_PANEL_ATTR = "data-element-pick-panel" as const;

export type ElementPickContextPanelState = {
  clientX: number;
  clientY: number;
  isolationLocalIds: number[];
  showInspect: boolean;
};

type Props = {
  state: ElementPickContextPanelState;
  onIsolate: () => void;
  onContext: () => void;
  onHide: () => void;
  onInspect: () => void;
};

/** Compact rows: under `dir="rtl"`, icon first in DOM sits to the *visual* right of the label. */
const rowBtn =
  "flex h-auto w-full min-w-0 flex-row items-center justify-start gap-1 rounded-lg border-0 bg-transparent px-1.5 py-1.5 text-right text-xs font-medium text-zinc-100 shadow-none hover:bg-zinc-800/45 active:scale-[0.99] [&_svg]:size-[0.88rem] [&_svg]:shrink-0";

/**
 * Vertical action rail at the pick point — same icons as {@link MultiSelectActionBar}; בדיקה uses binoculars (מבט בדיקה).
 */
export function ElementPickContextPanel({ state, onIsolate, onContext, onHide, onInspect }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.clientX, top: state.clientY });

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof window === "undefined") return;
    const pad = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { width, height } = el.getBoundingClientRect();

    let left = state.clientX - width / 2;
    let top = state.clientY - height - 12;
    if (top < pad) top = state.clientY + 12;
    if (top + height > vh - pad) top = Math.max(pad, vh - height - pad);
    left = Math.max(pad, Math.min(left, vw - width - pad));
    setPos({ left, top });
  }, [state.clientX, state.clientY]);

  const noIds = state.isolationLocalIds.length === 0;

  return (
    <div
      ref={rootRef}
      {...{ [ELEMENT_PICK_PANEL_ATTR]: "" }}
      className="pointer-events-auto fixed z-[52] w-max min-w-0 max-w-[min(9.25rem,calc(100vw-1rem))] rounded-xl border border-zinc-600/90 bg-zinc-950/95 px-0.5 py-0.5 shadow-2xl backdrop-blur-md"
      style={{ left: pos.left, top: pos.top }}
      dir="rtl"
      role="menu"
      aria-label="פעולות על האלמנט"
    >
      <div className="flex w-max min-w-0 flex-col gap-px">
        <Button type="button" variant="ghost" className={cn(rowBtn)} disabled={noIds} onClick={onIsolate}>
          <Scan aria-hidden className="shrink-0" />
          <span className="min-w-0 whitespace-nowrap text-right leading-tight">בידוד חלק</span>
        </Button>
        <Button type="button" variant="ghost" className={cn(rowBtn)} disabled={noIds} onClick={onContext}>
          <SquaresSubtract aria-hidden className="shrink-0" />
          <span className="min-w-0 whitespace-nowrap text-right leading-tight">הצג בשקיפות</span>
        </Button>
        <Button type="button" variant="ghost" className={cn(rowBtn)} disabled={noIds} onClick={onHide}>
          <EyeOff aria-hidden className="shrink-0" />
          <span className="min-w-0 whitespace-nowrap text-right leading-tight">הסתרה</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(rowBtn)}
          disabled={!state.showInspect}
          onClick={onInspect}
        >
          <Binoculars aria-hidden className="shrink-0" />
          <span className="min-w-0 whitespace-nowrap text-right leading-tight">בדיקה</span>
        </Button>
      </div>
    </div>
  );
}
