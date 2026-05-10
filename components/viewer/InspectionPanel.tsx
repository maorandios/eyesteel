"use client";

import { Button } from "@/components/ui/button";
import { PartPickDetailPanel } from "@/components/viewer/SelectionPickDetails";
import type { AnalyzerPart } from "@/types/domain";

type Props = {
  part: AnalyzerPart;
  allSteelParts: AnalyzerPart[];
  assemblyLabel: string | null;
  onClose: () => void;
};

/**
 * Inspector for מצב בדיקה: sheet on small screens, side panel on `md+`.
 */
export function InspectionPanel({ part, allSteelParts, assemblyLabel, onClose }: Props) {
  return (
    <>
      <div
        className="pointer-events-auto fixed inset-x-0 bottom-[7.35rem] z-[52] max-h-[45vh] overflow-hidden rounded-t-2xl border border-zinc-600 bg-zinc-950/98 shadow-2xl md:hidden"
        dir="rtl"
        style={{ marginBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <p className="text-sm font-semibold text-zinc-100">נתוני חלק</p>
          <Button type="button" variant="ghost" className="h-8 text-xs" onClick={onClose}>
            סגור
          </Button>
        </div>
        <div className="max-h-[min(38vh,24rem)] overflow-auto px-3 py-2">
          <PartPickDetailPanel
            entity={part}
            allSteelParts={allSteelParts}
            variant="inspection"
            assemblyMark={assemblyLabel}
            onBackToList={onClose}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-0 z-[51] hidden justify-end md:flex">
        <aside
          className="pointer-events-auto flex h-full w-[22rem] max-w-[92vw] shrink-0 flex-col border-l border-zinc-600 bg-zinc-950/96 p-4 pt-16 shadow-2xl"
          dir="rtl"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-zinc-100">נתוני חלק</p>
            <Button type="button" variant="ghost" className="h-8 text-xs" onClick={onClose}>
              סגור
            </Button>
          </div>
          <div className="max-h-[calc(100vh-8rem)] overflow-auto rounded-xl border border-zinc-800 bg-zinc-950/30 p-2">
            <PartPickDetailPanel
              entity={part}
              allSteelParts={allSteelParts}
              variant="inspection"
              assemblyMark={assemblyLabel}
              onBackToList={onClose}
            />
          </div>
        </aside>
      </div>
    </>
  );
}
