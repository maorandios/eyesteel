"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { VIEW_MODE_LABELS_HE, VIEW_MODE_ORDER, type ViewModeId } from "@/lib/viewer/view-mode-presets";

type Props = {
  activeViewMode: ViewModeId | null;
  measurementActive: boolean;
  sketchActive: boolean;
  onExit: () => void;
  onMeasurementToggle: () => void;
  /** Apply another orthographic preset (keeps מצב בדיקה framing AABB). */
  onApplyViewMode: (mode: ViewModeId) => void;
  onSketchToggle: () => void;
};

export function InspectionModeToolbar({
  activeViewMode,
  measurementActive,
  sketchActive,
  onExit,
  onMeasurementToggle,
  onApplyViewMode,
  onSketchToggle,
}: Props) {
  const [viewsOpen, setViewsOpen] = useState(false);

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-[54] flex flex-col items-center gap-1 border-t border-zinc-700/90 bg-zinc-950/96 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-8px_32px_rgba(0,0,0,0.35)] backdrop-blur-md"
      dir="rtl"
    >
      <div className="flex w-full max-w-2xl flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          variant="secondary"
          className="h-10 min-w-[7.5rem] text-sm font-semibold"
          onClick={onExit}
        >
          חזור למודל
        </Button>
        <Button
          type="button"
          variant={measurementActive ? "default" : "secondary"}
          className="h-10 min-w-[6rem] text-sm font-semibold"
          onClick={onMeasurementToggle}
        >
          מדידה
        </Button>
        <Button
          type="button"
          variant={sketchActive ? "default" : "secondary"}
          className="h-10 min-w-[6.5rem] text-sm font-semibold"
          onClick={onSketchToggle}
        >
          מצב סקיצה
        </Button>
        <div className="relative">
          <Button
            type="button"
            variant="secondary"
            className="h-10 min-w-[5.5rem] text-sm font-semibold"
            onClick={() => setViewsOpen((o) => !o)}
            aria-expanded={viewsOpen}
          >
            מבטים{activeViewMode ? ` · ${VIEW_MODE_LABELS_HE[activeViewMode]}` : ""}
          </Button>
          {viewsOpen && (
            <div className="pointer-events-auto absolute bottom-full left-1/2 mb-2 w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-zinc-600 bg-zinc-900/98 p-2 shadow-2xl">
              <p className="mb-2 px-1 text-center text-[11px] font-medium text-zinc-400">מבט אורתוגונלי</p>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {VIEW_MODE_ORDER.map((mode) => (
                  <Button
                    key={mode}
                    type="button"
                    variant={mode === activeViewMode ? "default" : "secondary"}
                    className="h-9 px-2 text-xs font-semibold"
                    onClick={() => {
                      onApplyViewMode(mode);
                      setViewsOpen(false);
                    }}
                  >
                    {VIEW_MODE_LABELS_HE[mode]}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <p className="text-center text-[10px] text-zinc-500">מצב בדיקה — תצוגה טכנית לבדיקת פרטים</p>
    </div>
  );
}
