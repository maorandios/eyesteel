"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bolt, Search, Square, SquaresIntersect, SquaresUnite, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AnalyzerAssembly, AnalyzerBoltRow, AnalyzerIndexedEntity, AnalyzerPart } from "@/types/domain";
import { isAnalyzerBoltRow } from "@/types/domain";
import type { AggregatedProfileTabRow } from "@/components/viewer/SelectionPickDetails";
import { aggregateProfilesForModelTab, displayPartMark } from "@/components/viewer/SelectionPickDetails";
import {
  computeGlobalSearchHits,
  inferGlobalSearchIntent,
  type GlobalSearchHit,
  type GlobalSearchIntent,
} from "@/lib/viewer/global-search";
import { displayAssemblyMark } from "@/lib/viewer/modelAggregates";
import { formatCount, formatKgPlain } from "@/lib/format-numbers";
import { cn } from "@/lib/utils";

type SearchSectionKey = "assemblies" | "parts" | "profiles" | "bolts";
type AssemblySearchHit = Extract<GlobalSearchHit, { kind: "assembly" }>;
type PartSearchHit = Extract<GlobalSearchHit, { kind: "part" }> & { part: AnalyzerPart };
type BoltSearchHit = Extract<GlobalSearchHit, { kind: "part" }> & { part: AnalyzerBoltRow };

const SEARCH_SCROLLBAR_CLASS =
  "scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-300 hover:scrollbar-thumb-zinc-400 [scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-400";

const SECTION_LABELS_HE: Record<SearchSectionKey, string> = {
  assemblies: "אסמבלי",
  parts: "חלקים",
  profiles: "פרופילים",
  bolts: "ברגים",
};

const SECTION_ORDER_BY_INTENT: Record<GlobalSearchIntent, SearchSectionKey[]> = {
  "profile-heavy": ["profiles", "assemblies", "parts", "bolts"],
  "mark-heavy": ["assemblies", "parts", "profiles", "bolts"],
  neutral: ["assemblies", "parts", "profiles", "bolts"],
};

function boltDisplayName(part: AnalyzerBoltRow): string {
  return (part.boltName || part.name || part.tag || "").trim() || `#${part.expressId ?? part.id}`;
}

function boltQtyContribution(part: AnalyzerBoltRow): number {
  return part.boltQty != null && Number.isFinite(part.boltQty) ? part.boltQty : 1;
}

function boltGroupKey(part: AnalyzerBoltRow): string {
  const name = boltDisplayName(part).trim().toLowerCase();
  const standard = (part.boltStandard || "").trim().toLowerCase();
  return `${name}\0${standard}`;
}

function mergeBoltHits(hits: BoltSearchHit[]): GlobalSearchHit[] {
  const groups = new Map<
    string,
    {
      first: BoltSearchHit;
      totalQty: number;
      rank: number;
    }
  >();

  for (const hit of hits) {
    if (!isAnalyzerBoltRow(hit.part)) continue;
    const key = boltGroupKey(hit.part);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        first: hit,
        totalQty: boltQtyContribution(hit.part),
        rank: hit.rank,
      });
      continue;
    }

    existing.totalQty += boltQtyContribution(hit.part);
    existing.rank = Math.min(existing.rank, hit.rank);
  }

  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank || boltDisplayName(a.first.part).localeCompare(boltDisplayName(b.first.part)))
    .map(({ first, totalQty, rank }) => ({
      ...first,
      rank,
      part: {
        ...first.part,
        boltQty: totalQty,
      },
    }));
}

function partGroupKey(part: AnalyzerPart): string {
  const mark = displayPartMark(part).trim().toLowerCase();
  const profile = (part.profile || "").trim().toLowerCase();
  const name = (part.name || "").trim().toLowerCase();
  const weight =
    part.weightKg != null && Number.isFinite(part.weightKg) ? part.weightKg.toFixed(4) : "";
  return `${mark}\0${profile}\0${name}\0${weight}`;
}

function mergePartHits(hits: PartSearchHit[]): GlobalSearchHit[] {
  const groups = new Map<
    string,
    {
      first: PartSearchHit;
      totalWeightKg: number | null;
      rank: number;
    }
  >();

  for (const hit of hits) {
    const key = partGroupKey(hit.part);
    const existing = groups.get(key);
    const weight = hit.part.weightKg;
    const hasWeight = weight != null && Number.isFinite(weight);
    if (!existing) {
      groups.set(key, {
        first: hit,
        totalWeightKg: hasWeight ? weight : null,
        rank: hit.rank,
      });
      continue;
    }

    existing.rank = Math.min(existing.rank, hit.rank);
    if (hasWeight) {
      existing.totalWeightKg = (existing.totalWeightKg ?? 0) + weight;
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank || displayPartMark(a.first.part).localeCompare(displayPartMark(b.first.part)))
    .map(({ first, totalWeightKg, rank }) => ({
      ...first,
      rank,
      part: {
        ...first.part,
        weightKg: totalWeightKg,
      },
    }));
}

function assemblyGroupKey(assembly: AnalyzerAssembly): string {
  return displayAssemblyMark(assembly).trim().toLowerCase();
}

function mergeAssemblyHits(hits: AssemblySearchHit[]): GlobalSearchHit[] {
  const groups = new Map<
    string,
    {
      first: AssemblySearchHit;
      parts: AnalyzerPart[];
      bolts: AnalyzerBoltRow[];
      totalWeightKg: number | null;
      rank: number;
    }
  >();

  for (const hit of hits) {
    const key = assemblyGroupKey(hit.assembly);
    const existing = groups.get(key);
    const weight = hit.assembly.weightKg;
    const hasWeight = weight != null && Number.isFinite(weight);
    if (!existing) {
      groups.set(key, {
        first: hit,
        parts: [...hit.assembly.parts],
        bolts: [...(hit.assembly.bolts ?? [])],
        totalWeightKg: hasWeight ? weight : null,
        rank: hit.rank,
      });
      continue;
    }

    existing.parts.push(...hit.assembly.parts);
    existing.bolts.push(...(hit.assembly.bolts ?? []));
    existing.rank = Math.min(existing.rank, hit.rank);
    if (hasWeight) {
      existing.totalWeightKg = (existing.totalWeightKg ?? 0) + weight;
    }
  }

  return [...groups.values()]
    .sort((a, b) =>
      a.rank - b.rank || displayAssemblyMark(a.first.assembly).localeCompare(displayAssemblyMark(b.first.assembly)),
    )
    .map(({ first, parts, bolts, totalWeightKg, rank }) => ({
      ...first,
      rank,
      assembly: {
        ...first.assembly,
        id: `merged-assembly:${assemblyGroupKey(first.assembly)}`,
        expressId: null,
        weightKg: totalWeightKg,
        parts,
        bolts,
      },
    }));
}

type Props = {
  open: boolean;
  onClose: () => void;
  assemblies: AnalyzerAssembly[];
  indexedParts: AnalyzerIndexedEntity[];
  /** Steel-only (לא בורגים) — לאיגוד פרופילים כמו במסך הנתונים. */
  steelParts: AnalyzerPart[];
  onPickAssembly: (a: AnalyzerAssembly) => void | Promise<void>;
  onPickPart: (p: AnalyzerIndexedEntity) => void | Promise<void>;
  onPickProfileRow: (r: AggregatedProfileTabRow) => void | Promise<void>;
};

export function GlobalSearchOverlay({
  open,
  onClose,
  assemblies,
  indexedParts,
  steelParts,
  onPickAssembly,
  onPickPart,
  onPickProfileRow,
}: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const profileRows = useMemo(() => aggregateProfilesForModelTab(steelParts), [steelParts]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const hits = useMemo(
    () => computeGlobalSearchHits(assemblies, indexedParts, profileRows, query),
    [assemblies, indexedParts, profileRows, query],
  );

  const grouped = useMemo(() => {
    const assemblyHits: AssemblySearchHit[] = [];
    const partHits: PartSearchHit[] = [];
    const prof: GlobalSearchHit[] = [];
    const boltHits: BoltSearchHit[] = [];
    for (const h of hits) {
      if (h.kind === "assembly") assemblyHits.push(h);
      else if (h.kind === "part") {
        if (isAnalyzerBoltRow(h.part)) boltHits.push({ ...h, part: h.part });
        else partHits.push({ ...h, part: h.part });
      }
      else prof.push(h);
    }
    const a = mergeAssemblyHits(assemblyHits);
    const p = mergePartHits(partHits);
    const bolts = mergeBoltHits(boltHits);
    return { assemblies: a, parts: p, profiles: prof, bolts };
  }, [hits]);

  const searchIntent = useMemo(() => inferGlobalSearchIntent(query), [query]);
  const sectionKeys = SECTION_ORDER_BY_INTENT[searchIntent];

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const rowLabel = useCallback((hit: GlobalSearchHit) => {
    if (hit.kind === "assembly") {
      return displayAssemblyMark(hit.assembly);
    }
    if (hit.kind === "profile") {
      return hit.row.profileLabel;
    }
    const part = hit.part;
    if (isAnalyzerBoltRow(part)) {
      return boltDisplayName(part);
    }
    return displayPartMark(part);
  }, []);

  const rowSubtitle = useCallback((hit: GlobalSearchHit): string => {
    if (hit.kind === "assembly") {
      const a = hit.assembly;
      return `${formatCount(a.parts.length)} יח׳ · ${formatKgPlain(a.weightKg)} ק״ג`;
    }
    if (hit.kind === "profile") {
      return `${formatCount(hit.row.totalQty)} יח׳ · ${formatKgPlain(hit.row.totalWeightKg)} ק״ג`;
    }
    const part = hit.part;
    if (isAnalyzerBoltRow(part)) {
      const qty = part.boltQty != null && !Number.isNaN(part.boltQty) ? formatCount(part.boltQty) : "—";
      const standard = (part.boltStandard || "").trim() || "—";
      return `${qty} יח׳ · ${standard}`;
    }
    return part.ifcType;
  }, []);

  const badge = (hit: GlobalSearchHit) => {
    if (hit.kind === "assembly") return "אסמבלי";
    if (hit.kind === "profile") return "פרופיל";
    if (isAnalyzerBoltRow(hit.part)) return "בורג";
    return "חלק";
  };

  const activate = async (hit: GlobalSearchHit) => {
    if (hit.kind === "assembly") await onPickAssembly(hit.assembly);
    else if (hit.kind === "part") await onPickPart(hit.part);
    else await onPickProfileRow(hit.row);
  };

  const renderBadge = (hit: GlobalSearchHit) => {
    const label = badge(hit);

    if (hit.kind === "assembly") {
      return (
        <span className="flex w-10 shrink-0 flex-col items-center justify-center gap-0.5 px-1.5 py-1 text-zinc-600">
          <SquaresUnite className="h-4 w-4" aria-hidden />
          <span className="text-[10px] font-bold leading-none">{label}</span>
        </span>
      );
    }

    if (hit.kind === "profile") {
      return (
        <span className="flex w-10 shrink-0 flex-col items-center justify-center gap-0.5 px-1.5 py-1 text-zinc-600">
          <Square className="h-4 w-4" aria-hidden />
          <span className="text-[10px] font-bold leading-none">{label}</span>
        </span>
      );
    }

    if (isAnalyzerBoltRow(hit.part)) {
      return (
        <span className="flex w-10 shrink-0 flex-col items-center justify-center gap-0.5 px-1.5 py-1 text-zinc-600">
          <Bolt className="h-4 w-4" aria-hidden />
          <span className="text-[10px] font-bold leading-none">{label}</span>
        </span>
      );
    }

    return (
      <span className="flex w-10 shrink-0 flex-col items-center justify-center gap-0.5 px-1.5 py-1 text-zinc-600">
        <SquaresIntersect className="h-4 w-4" aria-hidden />
        <span className="text-[10px] font-bold leading-none">{label}</span>
      </span>
    );
  };

  const renderSubtitle = (hit: GlobalSearchHit) => {
    if (hit.kind === "part" && !isAnalyzerBoltRow(hit.part)) {
      const profile = (hit.part.profile || "").trim() || "ללא פרופיל";
      return (
        <span className="inline-flex max-w-full flex-row items-center gap-1" dir="rtl">
          <span className="truncate" dir="ltr">
            {profile}
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex shrink-0 flex-row items-center gap-1" dir="rtl">
            <span dir="ltr">{formatKgPlain(hit.part.weightKg)}</span>
            <span>ק״ג</span>
          </span>
        </span>
      );
    }

    return rowSubtitle(hit);
  };

  const renderSectionLabel = (sectionKey: SearchSectionKey) => {
    const iconClassName = "h-[18px] w-[18px]";
    const icon =
      sectionKey === "assemblies" ? (
        <SquaresUnite className={iconClassName} aria-hidden />
      ) : sectionKey === "parts" ? (
        <SquaresIntersect className={iconClassName} aria-hidden />
      ) : sectionKey === "profiles" ? (
        <Square className={iconClassName} aria-hidden />
      ) : (
        <Bolt className={iconClassName} aria-hidden />
      );

    return (
      <span className="inline-flex items-center gap-2 text-[14px] text-[#003CFF]">
        {icon}
        <span>{SECTION_LABELS_HE[sectionKey]}</span>
      </span>
    );
  };

  const renderHitButton = (hit: GlobalSearchHit, idxGlobal: number) => (
    <button
      key={`${hit.kind}-${idxGlobal}-${hit.kind === "assembly" ? hit.assembly.id : hit.kind === "profile" ? hit.row.key : hit.part.id}`}
      type="button"
      className="flex w-full items-start gap-2 border-b border-zinc-200/80 px-3.5 py-3 text-right transition-colors hover:bg-zinc-100/90"
      onClick={() => void activate(hit)}
    >
      {renderBadge(hit)}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-zinc-900">{rowLabel(hit)}</span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-500">{renderSubtitle(hit)}</span>
      </span>
    </button>
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]" dir="rtl" role="presentation">
      <button
        type="button"
        className="absolute inset-0 bg-zinc-950/35 backdrop-blur-[2px]"
        aria-label="סגור חיפוש"
        onClick={onClose}
      />
      <div className="pointer-events-none relative flex justify-center px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div
          className="pointer-events-auto w-full max-w-xl overflow-hidden rounded-2xl border border-zinc-300/90 bg-[#f4f6f8]/95 text-zinc-900 shadow-2xl ring-1 ring-white/70 backdrop-blur-md"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          role="search"
        >
          <div className="flex items-center gap-2 border-b border-zinc-300/80 bg-white/80 p-2">
            <Search className="h-5 w-5 shrink-0 text-zinc-500" aria-hidden />
            <input
              ref={inputRef}
              type="text"
              placeholder="חפש הרכבה, חלק, פרופיל, בורג…"
              className="min-w-0 flex-1 bg-transparent py-2 pe-2 text-sm font-medium text-zinc-900 outline-none placeholder:text-zinc-400"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              className="h-9 shrink-0 px-2 text-zinc-600 hover:bg-zinc-200/80 hover:text-zinc-950"
              onClick={onClose}
            >
              <X className="h-5 w-5" />
              <span className="sr-only">סגור</span>
            </Button>
          </div>
          <div
            className={cn(
              "max-h-[min(70vh,28rem)] overflow-y-auto rounded-b-2xl bg-white/55",
              SEARCH_SCROLLBAR_CLASS,
              query.trim() ? "" : "py-10 text-center",
            )}
          >
            {!query.trim() ? (
              <p className="text-sm text-zinc-500">התחל להקליד כדי להציג תוצאות מהמודל</p>
            ) : grouped.assemblies.length + grouped.parts.length + grouped.profiles.length + grouped.bolts.length ===
              0 ? (
              <p className="px-4 py-8 text-sm text-zinc-500">אין תוצאות עבור &quot;{query.trim()}&quot;</p>
            ) : (
              (() => {
                let rowIdx = 0;
                return (
                  <>
                    {sectionKeys.map((sectionKey) => {
                      const rowList = grouped[sectionKey];
                      if (rowList.length === 0) return null;
                      return (
                        <Fragment key={sectionKey}>
                          <p className="px-3.5 pb-2 pt-4 text-[11px] font-bold text-zinc-500">
                            {renderSectionLabel(sectionKey)}
                          </p>
                          {rowList.map((h) => renderHitButton(h, rowIdx++))}
                        </Fragment>
                      );
                    })}
                  </>
                );
              })()
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
