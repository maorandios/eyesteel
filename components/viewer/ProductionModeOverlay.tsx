"use client";

import type { AnalyzerAssembly, AnalyzerPart } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCount, formatKgPlain, formatMmPlain, formatQuantityInt } from "@/lib/format-numbers";
import { displayPartMark } from "@/components/viewer/SelectionPickDetails";
import type { AggregatedAssemblyRow } from "@/lib/viewer/modelAggregates";
import {
  ArrowRight,
  Minimize,
  MoveLeft,
  Search,
  SquareStack,
  SquaresIntersect,
  SquaresUnite,
  Weight,
} from "lucide-react";

export type ProductionAppMode = "management" | "production";
export type ProductionTab = "assemblies" | "parts";
export type ProductionSelection = {
  type: "assembly" | "part" | null;
  id: string | number | null;
};

export type ProductionPartRow = {
  key: string;
  displayMark: string;
  displayProfile: string;
  effectiveQty: number;
  totalWeightKg: number | null;
  instances: AnalyzerPart[];
};

type ProductionModeOverlayProps = {
  visible: boolean;
  viewerOpen: boolean;
  loading: boolean;
  tab: ProductionTab;
  search: string;
  assemblyRows: AggregatedAssemblyRow[];
  partRows: ProductionPartRow[];
  selectedAssembly: AnalyzerAssembly | null;
  selectionTitle: string;
  selectionKind: "assembly" | "part" | null;
  partsDrawerOpen: boolean;
  onTabChange: (tab: ProductionTab) => void;
  onSearchChange: (value: string) => void;
  onPickAssembly: (row: AggregatedAssemblyRow) => void;
  onPickPart: (row: ProductionPartRow) => void;
  onBackToLists: () => void;
  onPartsDrawerClose: () => void;
  onPickAssemblyPart: (part: AnalyzerPart) => void;
};

function assemblyUnitWeightKg(row: AggregatedAssemblyRow): number | null {
  if (row.totalWeightKg == null || row.qty <= 0) return null;
  return row.totalWeightKg / row.qty;
}

function partUnitWeightKg(row: ProductionPartRow): number | null {
  if (row.totalWeightKg == null || row.effectiveQty <= 0) return null;
  return row.totalWeightKg / row.effectiveQty;
}

function ProductionListEmpty({ label }: { label: string }) {
  return (
    <div className="flex h-48 items-center justify-center rounded-3xl border border-dashed border-zinc-300 bg-white/60 text-sm font-medium text-zinc-500">
      {label}
    </div>
  );
}

export function ProductionModeOverlay({
  visible,
  viewerOpen,
  loading,
  tab,
  search,
  assemblyRows,
  partRows,
  selectedAssembly,
  selectionTitle,
  selectionKind,
  partsDrawerOpen,
  onTabChange,
  onSearchChange,
  onPickAssembly,
  onPickPart,
  onBackToLists,
  onPartsDrawerClose,
  onPickAssemblyPart,
}: ProductionModeOverlayProps) {
  if (!visible) return null;

  if (!viewerOpen) {
    return (
      <section
        className="absolute inset-x-0 bottom-0 top-[calc(2.5rem+env(safe-area-inset-top))] z-40 flex bg-[#e8ecef] px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4 text-zinc-950 sm:px-6"
        dir="rtl"
        aria-label="מסך מצב ייצור"
      >
        <div className="mx-auto flex min-h-0 w-full max-w-[44rem] flex-1 flex-col gap-3 overflow-hidden rounded-[1.35rem] border border-zinc-300/80 bg-[#eef1f3]/95 p-3 shadow-[0_18px_45px_rgba(39,39,42,0.16)] backdrop-blur-xl sm:p-4">
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-zinc-300 bg-zinc-200/70 p-1">
            <button
              type="button"
              className={cn(
                "flex min-h-14 items-center justify-center gap-2 rounded-lg text-xs font-semibold transition-colors",
                tab === "assemblies" ? "bg-white text-[#003CFF] shadow-sm" : "text-zinc-600",
              )}
              onClick={() => onTabChange("assemblies")}
            >
              <SquaresUnite className="size-5" aria-hidden />
              אסמבלי
            </button>
            <button
              type="button"
              className={cn(
                "flex min-h-14 items-center justify-center gap-2 rounded-lg text-xs font-semibold transition-colors",
                tab === "parts" ? "bg-white text-[#003CFF] shadow-sm" : "text-zinc-600",
              )}
              onClick={() => onTabChange("parts")}
            >
              <SquaresIntersect className="size-5" aria-hidden />
              חלקים
            </button>
          </div>

          <label className="relative block">
            <Search className="pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              className="h-12 w-full rounded-xl border-0 bg-white/90 pr-11 pl-4 text-sm font-medium text-zinc-950 outline-none transition placeholder:text-zinc-400 focus:ring-4 focus:ring-[#003CFF]/10"
              placeholder={tab === "assemblies" ? "חפש לפי מספר אמסבלי" : "חפש לפי מספר חלק"}
              autoComplete="off"
            />
          </label>

          <div className="min-h-0 flex-1 overflow-auto pb-1 pr-0.5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-400/70 hover:scrollbar-thumb-zinc-500/80 [scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-400/70 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-500/80">
            {tab === "assemblies" ? (
              assemblyRows.length === 0 ? (
                <ProductionListEmpty label={loading ? "טוען נתונים..." : "לא נמצאו Assemblies"} />
              ) : (
                <div className="space-y-2">
                  {assemblyRows.map((row) => (
                    <button
                      key={row.key}
                      type="button"
                      className="grid min-h-[6.875rem] w-full grid-cols-[auto_1fr_auto] items-center gap-4 rounded-2xl bg-white/40 p-4 text-right transition hover:bg-white/60 active:scale-[0.995]"
                      onClick={() => onPickAssembly(row)}
                    >
                      <span className="flex w-16 shrink-0 flex-col items-center justify-center text-[#003CFF]">
                        <SquaresUnite className="size-5" aria-hidden />
                        <span className="mt-1 text-[10px] font-bold leading-none">אסמבלי</span>
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-xl font-bold tracking-tight text-zinc-950" dir="ltr">
                          {row.displayMark}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-medium text-zinc-600">
                          <span className="flex items-center gap-1.5">
                            <SquareStack className="size-3.5 text-zinc-600" aria-hidden />
                            <span>כמות לייצור</span>
                            <span className="font-bold text-zinc-950">{formatCount(row.qty)}</span>
                          </span>
                          <span className="flex items-center gap-1.5">
                            <Weight className="size-3.5 text-zinc-600" aria-hidden />
                            <span>משקל ליחידה (ק&quot;ג)</span>
                            <span className="font-bold text-zinc-950" dir="ltr">
                              {formatKgPlain(assemblyUnitWeightKg(row))}
                            </span>
                          </span>
                        </div>
                      </div>
                      <MoveLeft className="size-5 text-zinc-400" aria-hidden />
                    </button>
                  ))}
                </div>
              )
            ) : partRows.length === 0 ? (
              <ProductionListEmpty label={loading ? "טוען נתונים..." : "לא נמצאו Parts"} />
            ) : (
              <div className="space-y-2">
                {partRows.map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    className="grid min-h-[6.875rem] w-full grid-cols-[auto_1fr_auto] items-center gap-4 rounded-2xl bg-white/40 p-4 text-right transition hover:bg-white/60 active:scale-[0.995]"
                    onClick={() => onPickPart(row)}
                  >
                    <span className="flex w-16 shrink-0 flex-col items-center justify-center text-[#003CFF]">
                      <SquaresIntersect className="size-5" aria-hidden />
                      <span className="mt-1 text-[10px] font-bold leading-none">חלק</span>
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-xl font-bold tracking-tight text-zinc-950" dir="ltr">
                        {row.displayMark}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-medium text-zinc-600">
                        <span className="flex items-center gap-1.5">
                          <Minimize className="size-3.5 text-zinc-600" aria-hidden />
                          <span>פרופיל</span>
                          <span className="font-bold text-zinc-950" dir="ltr">
                            {row.displayProfile}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <SquareStack className="size-3.5 text-zinc-600" aria-hidden />
                          <span>כמות לייצור</span>
                          <span className="font-bold text-zinc-950">
                            {formatQuantityInt(row.effectiveQty)}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Weight className="size-3.5 text-zinc-600" aria-hidden />
                          <span>משקל ליחידה (ק&quot;ג)</span>
                          <span className="font-bold text-zinc-950" dir="ltr">
                            {formatKgPlain(partUnitWeightKg(row))}
                          </span>
                        </span>
                      </div>
                    </div>
                    <MoveLeft className="size-5 text-zinc-400" aria-hidden />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <>
      <div
        className="pointer-events-auto absolute inset-x-0 top-[calc(2.5rem+env(safe-area-inset-top))] z-40 border-b border-white/70 bg-white/90 px-3 py-3 shadow-sm backdrop-blur-xl"
        dir="rtl"
      >
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            className="h-12 rounded-2xl px-4 text-sm font-bold text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950"
            onClick={onBackToLists}
          >
            <ArrowRight className="ml-2 size-5" aria-hidden />
            חזור לרשימות
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-black text-zinc-950" dir="ltr">
              {selectionTitle}
            </p>
            <p className="text-xs font-semibold text-zinc-500">
              {selectionKind === "assembly" ? "Assembly focused workspace" : "Part focused workspace"}
            </p>
          </div>
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[#eef3ff] text-[#003CFF]">
            {selectionKind === "assembly" ? (
              <SquaresUnite className="size-6" aria-hidden />
            ) : (
              <SquaresIntersect className="size-6" aria-hidden />
            )}
          </span>
        </div>
      </div>

      {partsDrawerOpen && selectedAssembly ? (
        <div
          className="pointer-events-auto absolute inset-x-0 bottom-0 z-50 rounded-t-[2rem] border-t border-zinc-200 bg-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 shadow-[0_-22px_55px_rgba(15,23,42,0.22)]"
          dir="rtl"
        >
          <div className="mx-auto max-w-4xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#003CFF]">Parts</p>
                <h2 className="text-2xl font-black">חלקים</h2>
              </div>
              <Button
                type="button"
                variant="ghost"
                className="rounded-full px-4 text-sm font-bold text-zinc-600 hover:bg-zinc-100"
                onClick={onPartsDrawerClose}
              >
                סגור
              </Button>
            </div>
            <div className="max-h-[42vh] space-y-2 overflow-auto pr-0.5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-300">
              {selectedAssembly.parts.map((part) => (
                <button
                  key={part.id}
                  type="button"
                  className="grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-right transition hover:border-[#003CFF]/30 hover:bg-white"
                  onClick={() => onPickAssemblyPart(part)}
                >
                  <div className="min-w-0">
                    <p className="truncate text-lg font-black text-zinc-950" dir="ltr">
                      {displayPartMark(part)}
                    </p>
                    <p className="mt-1 truncate text-sm font-semibold text-zinc-500" dir="ltr">
                      {part.profile || "—"} · {formatMmPlain(part.lengthMm)}
                    </p>
                  </div>
                  <SquaresIntersect className="size-6 text-[#003CFF]" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
