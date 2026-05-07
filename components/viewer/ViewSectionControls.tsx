"use client";

import { Button } from "@/components/ui/button";
import { useViewSectionStore } from "@/lib/state/view-section-store";
import { useViewerToolStore } from "@/lib/state/viewer-tool-store";
import type { ViewerEngine } from "@/lib/viewer/engine";
import { cn } from "@/lib/utils";

interface Props {
  engine: ViewerEngine | null;
}

export function ViewSectionControls({ engine }: Props) {
  const sectionActive = useViewSectionStore((s) => s.sectionActive);
  const sectionLabel = useViewSectionStore((s) => s.sectionLabel);
  const depthOffset = useViewSectionStore((s) => s.depthOffset);
  const depthExtent = useViewSectionStore((s) => s.depthExtent);
  const freePickStep = useViewSectionStore((s) => s.freePickStep);
  const freePickMessage = useViewSectionStore((s) => s.freePickMessage);
  const freePickError = useViewSectionStore((s) => s.freePickError);
  const setViewerTool = useViewerToolStore((s) => s.setActiveTool);

  const picking = freePickStep === "pick-first" || freePickStep === "pick-second";

  if (!sectionActive && !picking) return null;

  const step = Math.max(depthExtent / 400, 1e-4);

  const cancelAll = () => {
    engine?.cancelViewSection();
    setViewerTool("none");
  };

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 z-[55] flex justify-center px-3",
        "bottom-[calc(5rem+env(safe-area-inset-bottom))]",
      )}
      dir="rtl"
    >
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-zinc-600 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur-sm">
        {picking && (
          <>
            <p className="mb-1 text-center text-sm font-semibold leading-snug text-zinc-100">
              {freePickMessage}
            </p>
            {freePickError ? (
              <p className="mb-2 text-center text-xs leading-snug text-amber-400">{freePickError}</p>
            ) : (
              <div className="mb-2 h-px" aria-hidden />
            )}
            <Button
              type="button"
              variant="secondary"
              className="h-12 w-full text-base font-semibold"
              onClick={cancelAll}
            >
              בטל חתך
            </Button>
          </>
        )}
        {sectionActive && !picking && (
          <>
            <p className="mb-3 text-center text-base font-semibold text-zinc-100">
              מבט: <span className="text-blue-200">{sectionLabel ?? "—"}</span>
            </p>
            <label className="mb-3 block text-sm font-medium text-zinc-300">
              עומק חתך
              <input
                type="range"
                className={cn(
                  "mt-2 block h-10 w-full cursor-pointer touch-manipulation",
                  "accent-blue-500",
                )}
                min={-depthExtent}
                max={depthExtent}
                step={step}
                value={depthOffset}
                onChange={(e) => engine?.setViewSectionDepth(Number(e.target.value))}
              />
            </label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="h-12 flex-1 text-base font-semibold"
                onClick={() => engine?.flipViewSection()}
              >
                הפוך כיוון
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-12 flex-1 text-base font-semibold text-zinc-200 hover:bg-zinc-800"
                onClick={cancelAll}
              >
                בטל מבט
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
