"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Binoculars, EyeOff, Scan, SquaresSubtract } from "lucide-react";
import { cn } from "@/lib/utils";

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

const rowBtn =
  "flex h-auto w-full flex-col items-end justify-center gap-1 rounded-xl border-0 bg-transparent px-3 py-2.5 text-right text-sm font-medium text-zinc-100 shadow-none hover:bg-zinc-800/45 active:scale-[0.99] [&_svg]:size-[1.1rem] [&_svg]:shrink-0";

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
      className="pointer-events-auto fixed z-[52] w-[min(13.5rem,calc(100vw-1.5rem))] rounded-2xl border border-zinc-600/90 bg-zinc-950/95 p-1.5 shadow-2xl backdrop-blur-md"
      style={{ left: pos.left, top: pos.top }}
      dir="rtl"
      role="menu"
      aria-label="פעולות על האלמנט"
    >
      <div className="flex flex-col gap-0.5">
        <Button type="button" variant="ghost" className={cn(rowBtn)} disabled={noIds} onClick={onIsolate}>
          <Scan aria-hidden />
          בידוד חלק
        </Button>
        <Button type="button" variant="ghost" className={cn(rowBtn)} disabled={noIds} onClick={onContext}>
          <SquaresSubtract aria-hidden />
          הצג בשקיפות
        </Button>
        <Button type="button" variant="ghost" className={cn(rowBtn)} disabled={noIds} onClick={onHide}>
          <EyeOff aria-hidden />
          הסתרה
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(rowBtn)}
          disabled={!state.showInspect}
          onClick={onInspect}
        >
          <Binoculars aria-hidden />
          בדיקה
        </Button>
      </div>
    </div>
  );
}
