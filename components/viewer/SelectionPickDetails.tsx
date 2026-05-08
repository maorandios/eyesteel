"use client";

import { useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type {
  AnalyzerAssembly,
  AnalyzerBoltRow,
  AnalyzerIndexedEntity,
  AnalyzerPart,
} from "@/types/domain";
import {
  formatCount,
  formatElevationMm,
  formatKgPlain,
  formatMmPlain,
  formatQuantityInt,
} from "@/lib/format-numbers";
import { countAssemblyOccurrencesInModel } from "@/lib/viewer/modelAggregates";
import { isAnalyzerBoltRow } from "@/types/domain";

const EM_DASH = "—";

function looksLikeGeneratedIdTag(text: string): boolean {
  const s = text.trim();
  if (s.length < 24) return false;
  const core = s.toUpperCase().startsWith("ID") ? s.slice(2) : s;
  const compact = core.replace(/[-{}]/g, "");
  if (compact.length < 24) return false;
  return /^[0-9a-fA-F]+$/.test(compact);
}

/** Label shown in מספר חלק — prefers analyzer `partMark`, sane Tag, else express id */
export function displayPartMark(p: AnalyzerPart): string {
  const pm = p.partMark?.trim();
  if (pm) return pm;
  const tag = p.tag?.trim();
  if (tag && !looksLikeGeneratedIdTag(tag)) return tag;
  return p.expressId != null ? `#${formatCount(p.expressId)}` : EM_DASH;
}

/** Natural alphanumeric sort for מספר חלק (e.g. a1, a2, b12, b43, p6). */
export function comparePartMarksForSort(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/**
 * How many steel parts in the full model match this piece (same bucket as חלקים שייכים merge):
 * מספר חלק + פרופיל גולמי + שם חלק + משקל.
 */
export function countSteelPartsMatchingIdentity(
  selected: AnalyzerPart,
  allSteelParts: AnalyzerPart[],
): number {
  const mark = displayPartMark(selected);
  const profileKey = (selected.profile || "").trim().toLowerCase();
  const nameKey = (selected.name || "").trim().toLowerCase();
  const wKey =
    selected.weightKg != null && !Number.isNaN(selected.weightKg)
      ? selected.weightKg.toFixed(4)
      : "";

  let n = 0;
  for (const p of allSteelParts) {
    if (displayPartMark(p) !== mark) continue;
    if ((p.profile || "").trim().toLowerCase() !== profileKey) continue;
    if ((p.name || "").trim().toLowerCase() !== nameKey) continue;
    const pw = p.weightKg != null && !Number.isNaN(p.weightKg) ? p.weightKg.toFixed(4) : "";
    if (pw !== wKey) continue;
    n += 1;
  }
  return n;
}

/** שם חלק — ללא שם when missing or IFC "Unnamed". */
function displayPartIfcName(p: AnalyzerPart): string {
  const n = (p.name || "").trim();
  if (!n || n.toLowerCase() === "unnamed") return "ללא שם";
  return n;
}

/** Reject IFC floats mistaken for profile (0.0001, 3.6e-05) — match analyzer/_sanitize_profile_candidate. */
function looksLikeBogusIfcProfileString(raw: string): boolean {
  const s = raw.trim().replace(/,/g, ".").replace(/\u202f/g, "").replace(/\u00a0/g, "");
  if (!s) return true;
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s);
}

/** Profile shown in חלקים שייכים — Tekla profile string, or ללא שם when missing / Unnamed. */
function displayPartProfileCell(p: AnalyzerPart): string {
  const prof = (p.profile || "").trim();
  if (prof.length > 0 && !looksLikeBogusIfcProfileString(prof)) {
    const pl = prof.toLowerCase();
    if (pl !== "unnamed" && pl !== "n/a" && pl !== "-") {
      return prof;
    }
  }
  return "ללא שם";
}

function aggregateNonBoltParts(parts: AnalyzerPart[]): {
  key: string;
  displayMark: string;
  displayProfile: string;
  weightKg: number | null;
  /** Duplicate row count in this assembly */
  rowCount: number;
  /** IFC quantity sum when present, else rowCount */
  effectiveQty: number;
  instances: AnalyzerPart[];
}[] {
  const bucket = new Map<
    string,
    {
      displayMark: string;
      displayProfile: string;
      weightKg: number | null;
      instances: AnalyzerPart[];
    }
  >();

  for (const p of parts) {
    const displayMark = displayPartMark(p);
    const profileKey = (p.profile || "").trim().toLowerCase();
    const nameKey = (p.name || "").trim().toLowerCase();
    const wKey =
      p.weightKg != null && !Number.isNaN(p.weightKg) ? p.weightKg.toFixed(4) : "";
    const key = `${displayMark}|${profileKey}|${nameKey}|${wKey}`;
    const prev = bucket.get(key);
    if (prev) {
      prev.instances.push(p);
    } else {
      bucket.set(key, {
        displayMark,
        displayProfile: displayPartProfileCell(p),
        weightKg: p.weightKg,
        instances: [p],
      });
    }
  }

  return Array.from(bucket.entries()).map(([key, v]) => {
    const rowCount = v.instances.length;
    const first = v.instances[0];
    const ifcQty = first?.quantity;

    let effectiveQty: number;
    if (rowCount > 1) {
      effectiveQty = rowCount;
    } else if (ifcQty != null && !Number.isNaN(ifcQty)) {
      effectiveQty = Math.round(ifcQty);
    } else {
      effectiveQty = 1;
    }

    return {
      key,
      displayMark: v.displayMark,
      displayProfile: v.displayProfile,
      weightKg: v.weightKg,
      rowCount,
      effectiveQty,
      instances: v.instances,
    };
  });
}

/** טבלת חלקים במודל: מאחד שורות זהות (מספר חלק / פרופיל / שם / משקל), משקל = סכום; מיון עולה לפי מספר חלק. */
export function aggregateSteelPartsForModelTab(parts: AnalyzerPart[]): {
  key: string;
  displayMark: string;
  displayProfile: string;
  effectiveQty: number;
  totalWeightKg: number | null;
  instances: AnalyzerPart[];
}[] {
  const rows = aggregateNonBoltParts(parts).map((row) => {
    let sumKg = 0;
    let anyW = false;
    for (const p of row.instances) {
      if (p.weightKg != null && !Number.isNaN(p.weightKg)) {
        sumKg += p.weightKg;
        anyW = true;
      }
    }
    return {
      key: row.key,
      displayMark: row.displayMark,
      displayProfile: row.displayProfile,
      effectiveQty: row.effectiveQty,
      totalWeightKg: anyW ? sumKg : null,
      instances: row.instances,
    };
  });
  rows.sort((a, b) => comparePartMarksForSort(a.displayMark, b.displayMark));
  return rows;
}

function ifcSteelEntityQtyContribution(p: AnalyzerPart): number {
  const q = p.quantity;
  if (q != null && !Number.isNaN(q) && q > 0) return Math.round(q);
  return 1;
}

export type AggregatedProfileTabRow = {
  key: string;
  profileLabel: string;
  totalQty: number;
  totalWeightKg: number | null;
  instances: AnalyzerPart[];
};

/** טבלת פרופילים במודל: לפי שם פרופיל (כמו בעמודת פרופיל), כמות = סכום יחידות, משקל = סכום; מיון עולה. */
export function aggregateProfilesForModelTab(parts: AnalyzerPart[]): AggregatedProfileTabRow[] {
  const bucket = new Map<string, { profileLabel: string; instances: AnalyzerPart[] }>();

  for (const p of parts) {
    const profileLabel = displayPartProfileCell(p);
    const key = profileLabel.toLowerCase();
    const prev = bucket.get(key);
    if (prev) {
      prev.instances.push(p);
    } else {
      bucket.set(key, { profileLabel, instances: [p] });
    }
  }

  const rows = Array.from(bucket.entries()).map(([key, v]) => {
    let totalQty = 0;
    let sumKg = 0;
    let anyW = false;
    for (const p of v.instances) {
      totalQty += ifcSteelEntityQtyContribution(p);
      if (p.weightKg != null && !Number.isNaN(p.weightKg)) {
        sumKg += p.weightKg;
        anyW = true;
      }
    }
    return {
      key,
      profileLabel: v.profileLabel,
      totalQty,
      totalWeightKg: anyW ? sumKg : null,
      instances: v.instances,
    };
  });

  rows.sort((a, b) =>
    a.profileLabel.localeCompare(b.profileLabel, "en", { numeric: true, sensitivity: "base" }),
  );
  return rows;
}

/** IFC rows that share the same bolt type → one row; כמות = sum of boltQty (or 1 per row if missing). */
function aggregateBoltRows(bolts: AnalyzerBoltRow[]): {
  key: string;
  bolt: AnalyzerBoltRow;
  effectiveQty: number;
  sources: AnalyzerBoltRow[];
}[] {
  const bucket = new Map<
    string,
    {
      bolt: AnalyzerBoltRow;
      sources: AnalyzerBoltRow[];
    }
  >();

  for (const b of bolts) {
    const name = (b.boltName || b.name || "").trim().toLowerCase();
    const lenKey =
      b.boltLengthMm != null && !Number.isNaN(b.boltLengthMm) ? b.boltLengthMm.toFixed(4) : "";
    const std = (b.boltStandard || "").trim().toLowerCase();
    const diaKey =
      b.boltHoleDiameterMm != null && !Number.isNaN(b.boltHoleDiameterMm)
        ? b.boltHoleDiameterMm.toFixed(4)
        : "";
    const key = `${name}|${lenKey}|${std}|${diaKey}`;
    const prev = bucket.get(key);
    if (prev) {
      prev.sources.push(b);
    } else {
      bucket.set(key, { bolt: b, sources: [b] });
    }
  }

  return Array.from(bucket.entries()).map(([key, v]) => {
    const effectiveQty = v.sources.reduce((sum, row) => {
      const q = row.boltQty;
      if (q != null && !Number.isNaN(Number(q)) && Number(q) > 0) {
        return sum + Number(q);
      }
      return sum + 1;
    }, 0);
    return { key, bolt: v.bolt, effectiveQty, sources: v.sources };
  });
}

function KeyValueList({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: ReactNode }[];
}) {
  return (
    <section className="mb-1">
      <h3 className="mb-2 border-b border-zinc-700 pb-1.5 text-xs font-semibold text-zinc-300">
        {title}
      </h3>
      <dl className="divide-y divide-zinc-800/90 rounded-lg border border-zinc-800 bg-zinc-900/35">
        {rows.map(({ label, value }) => (
          <div key={label} className="flex gap-3 px-3 py-2.5 text-xs leading-snug">
            <dt className="min-w-[8.5rem] shrink-0 text-zinc-500">{label}</dt>
            <dd className="flex-1 text-right font-medium text-zinc-100">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function AssemblyPickDetailPanel({
  assembly,
  allAssemblies,
  onSelectPartInstances,
  onBackToList,
}: {
  assembly: AnalyzerAssembly;
  /** Full assembly list from analyzer — כמות במודל uses same grouping as טבלת הרכבות */
  allAssemblies?: AnalyzerAssembly[];
  onSelectPartInstances: (instances: AnalyzerPart[]) => void;
  onBackToList: () => void;
}) {
  const aggregatedBolts = useMemo(
    () => aggregateBoltRows(assembly.bolts ?? []),
    [assembly.bolts],
  );

  const aggregatedRows = useMemo(() => {
    const rows = aggregateNonBoltParts(assembly.parts);
    return [...rows].sort((r1, r2) =>
      comparePartMarksForSort(r1.displayMark, r2.displayMark),
    );
  }, [assembly.parts]);

  const occurrencesInModel = useMemo(() => {
    return allAssemblies?.length
      ? countAssemblyOccurrencesInModel(assembly, allAssemblies)
      : 1;
  }, [assembly, allAssemblies]);

  const partCountInAssembly = assembly.parts.length;

  const rows = [
    { label: "מספר אסמבלי", value: assembly.assemblyMark || EM_DASH },
    { label: "שם אסמבלי", value: assembly.name || assembly.tag || EM_DASH },
    {
      label: 'משקל כולל (ק״ג)',
      value: <span dir="ltr">{formatKgPlain(assembly.weightKg)}</span>,
    },
    { label: "גובה עליון", value: <span dir="ltr">{formatElevationMm(assembly.topElevation)}</span> },
    { label: "גובה תחתון", value: <span dir="ltr">{formatElevationMm(assembly.bottomElevation)}</span> },
    { label: "כמות במודל", value: formatCount(occurrencesInModel) },
  ];

  const assemblyTitle =
    assembly.assemblyMark ||
    assembly.name ||
    assembly.tag ||
    "הרכבה";

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] text-zinc-500">הרכבה נבחרה</p>
          <p className="text-sm font-semibold text-zinc-100">{assemblyTitle}</p>
        </div>
        <Button variant="secondary" className="h-8 shrink-0 px-3 text-xs" onClick={onBackToList}>
          חזרה לרשימה
        </Button>
      </div>

      <KeyValueList title="נתונים כלליים" rows={rows} />

      <section>
        <h3 className="mb-2 border-b border-zinc-700 pb-1.5 text-xs font-semibold text-zinc-300">
          חלקים שייכים · {formatCount(partCountInAssembly)}
        </h3>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900 text-[11px] text-zinc-400">
              <tr>
                <th className="px-2.5 py-2.5 text-right font-medium">מספר חלק</th>
                <th className="px-2.5 py-2.5 text-right font-medium">פרופיל</th>
                <th className="px-2.5 py-2.5 text-right font-medium">משקל (ק״ג)</th>
                <th className="px-2.5 py-2.5 text-right font-medium">כמות</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-950/40">
              {aggregatedRows.map((row) => (
                <tr
                  key={row.key}
                  className="cursor-pointer transition-colors hover:bg-zinc-800/80"
                  onClick={() => onSelectPartInstances(row.instances)}
                >
                  <td className="px-2.5 py-2.5 font-medium text-zinc-100">{row.displayMark}</td>
                  <td className="px-2.5 py-2.5 text-zinc-300">
                    {row.displayProfile === "ללא שם" ? (
                      row.displayProfile
                    ) : (
                      <span dir="ltr" className="inline-block text-right">
                        {row.displayProfile}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 text-zinc-300">
                    <span dir="ltr">{formatKgPlain(row.weightKg)}</span>
                  </td>
                  <td className="px-2.5 py-2.5 text-zinc-300">{formatQuantityInt(row.effectiveQty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          חלקים זהים (מספר חלק / פרופיל / משקל) בשורה אחת; כמות = כפילויות או Quantity מהמודל כשיש פריט
          יחיד
        </p>
      </section>

      <section>
        <h3 className="mb-2 border-b border-zinc-700 pb-1.5 text-xs font-semibold text-zinc-300">
          ברגים
        </h3>
        {aggregatedBolts.length === 0 ? (
          <p className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-4 text-center text-[11px] text-zinc-500">
            לא זוהו ברגים תחת הרכבה זו (כולל קבוצות מקוננות)
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[20rem] text-xs">
              <thead className="bg-zinc-900 text-[11px] text-zinc-400">
                <tr>
                  <th className="px-2 py-2 text-right font-medium">שם הבורג</th>
                  <th className="px-2 py-2 text-right font-medium">אורך (מ״מ)</th>
                  <th className="px-2 py-2 text-right font-medium">תקן</th>
                  <th className="px-2 py-2 text-right font-medium">קוטר חור (מ״מ)</th>
                  <th className="px-2 py-2 text-right font-medium">כמות</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 bg-zinc-950/40">
                {aggregatedBolts.map(({ key, bolt: b, effectiveQty }) => (
                  <tr key={key}>
                    <td className="px-2 py-2 font-medium text-zinc-100">
                      {b.boltName || b.name || EM_DASH}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-zinc-300">
                      <span dir="ltr">{formatMmPlain(b.boltLengthMm)}</span>
                    </td>
                    <td className="px-2 py-2 text-zinc-300">{b.boltStandard || EM_DASH}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-zinc-300">
                      <span dir="ltr">{formatMmPlain(b.boltHoleDiameterMm)}</span>
                    </td>
                    <td className="px-2 py-2 text-zinc-300">{formatQuantityInt(effectiveQty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {aggregatedBolts.length > 0 && (
          <p className="mt-2 text-[11px] text-zinc-500">
            ברגים בעלי שם / אורך / תקן / קוטר חור זהים מוצגים בשורה אחת; כמות = סכום כמויות מהמודל
          </p>
        )}
      </section>
    </div>
  );
}

/** Drill-down from פרופילים tab — one row per IFC steel part (no merge). */
export function ProfileGroupPickDetailPanel({
  profileLabel,
  instances,
  onBackToList,
  onPickPart,
}: {
  profileLabel: string;
  instances: AnalyzerPart[];
  onBackToList: () => void;
  onPickPart: (part: AnalyzerPart) => void;
}) {
  const sorted = useMemo(
    () =>
      [...instances].sort((a, b) =>
        comparePartMarksForSort(displayPartMark(a), displayPartMark(b)),
      ),
    [instances],
  );

  const titleProfile =
    profileLabel === "ללא שם" ? (
      profileLabel
    ) : (
      <span dir="ltr" className="inline-block">
        {profileLabel}
      </span>
    );

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] text-zinc-500">פרופיל נבחר</p>
          <p className="text-sm font-semibold text-zinc-100">{titleProfile}</p>
          <p className="mt-0.5 text-[11px] text-zinc-500">{formatCount(sorted.length)} חלקים במודל</p>
        </div>
        <Button variant="secondary" className="h-8 shrink-0 px-3 text-xs" onClick={onBackToList}>
          חזרה לרשימה
        </Button>
      </div>

      <section>
        <h3 className="mb-2 border-b border-zinc-700 pb-1.5 text-xs font-semibold text-zinc-300">
          חלקים
        </h3>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900 text-[11px] text-zinc-400">
              <tr>
                <th className="px-2.5 py-2.5 text-right font-medium">מספר חלק</th>
                <th className="px-2.5 py-2.5 text-right font-medium">שם הפרופיל</th>
                <th className="px-2.5 py-2.5 text-right font-medium">משקל (ק״ג)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-950/40">
              {sorted.map((p) => {
                const prof = displayPartProfileCell(p);
                return (
                  <tr
                    key={p.id}
                    className="cursor-pointer transition-colors hover:bg-zinc-800/80"
                    onClick={() => onPickPart(p)}
                  >
                    <td className="px-2.5 py-2.5 font-medium text-zinc-100">{displayPartMark(p)}</td>
                    <td className="px-2.5 py-2.5 text-zinc-300">
                      {prof === "ללא שם" ? (
                        prof
                      ) : (
                        <span dir="ltr" className="inline-block text-right">
                          {prof}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-2.5 text-zinc-300">
                      <span dir="ltr">{formatKgPlain(p.weightKg)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function PartPickDetailPanel({
  entity,
  allSteelParts,
  onBackToList,
}: {
  entity: AnalyzerIndexedEntity;
  /** All non-bolt parts from analyzer output — used for model-wide כמות count */
  allSteelParts?: AnalyzerPart[];
  onBackToList: () => void;
}) {
  if (isAnalyzerBoltRow(entity)) {
    const b = entity;
    const title = b.boltName || b.name || "בורג";
    const rows = [
      { label: "שם הבורג", value: b.boltName || b.name || EM_DASH },
      { label: "אורך (מ״מ)", value: <span dir="ltr">{formatMmPlain(b.boltLengthMm)}</span> },
      { label: "תקן", value: b.boltStandard || EM_DASH },
      { label: "קוטר חור (מ״מ)", value: <span dir="ltr">{formatMmPlain(b.boltHoleDiameterMm)}</span> },
      { label: "כמות (ישות IFC)", value: formatQuantityInt(b.boltQty) },
      { label: "סוג IFC", value: b.ifcType || EM_DASH },
    ];
    return (
      <div className="space-y-5" dir="rtl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[11px] text-zinc-500">בורג נבחר</p>
            <p className="text-sm font-semibold text-zinc-100">{title}</p>
          </div>
          <Button variant="secondary" className="h-8 shrink-0 px-3 text-xs" onClick={onBackToList}>
            חזרה לרשימה
          </Button>
        </div>
        <KeyValueList title="נתוני בורג" rows={rows} />
      </div>
    );
  }

  const part = entity as AnalyzerPart;
  const title = displayPartMark(part);
  const profileEl =
    displayPartProfileCell(part) === "ללא שם" ? (
      "ללא שם"
    ) : (
      <span dir="ltr">{displayPartProfileCell(part)}</span>
    );

  const modelCount =
    allSteelParts && allSteelParts.length > 0 ? countSteelPartsMatchingIdentity(part, allSteelParts) : null;

  const generalRows = [
    { label: "מספר חלק", value: displayPartMark(part) },
    { label: "פרופיל", value: profileEl },
    { label: "שם חלק", value: displayPartIfcName(part) },
    { label: "חומר", value: part.material || EM_DASH },
    {
      label: "כמות",
      value: modelCount != null ? formatCount(modelCount) : EM_DASH,
    },
    {
      label: "גובה עליון",
      value: <span dir="ltr">{formatElevationMm(part.topElevation ?? null)}</span>,
    },
    {
      label: "גובה תחתון",
      value: <span dir="ltr">{formatElevationMm(part.bottomElevation ?? null)}</span>,
    },
  ];

  const technicalRows = [
    { label: 'משקל (ק״ג)', value: <span dir="ltr">{formatKgPlain(part.weightKg)}</span> },
    {
      label: "אורך (מ״מ)",
      value: <span dir="ltr">{formatMmPlain(part.lengthMm)}</span>,
    },
    {
      label: "גובה (מ״מ)",
      value: <span dir="ltr">{formatMmPlain(part.yDim)}</span>,
    },
    {
      label: "רוחב (מ״מ)",
      value: <span dir="ltr">{formatMmPlain(part.xDim)}</span>,
    },
    ...(part.wallThicknessMm != null &&
    !Number.isNaN(part.wallThicknessMm) &&
    Math.abs(part.wallThicknessMm) > 1e-9
      ? [
          {
            label: "עובי דופן (מ״מ)",
            value: <span dir="ltr">{formatMmPlain(part.wallThicknessMm)}</span>,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] text-zinc-500">חלק נבחר</p>
          <p className="text-sm font-semibold text-zinc-100">{title}</p>
        </div>
        <Button variant="secondary" className="h-8 shrink-0 px-3 text-xs" onClick={onBackToList}>
          חזרה לרשימה
        </Button>
      </div>

      <KeyValueList title="נתונים כלליים" rows={generalRows} />
      <p className="mt-2 text-[11px] leading-snug text-zinc-500">
        כמות = מספר פריטים זהים במודל כולו (מספר חלק, פרופיל, שם חלק ומשקל)
      </p>

      <KeyValueList title="נתונים טכניים" rows={technicalRows} />
    </div>
  );
}
