"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AnalyzerAssembly, AnalyzerIndexedEntity, AnalyzerPart } from "@/types/domain";
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
import { formatCount } from "@/lib/format-numbers";
import { cn } from "@/lib/utils";

const SECTION_LABELS_HE: Record<"assemblies" | "parts" | "profiles", string> = {
  assemblies: "הרכבות",
  parts: "חלקים ובורגים",
  profiles: "פרופילים",
};

const SECTION_ORDER_BY_INTENT: Record<
  GlobalSearchIntent,
  ("assemblies" | "parts" | "profiles")[]
> = {
  "profile-heavy": ["profiles", "assemblies", "parts"],
  "mark-heavy": ["assemblies", "parts", "profiles"],
  neutral: ["assemblies", "parts", "profiles"],
};

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
    const a: GlobalSearchHit[] = [];
    const p: GlobalSearchHit[] = [];
    const prof: GlobalSearchHit[] = [];
    for (const h of hits) {
      if (h.kind === "assembly") a.push(h);
      else if (h.kind === "part") p.push(h);
      else prof.push(h);
    }
    return { assemblies: a, parts: p, profiles: prof };
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
      return (part.boltName || part.name || part.tag || "").trim() || `#${part.expressId ?? part.id}`;
    }
    return displayPartMark(part);
  }, []);

  const rowSubtitle = useCallback((hit: GlobalSearchHit): string => {
    if (hit.kind === "assembly") {
      const a = hit.assembly;
      const bits = [
        a.expressId != null ? `Express ${a.expressId}` : null,
        (a.name || "").trim(),
        (a.positionCode || "").trim(),
      ].filter(Boolean);
      return bits.slice(0, 2).join(" · ") || a.id.slice(0, 12);
    }
    if (hit.kind === "profile") {
      return `${formatCount(hit.row.totalQty)} יח׳ במודל · ${formatCount(hit.row.instances.length)} מופעי IFC`;
    }
    const part = hit.part;
    if (isAnalyzerBoltRow(part)) {
      return [part.tag, part.boltStandard].filter(Boolean).join(" · ") || part.ifcType;
    }
    const bp = part;
    const prof = (bp.profile || "").trim();
    const mat = (bp.material || "").trim();
    const ex =
      bp.expressId != null ? `Express ${bp.expressId}` : bp.id.slice(0, 10);
    return [prof, mat, ex].filter(Boolean).join(" · ") || bp.ifcType;
  }, []);

  const badge = (hit: GlobalSearchHit) => {
    if (hit.kind === "assembly") return "הרכבה";
    if (hit.kind === "profile") return "פרופיל";
    if (isAnalyzerBoltRow(hit.part)) return "בורג";
    return "חלק";
  };

  const activate = async (hit: GlobalSearchHit) => {
    if (hit.kind === "assembly") await onPickAssembly(hit.assembly);
    else if (hit.kind === "part") await onPickPart(hit.part);
    else await onPickProfileRow(hit.row);
  };

  const renderHitButton = (hit: GlobalSearchHit, idxGlobal: number) => (
    <button
      key={`${hit.kind}-${idxGlobal}-${hit.kind === "assembly" ? hit.assembly.id : hit.kind === "profile" ? hit.row.key : hit.part.id}`}
      type="button"
      className="flex w-full items-start gap-2 border-b border-zinc-800 px-3 py-2.5 text-right transition-colors hover:bg-zinc-800/90"
      onClick={() => void activate(hit)}
    >
      <span className="mt-0.5 shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
        {badge(hit)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-zinc-100">{rowLabel(hit)}</span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-500">{rowSubtitle(hit)}</span>
      </span>
    </button>
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]" dir="rtl" role="presentation">
      <button
        type="button"
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        aria-label="סגור חיפוש"
        onClick={onClose}
      />
      <div className="pointer-events-none relative flex justify-center px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div
          className="pointer-events-auto w-full max-w-xl rounded-2xl border border-zinc-600 bg-zinc-950 shadow-2xl"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          role="search"
        >
          <div className="flex items-center gap-2 border-b border-zinc-800 p-2">
            <Search className="h-5 w-5 shrink-0 text-zinc-500" aria-hidden />
            <input
              ref={inputRef}
              type="search"
              placeholder="חפש הרכבה, חלק, פרופיל, בורג…"
              className="min-w-0 flex-1 bg-transparent py-2 pe-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button type="button" variant="ghost" className="h-9 shrink-0 px-2" onClick={onClose}>
              <X className="h-5 w-5" />
              <span className="sr-only">סגור</span>
            </Button>
          </div>
          <div
            className={cn(
              "max-h-[min(70vh,28rem)] overflow-y-auto rounded-b-2xl",
              query.trim() ? "" : "py-10 text-center",
            )}
          >
            {!query.trim() ? (
              <p className="text-sm text-zinc-500">התחל להקליד כדי להציג תוצאות מהמודל</p>
            ) : grouped.assemblies.length + grouped.parts.length + grouped.profiles.length === 0 ? (
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
                          <p className="sticky top-0 bg-zinc-950/97 px-3 py-2 text-[11px] font-semibold text-zinc-500">
                            {SECTION_LABELS_HE[sectionKey]}
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
