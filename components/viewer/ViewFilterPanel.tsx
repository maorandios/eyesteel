"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, Eye, EyeOff, Funnel, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AnalyzerAssembly, AnalyzerPart } from "@/types/domain";
import {
  aggregateAssembliesByMark,
  type AggregatedAssemblyRow,
} from "@/lib/viewer/modelAggregates";
import {
  type ViewFilterGhostTab,
  useViewFilterStore,
} from "@/lib/state/view-filter-store";
import { formatCount, formatQuantityInt } from "@/lib/format-numbers";
import {
  aggregateProfilesForModelTab,
  aggregateSteelPartsForModelTab,
  displayPartMark,
  steelPartEntityQtyContribution,
} from "@/components/viewer/SelectionPickDetails";
import { cn } from "@/lib/utils";

type FilterTab = ViewFilterGhostTab;
const PANEL_SCROLL =
  "scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-400/70 hover:scrollbar-thumb-zinc-500/80 [scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-400/70 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-500/80";
const EYE_BUTTON_CLASS = "text-[#003CFF] hover:bg-[#003CFF]/10 hover:text-[#003CFF]";
const EYE_BUTTON_DISABLED_CLASS = "cursor-not-allowed text-[#003CFF]/50";
const EYE_ICON_CLASS = "!text-[#003CFF]";

function aggregatePartsForAssemblyRow(row: AggregatedAssemblyRow): { part: AnalyzerPart; qty: number }[] {
  const m = new Map<string, { part: AnalyzerPart; qty: number }>();
  for (const asm of row.instances) {
    for (const p of asm.parts) {
      const add = p.quantity ?? 1;
      const prev = m.get(p.id);
      if (prev) prev.qty += add;
      else m.set(p.id, { part: p, qty: add });
    }
  }
  return Array.from(m.values()).sort((a, b) =>
    displayPartMark(a.part).localeCompare(displayPartMark(b.part), "he", { numeric: true }),
  );
}

function TabGhostEye({
  label,
  active,
  ghostOnThisTab,
  onSelectTab,
  onToggleGhost,
}: {
  label: string;
  active: boolean;
  ghostOnThisTab: boolean;
  onSelectTab: () => void;
  onToggleGhost: () => void;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 transition-colors",
        active ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-600 hover:bg-white/70",
      )}
    >
      <button
        type="button"
        className={cn(
          "min-w-0 flex-1 truncate rounded-md px-1 py-1 text-xs font-medium transition-colors",
          !active && "hover:bg-white/40",
        )}
        onClick={onSelectTab}
      >
        {label}
      </button>
      <button
        type="button"
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-md transition-colors",
          ghostOnThisTab ? "bg-[#003CFF]/10 text-[#003CFF]" : EYE_BUTTON_CLASS,
        )}
        title="מצב רוח (כמו הצג בהקשר): לחץ שורות בטבלה כדי להציג רגיל"
        aria-label={`מצב רוח בשונית ${label}`}
        aria-pressed={ghostOnThisTab}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleGhost();
        }}
      >
        <Eye className={`size-4 ${EYE_ICON_CLASS}`} />
      </button>
    </div>
  );
}

type Props = {
  assemblies: AnalyzerAssembly[];
  steelParts: AnalyzerPart[];
  onClose: () => void;
};

export function ViewFilterPanel({ assemblies, steelParts, onClose }: Props) {
  const [tab, setTab] = useState<FilterTab>("assemblies");
  const [expandedAssemblyKey, setExpandedAssemblyKey] = useState<string | null>(null);
  const [expandedPartRowKey, setExpandedPartRowKey] = useState<string | null>(null);
  const [expandedProfileRowKey, setExpandedProfileRowKey] = useState<string | null>(null);

  const toggleAssemblyKey = useViewFilterStore((s) => s.toggleAssemblyKey);
  const togglePartId = useViewFilterStore((s) => s.togglePartId);
  const togglePartTabGroupKey = useViewFilterStore((s) => s.togglePartTabGroupKey);
  const toggleProfileTabGroupKey = useViewFilterStore((s) => s.toggleProfileTabGroupKey);
  const isAssemblyHidden = useViewFilterStore((s) => s.isAssemblyHidden);
  const isPartHidden = useViewFilterStore((s) => s.isPartHidden);
  const isPartTabGroupHidden = useViewFilterStore((s) => s.isPartTabGroupHidden);
  const isProfileTabGroupHidden = useViewFilterStore((s) => s.isProfileTabGroupHidden);
  const reset = useViewFilterStore((s) => s.reset);
  const ghostFocusTab = useViewFilterStore((s) => s.ghostFocusTab);
  const ghostRevealedPartIds = useViewFilterStore((s) => s.ghostRevealedPartIds);
  const activateGhostRevealTab = useViewFilterStore((s) => s.activateGhostRevealTab);
  const exitGhostRevealMode = useViewFilterStore((s) => s.exitGhostRevealMode);
  const toggleGhostRevealGroup = useViewFilterStore((s) => s.toggleGhostRevealGroup);

  const ghostRevealActive = ghostFocusTab !== null;

  const rows = useMemo(() => aggregateAssembliesByMark(assemblies), [assemblies]);
  const modelPartRows = useMemo(() => aggregateSteelPartsForModelTab(steelParts), [steelParts]);
  const modelProfileRows = useMemo(() => aggregateProfilesForModelTab(steelParts), [steelParts]);

  const handleReset = () => {
    reset();
  };

  return (
    <>
      <div className="relative mb-4 flex min-h-8 items-center justify-between gap-3 pb-1">
        <div className="flex min-w-0 items-center gap-2">
          <Funnel className="size-5 shrink-0 text-zinc-600" aria-hidden />
          <p className="text-sm font-semibold text-zinc-950">סינון תצוגה</p>
        </div>
        <div className="ml-9 flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-8 rounded-full bg-white px-3 text-xs font-semibold text-zinc-700 shadow-sm hover:bg-zinc-100"
            onClick={handleReset}
          >
            איפוס
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute left-0 top-1/2 size-8 -translate-y-1/2 rounded-full text-zinc-500 hover:bg-zinc-200 hover:text-zinc-950"
            onClick={onClose}
            aria-label="סגור סינון תצוגה"
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      <div className="mb-3 flex gap-1 rounded-xl border border-zinc-300 bg-zinc-200/70 p-1">
        <TabGhostEye
          label="הרכבות"
          active={tab === "assemblies"}
          ghostOnThisTab={ghostFocusTab === "assemblies"}
          onSelectTab={() => setTab("assemblies")}
          onToggleGhost={() => {
            if (ghostFocusTab === "assemblies") exitGhostRevealMode();
            else activateGhostRevealTab("assemblies");
          }}
        />
        <TabGhostEye
          label="חלקים"
          active={tab === "parts"}
          ghostOnThisTab={ghostFocusTab === "parts"}
          onSelectTab={() => setTab("parts")}
          onToggleGhost={() => {
            if (ghostFocusTab === "parts") exitGhostRevealMode();
            else activateGhostRevealTab("parts");
          }}
        />
        <TabGhostEye
          label="פרופילים"
          active={tab === "profiles"}
          ghostOnThisTab={ghostFocusTab === "profiles"}
          onSelectTab={() => setTab("profiles")}
          onToggleGhost={() => {
            if (ghostFocusTab === "profiles") exitGhostRevealMode();
            else activateGhostRevealTab("profiles");
          }}
        />
      </div>

      <div
        className={cn(
          PANEL_SCROLL,
          "max-h-[calc(100vh-9.5rem)] overflow-auto p-1.5",
        )}
      >
        {tab === "assemblies" && (
          <>
            {rows.length === 0 ? (
              <p className="px-1 py-4 text-center text-sm text-zinc-500">אין הרכבות במודל</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky -top-1.5 z-10 bg-[#eef1f3] text-[10px] text-zinc-500">
                  <tr>
                    <th className="w-11 p-1 text-center font-medium">תצוגה</th>
                    <th className="p-2 text-right font-medium">מספר הרכבה</th>
                    <th className="p-2 text-right font-medium">כמות</th>
                    <th className="w-8 p-1" aria-hidden />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const expanded = expandedAssemblyKey === row.key;
                    const asmH = isAssemblyHidden(row.key);
                    const partRows = aggregatePartsForAssemblyRow(row);
                    const assemblyPartIds = partRows.map((pr) => pr.part.id);
                    const assemblyGhostAllRevealed =
                      ghostRevealActive &&
                      assemblyPartIds.length > 0 &&
                      assemblyPartIds.every((id) => ghostRevealedPartIds[id]);

                    return (
                      <Fragment key={row.key}>
                        <tr
                          className="cursor-pointer border-t border-zinc-200 hover:bg-zinc-200/70"
                          onClick={() =>
                            setExpandedAssemblyKey((k) => (k === row.key ? null : row.key))
                          }
                        >
                          <td className="p-1 text-center align-middle">
                            <button
                              type="button"
                              className={`inline-flex rounded-md p-1.5 ${EYE_BUTTON_CLASS}`}
                              title={
                                ghostRevealActive
                                  ? assemblyGhostAllRevealed
                                    ? "החזר קבוצה למצב רוח"
                                    : "הצג חלקי הרכבה רגילים"
                                  : asmH
                                    ? "הצג במודל"
                                    : "הסתר במודל"
                              }
                              aria-label="תצוגה"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (ghostRevealActive) {
                                  toggleGhostRevealGroup(assemblyPartIds);
                                } else {
                                  toggleAssemblyKey(row.key);
                                }
                              }}
                            >
                              {ghostRevealActive ? (
                                assemblyGhostAllRevealed ? (
                                  <Eye className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                                ) : (
                                  <EyeOff className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                                )
                              ) : asmH ? (
                                <EyeOff className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                              ) : (
                                <Eye className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                              )}
                            </button>
                          </td>
                          <td className="p-2 font-medium text-zinc-900">{row.displayMark}</td>
                          <td className="p-2 text-zinc-700">{formatCount(row.qty)}</td>
                          <td className="p-1 align-middle">
                            <ChevronDown
                              className={cn(
                                "mx-auto h-4 w-4 text-zinc-500 transition-transform",
                                expanded ? "rotate-180" : "rotate-0",
                              )}
                              aria-hidden
                            />
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="border-t border-zinc-200 bg-zinc-50/80">
                            <td colSpan={4} className="p-0">
                              {partRows.length === 0 ? (
                                <p className="px-4 py-3 text-[11px] text-zinc-500">אין חלקים במסכת הרכבה זו</p>
                              ) : (
                                <table className="w-full text-[11px]">
                                  <thead className="text-[10px] text-zinc-500">
                                    <tr>
                                      <th className="w-11 p-1 text-center font-medium">תצוגה</th>
                                      <th className="p-2 pr-6 text-right font-medium">שם חלק</th>
                                      <th className="p-2 text-right font-medium">כמות</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {partRows.map(({ part, qty }: { part: AnalyzerPart; qty: number }) => {
                                      const parentHides = asmH;
                                      const partOnly = !parentHides && isPartHidden(part.id);
                                      const showOff = parentHides || partOnly;
                                      const ghostRev = ghostRevealedPartIds[part.id];

                                      return (
                                        <tr key={part.id} className="border-t border-zinc-200">
                                          <td className="p-1 text-center">
                                            <button
                                              type="button"
                                              className={cn(
                                                "inline-flex rounded-md p-1.5",
                                                parentHides && !ghostRevealActive
                                                  ? EYE_BUTTON_DISABLED_CLASS
                                                  : EYE_BUTTON_CLASS,
                                              )}
                                              disabled={parentHides && !ghostRevealActive}
                                              title={
                                                ghostRevealActive
                                                  ? ghostRev
                                                    ? "החזר למצב רוח"
                                                    : "הצג חלק רגיל"
                                                  : parentHides
                                                    ? "הרכבה מוסתרת"
                                                    : partOnly
                                                      ? "הצג במודל"
                                                      : "הסתר במודל"
                                              }
                                              aria-label="תצוגת חלק"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                if (ghostRevealActive) {
                                                  toggleGhostRevealGroup([part.id]);
                                                  return;
                                                }
                                                if (!parentHides) togglePartId(part.id);
                                              }}
                                            >
                                              {ghostRevealActive ? (
                                                ghostRev ? (
                                                  <Eye className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                                ) : (
                                                  <EyeOff className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                                )
                                              ) : showOff ? (
                                                <EyeOff className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                              ) : (
                                                <Eye className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                              )}
                                            </button>
                                          </td>
                                          <td className="p-2 pr-6 font-medium text-zinc-800">{displayPartMark(part)}</td>
                                          <td className="p-2 text-zinc-600">{formatQuantityInt(qty)}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === "parts" && (
          <>
            {modelPartRows.length === 0 ? (
              <p className="px-1 py-4 text-center text-sm text-zinc-500">אין חלקים במודל</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky -top-1.5 z-10 bg-[#eef1f3] text-[10px] text-zinc-500">
                  <tr>
                    <th className="w-11 p-1 text-center font-medium">תצוגה</th>
                    <th className="p-2 text-right font-medium">מספר חלק</th>
                    <th className="p-2 text-right font-medium">פרופיל</th>
                    <th className="p-2 text-right font-medium">כמות</th>
                    <th className="w-8 p-1" aria-hidden />
                  </tr>
                </thead>
                <tbody>
                  {modelPartRows.map((row) => {
                    const canExpand = row.effectiveQty > 1 || row.instances.length > 1;
                    const expanded = expandedPartRowKey === row.key;
                    const groupH = isPartTabGroupHidden(row.key);
                    const rowPartIds = row.instances.map((p) => p.id);
                    const partGroupGhostAllRevealed =
                      ghostRevealActive &&
                      rowPartIds.length > 0 &&
                      rowPartIds.every((id) => ghostRevealedPartIds[id]);

                    return (
                      <Fragment key={row.key}>
                        <tr
                          className={cn(
                            "border-t border-zinc-200 hover:bg-zinc-200/70",
                            canExpand ? "cursor-pointer" : "",
                          )}
                          onClick={() => {
                            if (!canExpand) return;
                            setExpandedPartRowKey((k) => (k === row.key ? null : row.key));
                          }}
                        >
                          <td className="p-1 text-center align-middle">
                            <button
                              type="button"
                              className={`inline-flex rounded-md p-1.5 ${EYE_BUTTON_CLASS}`}
                              title={
                                ghostRevealActive
                                  ? partGroupGhostAllRevealed
                                    ? "החזר קבוצה למצב רוח"
                                    : "הצג קבוצת חלקים רגילים"
                                  : groupH
                                    ? "הצג במודל"
                                    : "הסתר במודל"
                              }
                              aria-label="תצוגה"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (ghostRevealActive) toggleGhostRevealGroup(rowPartIds);
                                else togglePartTabGroupKey(row.key);
                              }}
                            >
                              {ghostRevealActive ? (
                                partGroupGhostAllRevealed ? (
                                  <Eye className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                                ) : (
                                  <EyeOff className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                                )
                              ) : groupH ? (
                                <EyeOff className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                              ) : (
                                <Eye className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                              )}
                            </button>
                          </td>
                          <td className="p-2 font-medium text-zinc-900">{row.displayMark}</td>
                          <td className="p-2 text-zinc-700">{row.displayProfile}</td>
                          <td className="p-2 text-zinc-700">{formatQuantityInt(row.effectiveQty)}</td>
                          <td className="p-1 align-middle">
                            {canExpand ? (
                              <ChevronDown
                                className={cn(
                                  "mx-auto h-4 w-4 text-zinc-500 transition-transform",
                                  expanded ? "rotate-180" : "rotate-0",
                                )}
                                aria-hidden
                              />
                            ) : (
                              <span className="block h-4 w-4" aria-hidden />
                            )}
                          </td>
                        </tr>
                        {expanded && canExpand && (
                          <tr className="border-t border-zinc-200 bg-zinc-50/80">
                            <td colSpan={5} className="p-0">
                              <table className="w-full text-[11px]">
                                <thead className="text-[10px] text-zinc-500">
                                  <tr>
                                    <th className="w-11 p-1 text-center font-medium">תצוגה</th>
                                    <th className="p-2 pr-6 text-right font-medium">מספר חלק</th>
                                    <th className="p-2 text-right font-medium">פרופיל</th>
                                    <th className="p-2 text-right font-medium">כמות</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {row.instances.map((part) => {
                                    const parentHides = groupH;
                                    const partOnly = !parentHides && isPartHidden(part.id);
                                    const showOff = parentHides || partOnly;
                                    const ghostRev = ghostRevealedPartIds[part.id];
                                    const subLabel = displayPartMark(part);

                                    return (
                                      <tr key={part.id} className="border-t border-zinc-200">
                                        <td className="p-1 text-center">
                                          <button
                                            type="button"
                                            className={cn(
                                              "inline-flex rounded-md p-1.5",
                                              parentHides && !ghostRevealActive
                                                ? EYE_BUTTON_DISABLED_CLASS
                                                : EYE_BUTTON_CLASS,
                                            )}
                                            disabled={parentHides && !ghostRevealActive}
                                            title={
                                              ghostRevealActive
                                                ? ghostRev
                                                  ? "החזר למצב רוח"
                                                  : "הצג חלק רגיל"
                                                : parentHides
                                                  ? "הקבוצה מוסתרת"
                                                  : partOnly
                                                    ? "הצג במודל"
                                                    : "הסתר במודל"
                                            }
                                            aria-label="תצוגת חלק"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              if (ghostRevealActive) {
                                                toggleGhostRevealGroup([part.id]);
                                                return;
                                              }
                                              if (!parentHides) togglePartId(part.id);
                                            }}
                                          >
                                            {ghostRevealActive ? (
                                              ghostRev ? (
                                                <Eye className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                              ) : (
                                                <EyeOff className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                              )
                                            ) : showOff ? (
                                              <EyeOff className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                            ) : (
                                              <Eye className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                            )}
                                          </button>
                                        </td>
                                        <td
                                          className="p-2 pr-6 font-medium text-zinc-800"
                                          title={part.id}
                                        >
                                          {subLabel}
                                        </td>
                                        <td className="p-2 text-zinc-600">{row.displayProfile}</td>
                                        <td className="p-2 text-zinc-600">
                                          {formatQuantityInt(steelPartEntityQtyContribution(part))}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === "profiles" && (
          <>
            {modelProfileRows.length === 0 ? (
              <p className="px-1 py-4 text-center text-sm text-zinc-500">אין פרופילים במודל</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky -top-1.5 z-10 bg-[#eef1f3] text-[10px] text-zinc-500">
                  <tr>
                    <th className="w-11 p-1 text-center font-medium">תצוגה</th>
                    <th className="p-2 text-right font-medium">שם הפרופיל</th>
                    <th className="p-2 text-right font-medium">כמות</th>
                    <th className="w-8 p-1" aria-hidden />
                  </tr>
                </thead>
                <tbody>
                  {modelProfileRows.map((row) => {
                    const canExpand = row.totalQty > 1 || row.instances.length > 1;
                    const expanded = expandedProfileRowKey === row.key;
                    const groupH = isProfileTabGroupHidden(row.key);
                    const profPartIds = row.instances.map((p) => p.id);
                    const profGroupGhostAllRevealed =
                      ghostRevealActive &&
                      profPartIds.length > 0 &&
                      profPartIds.every((id) => ghostRevealedPartIds[id]);

                    return (
                      <Fragment key={row.key}>
                        <tr
                          className={cn(
                            "border-t border-zinc-200 hover:bg-zinc-200/70",
                            canExpand ? "cursor-pointer" : "",
                          )}
                          onClick={() => {
                            if (!canExpand) return;
                            setExpandedProfileRowKey((k) => (k === row.key ? null : row.key));
                          }}
                        >
                          <td className="p-1 text-center align-middle">
                            <button
                              type="button"
                              className={`inline-flex rounded-md p-1.5 ${EYE_BUTTON_CLASS}`}
                              title={
                                ghostRevealActive
                                  ? profGroupGhostAllRevealed
                                    ? "החזר קבוצה למצב רוח"
                                    : "הצג חלקים רגילים"
                                  : groupH
                                    ? "הצג במודל"
                                    : "הסתר במודל"
                              }
                              aria-label="תצוגה"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (ghostRevealActive) toggleGhostRevealGroup(profPartIds);
                                else toggleProfileTabGroupKey(row.key);
                              }}
                            >
                              {ghostRevealActive ? (
                                profGroupGhostAllRevealed ? (
                                  <Eye className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                                ) : (
                                  <EyeOff className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                                )
                              ) : groupH ? (
                                <EyeOff className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                              ) : (
                                <Eye className={`h-4 w-4 ${EYE_ICON_CLASS}`} />
                              )}
                            </button>
                          </td>
                          <td className="p-2 font-medium text-zinc-900">{row.profileLabel}</td>
                          <td className="p-2 text-zinc-700">{formatQuantityInt(row.totalQty)}</td>
                          <td className="p-1 align-middle">
                            {canExpand ? (
                              <ChevronDown
                                className={cn(
                                  "mx-auto h-4 w-4 text-zinc-500 transition-transform",
                                  expanded ? "rotate-180" : "rotate-0",
                                )}
                                aria-hidden
                              />
                            ) : (
                              <span className="block h-4 w-4" aria-hidden />
                            )}
                          </td>
                        </tr>
                        {expanded && canExpand && (
                          <tr className="border-t border-zinc-200 bg-zinc-50/80">
                            <td colSpan={4} className="p-0">
                              <table className="w-full text-[11px]">
                                <thead className="text-[10px] text-zinc-500">
                                  <tr>
                                    <th className="w-11 p-1 text-center font-medium">תצוגה</th>
                                    <th className="p-2 pr-6 text-right font-medium">מספר חלק</th>
                                    <th className="p-2 text-right font-medium">כמות</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {row.instances.map((part) => {
                                    const parentHides = groupH;
                                    const partOnly = !parentHides && isPartHidden(part.id);
                                    const showOff = parentHides || partOnly;
                                    const ghostRev = ghostRevealedPartIds[part.id];
                                    const subLabel = displayPartMark(part);

                                    return (
                                      <tr key={part.id} className="border-t border-zinc-200">
                                        <td className="p-1 text-center">
                                          <button
                                            type="button"
                                            className={cn(
                                              "inline-flex rounded-md p-1.5",
                                              parentHides && !ghostRevealActive
                                                ? EYE_BUTTON_DISABLED_CLASS
                                                : EYE_BUTTON_CLASS,
                                            )}
                                            disabled={parentHides && !ghostRevealActive}
                                            title={
                                              ghostRevealActive
                                                ? ghostRev
                                                  ? "החזר למצב רוח"
                                                  : "הצג חלק רגיל"
                                                : parentHides
                                                  ? "הקבוצה מוסתרת"
                                                  : partOnly
                                                    ? "הצג במודל"
                                                    : "הסתר במודל"
                                            }
                                            aria-label="תצוגת חלק"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              if (ghostRevealActive) {
                                                toggleGhostRevealGroup([part.id]);
                                                return;
                                              }
                                              if (!parentHides) togglePartId(part.id);
                                            }}
                                          >
                                            {ghostRevealActive ? (
                                              ghostRev ? (
                                                <Eye className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                              ) : (
                                                <EyeOff className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                              )
                                            ) : showOff ? (
                                              <EyeOff className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                            ) : (
                                              <Eye className={`h-3.5 w-3.5 ${EYE_ICON_CLASS}`} />
                                            )}
                                          </button>
                                        </td>
                                        <td
                                          className="p-2 pr-6 font-medium text-zinc-800"
                                          title={part.id}
                                        >
                                          {subLabel}
                                        </td>
                                        <td className="p-2 text-zinc-600">
                                          {formatQuantityInt(steelPartEntityQtyContribution(part))}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </>
  );
}
