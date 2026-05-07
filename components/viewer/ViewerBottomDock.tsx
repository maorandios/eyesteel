"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useSmartMeasureStore } from "@/lib/state/smart-measure-store";
import { cn } from "@/lib/utils";

type SelectionMode = "part" | "assembly";

interface Props {
  selectionMode: SelectionMode;
  onSelectionModeChange: (mode: SelectionMode) => void;
  onDashboard: () => void;
  measurementActive: boolean;
  onMeasurementToggle: () => void;
  onMeasurementClear: () => void;
  onMeasurementFinish: () => void;
}

/**
 * Primary viewer chrome: dashboard, element mode drop‑up, measurement (+ breakdown panel).
 */
export function ViewerBottomDock({
  selectionMode,
  onSelectionModeChange,
  onDashboard,
  measurementActive,
  onMeasurementToggle,
  onMeasurementClear,
  onMeasurementFinish,
}: Props) {
  const [elementOpen, setElementOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const measurementDetailsOpen = useSmartMeasureStore((s) => s.measurementDetailsOpen);
  const toggleMeasurementDetailsPanel = useSmartMeasureStore((s) => s.toggleMeasurementDetailsPanel);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setElementOpen(false);
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, []);

  const pickElementMode = useCallback(
    (m: SelectionMode) => {
      onSelectionModeChange(m);
      setElementOpen(false);
    },
    [onSelectionModeChange],
  );

  return (
    <div
      ref={wrapRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-50 flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div
        className={cn(
          "pointer-events-auto flex items-center gap-1 rounded-2xl border border-zinc-600 bg-zinc-950/95 px-2 py-2 shadow-2xl backdrop-blur-sm transition-[width] duration-200",
          measurementActive ? "max-w-[min(100vw-1rem,28rem)]" : "max-w-[min(100vw-1rem,20rem)]",
        )}
        dir="rtl"
      >
        <Button
          type="button"
          variant="secondary"
          className="h-10 shrink-0 px-3 text-sm font-semibold"
          onClick={onDashboard}
        >
          דאשבורד
        </Button>

        <div className="relative shrink-0">
          <Button
            type="button"
            variant="secondary"
            className="h-10 gap-1 px-3 text-sm font-semibold"
            aria-expanded={elementOpen}
            onClick={() => setElementOpen((o) => !o)}
          >
            אלמנט
            <span className="text-xs opacity-80">{elementOpen ? "▼" : "▲"}</span>
          </Button>
          {elementOpen && (
            <div
              className="absolute bottom-[calc(100%+6px)] left-1/2 z-50 flex min-w-[10rem] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-zinc-600 bg-zinc-950 shadow-xl"
              dir="rtl"
            >
              <button
                type="button"
                className={cn(
                  "px-4 py-3 text-right text-sm font-medium transition-colors hover:bg-zinc-800",
                  selectionMode === "assembly" ? "bg-blue-600/25 text-blue-200" : "text-zinc-200",
                )}
                onClick={() => pickElementMode("assembly")}
              >
                Assembly
              </button>
              <button
                type="button"
                className={cn(
                  "border-t border-zinc-700 px-4 py-3 text-right text-sm font-medium transition-colors hover:bg-zinc-800",
                  selectionMode === "part" ? "bg-blue-600/25 text-blue-200" : "text-zinc-200",
                )}
                onClick={() => pickElementMode("part")}
              >
                חלק (Part)
              </button>
            </div>
          )}
        </div>

        <Button
          type="button"
          variant={measurementActive ? "default" : "secondary"}
          className={cn(
            "h-10 shrink-0 px-3 text-sm font-semibold",
            measurementActive && "ring-2 ring-amber-400/80 ring-offset-2 ring-offset-zinc-950",
          )}
          aria-pressed={measurementActive}
          onClick={onMeasurementToggle}
        >
          מדידה
        </Button>

        {measurementActive && (
          <>
            <Button
              type="button"
              variant={measurementDetailsOpen ? "default" : "secondary"}
              className="h-10 shrink-0 px-2.5 text-xs font-semibold sm:text-sm"
              aria-pressed={measurementDetailsOpen}
              onClick={() => toggleMeasurementDetailsPanel()}
            >
              פירוק מידות
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-10 shrink-0 px-2 text-xs text-zinc-300"
              onClick={onMeasurementClear}
            >
              נקה
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-10 shrink-0 px-2 text-xs text-zinc-300"
              onClick={onMeasurementFinish}
            >
              סיים
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
