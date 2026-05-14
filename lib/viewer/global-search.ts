import type {
  AnalyzerAssembly,
  AnalyzerBoltRow,
  AnalyzerIndexedEntity,
  AnalyzerPart,
} from "@/types/domain";
import { isAnalyzerBoltRow } from "@/types/domain";
import type { AggregatedProfileTabRow } from "@/components/viewer/SelectionPickDetails";
import { displayPartMark } from "@/components/viewer/SelectionPickDetails";

/** Lets "heb280" match "HEB 280" / "HEB-280" in profile search. */
function compactAlnum(s: string): string {
  return s.replace(/[\s\-_.]/g, "").toLowerCase();
}

export type GlobalSearchHit =
  | { kind: "assembly"; assembly: AnalyzerAssembly; rank: number }
  | { kind: "part"; part: AnalyzerIndexedEntity; rank: number }
  | { kind: "profile"; row: AggregatedProfileTabRow; rank: number };

export type GlobalSearchIntent = "profile-heavy" | "mark-heavy" | "neutral";

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Only labels the user sees in the picker — excludes IFC/GUID IDs that contain casual substrings like "c2". */
function assemblyTitleFields(a: AnalyzerAssembly): string[] {
  const bits: string[] = [];
  if (a.assemblyMark?.trim()) bits.push(a.assemblyMark.trim());
  if (a.positionCode?.trim()) bits.push(a.positionCode.trim());
  if (a.name?.trim()) bits.push(a.name.trim());
  if (a.tag?.trim()) bits.push(a.tag.trim());
  if (a.expressId != null) {
    bits.push(`#${a.expressId}`);
    bits.push(String(a.expressId));
  }
  return bits;
}

function boltTitleFields(row: AnalyzerBoltRow): string[] {
  const bits: string[] = [];
  if (row.boltName?.trim()) bits.push(row.boltName.trim());
  if (row.name?.trim()) bits.push(row.name.trim());
  if (row.tag?.trim()) bits.push(row.tag.trim());
  if (row.expressId != null) {
    bits.push(`#${row.expressId}`);
    bits.push(String(row.expressId));
  }
  return bits;
}

function steelPartTitleFields(bp: AnalyzerPart): string[] {
  const bits: string[] = [];
  const mark = displayPartMark(bp);
  if (mark.trim()) bits.push(mark.trim());
  if (bp.partMark?.trim()) bits.push(bp.partMark.trim());
  if (bp.name?.trim()) bits.push(bp.name.trim());
  if (bp.tag?.trim()) bits.push(bp.tag.trim());
  if (bp.expressId != null) {
    bits.push(`#${bp.expressId}`);
    bits.push(String(bp.expressId));
  }
  return bits;
}

function steelPartProfileMaterialFields(bp: AnalyzerPart): string[] {
  const bits: string[] = [];
  if (bp.profile?.trim()) bits.push(bp.profile.trim());
  if (bp.material?.trim()) bits.push(bp.material.trim());
  return bits;
}

/**
 * Match only as a real title token: exact, prefix, or substring after a non‑alphanumeric boundary.
 * Stops "c2" from matching "PLC2" (no boundary) or random "c2" inside a GUID.
 */
function matchRankTitleField(fieldNorm: string, qNorm: string): number {
  if (!fieldNorm || !qNorm) return -1;
  if (fieldNorm === qNorm) return 0;
  if (fieldNorm.startsWith(qNorm)) return 0.01;
  const esc = qNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z0-9])${esc}`, "i");
  const m = fieldNorm.match(re);
  if (!m || m.index === undefined) return -1;
  return 1 + m.index / 10_000;
}

function bestTitleFieldRank(fields: string[], qNorm: string): number {
  let best = -1;
  for (const raw of fields) {
    const fn = normalizeQuery(raw);
    const r = matchRankTitleField(fn, qNorm);
    if (r >= 0 && (best < 0 || r < best)) best = r;
  }
  return best;
}

function assemblySearchRank(a: AnalyzerAssembly, qNorm: string): number {
  return bestTitleFieldRank(assemblyTitleFields(a), qNorm);
}

function boltSearchRank(row: AnalyzerBoltRow, qNorm: string): number {
  return bestTitleFieldRank(boltTitleFields(row), qNorm);
}

function steelPartSearchRank(bp: AnalyzerPart, qNorm: string, intent: GlobalSearchIntent): number {
  const titles = steelPartTitleFields(bp);
  const titleRank = bestTitleFieldRank(titles, qNorm);
  if (intent === "profile-heavy") {
    const sec = steelPartProfileMaterialFields(bp);
    if (sec.length === 0) return titleRank;
    const blob = normalizeQuery([...titles, ...sec].join(" "));
    const profR = matchRankProfileLike(blob, qNorm);
    if (titleRank < 0) return profR;
    if (profR < 0) return titleRank;
    return Math.min(titleRank, profR);
  }
  return titleRank;
}

/** Lower rank = better match. Returns -1 if no match. */
function matchRank(haystack: string, q: string): number {
  if (!q) return -1;
  if (!haystack) return -1;
  if (haystack.startsWith(q)) return 0;
  const idx = haystack.indexOf(q);
  if (idx === -1) return -1;
  return 1 + idx / 10_000;
}

/**
 * Profile / section-type queries: try normalized text, then compact (no spaces/dashes)
 * so Tekla "HEB 280" matches user "HEB280".
 */
function matchRankProfileLike(haystack: string, q: string): number {
  const r = matchRank(haystack, q);
  if (r >= 0) return r;
  const cq = compactAlnum(q);
  if (cq.length < 2) return -1;
  const ch = compactAlnum(haystack);
  return matchRank(ch, cq);
}

function profileRowHaystack(row: AggregatedProfileTabRow): string {
  const bits: string[] = [row.profileLabel];
  for (const p of row.instances) {
    const raw = (p.profile || "").trim();
    if (raw) bits.push(raw);
  }
  return normalizeQuery([...new Set(bits)].join(" "));
}

const MAX_ASSEMBLY = 22;
const MAX_PROFILE = 14;

/**
 * Queries that look like European / catalog section names → show פרופילים first (e.g. HEB240, IPE330).
 * Tested on compact alphanumeric form (spaces/dashes removed).
 */
function isProfileHeavyQuery(raw: string): boolean {
  const qc = compactAlnum(raw);
  if (qc.length < 3) return false;
  // Known section families first; `\d|$|[ x×*`]` allows "heb240", "RHS", starting RHS200…
  const familial =
    /^(hea|heb|hem|ipea|ipeo|ipe|ipn|inp|upe|upa|upn|rhs|chs|shs|pfc|uka|ukb|uko|tub|ucs|ubo|ukpfc|hp|hd|hl|mtd|mtdp|mtdv|cold|welded)(\d|$|[x×*])/i;
  if (familial.test(qc)) return true;
  /* Universal columns / beams UC305 / UB533 — digits must follow prefix to beat generic "c41" assembly marks */
  const universal = /^(ub|uc)(\d+)/i.test(qc);
  if (universal) return true;
  /** Angle / RHS-style "L120x..." after compact loses × sometimes as x */
  const angleLike =
    qc.startsWith("l") && qc.length >= 4 && /\d/.test(qc) && (/[x×*]/i.test(raw) || /^l\d+x/i.test(qc));
  return angleLike;
}

/**
 * Queries that resemble Tekla assembly/part marks → הרכבות first (e.g. C41), but not catalog profiles.
 */
function isMarkHeavyQuery(raw: string): boolean {
  if (isProfileHeavyQuery(raw)) return false;
  /* Sentence / phrase search stays neutral ordering (לא מסוג מספר חלק/הרכבה). */
  if (/\s/.test(raw)) return false;
  const qc = compactAlnum(raw);
  if (qc.length < 2 || qc.length > 24) return false;
  if (!/\d/.test(qc) || !/[a-z]/i.test(qc)) return false;
  if (!/^[a-z0-9]+$/i.test(qc)) return false;
  return true;
}

/** Choose section order + optional hint for accessibility. */
export function inferGlobalSearchIntent(rawQuery: string): GlobalSearchIntent {
  const trimmed = rawQuery.trim();
  if (!trimmed) return "neutral";
  if (isProfileHeavyQuery(trimmed)) return "profile-heavy";
  if (isMarkHeavyQuery(trimmed)) return "mark-heavy";
  return "neutral";
}

export function computeGlobalSearchHits(
  assemblies: AnalyzerAssembly[],
  indexedParts: AnalyzerIndexedEntity[],
  profileRows: AggregatedProfileTabRow[],
  rawQuery: string,
): GlobalSearchHit[] {
  const q = normalizeQuery(rawQuery);
  if (!q) return [];

  const intent = inferGlobalSearchIntent(rawQuery);

  const assemblyHits: Extract<GlobalSearchHit, { kind: "assembly" }>[] = [];
  for (const assembly of assemblies) {
    const r = assemblySearchRank(assembly, q);
    if (r < 0) continue;
    assemblyHits.push({ kind: "assembly", assembly, rank: r });
  }
  assemblyHits.sort((a, b) => a.rank - b.rank || a.assembly.id.localeCompare(b.assembly.id));
  const assemblySlice: GlobalSearchHit[] = assemblyHits.slice(0, MAX_ASSEMBLY);

  const partHits: Extract<GlobalSearchHit, { kind: "part" }>[] = [];
  const boltHits: Extract<GlobalSearchHit, { kind: "part" }>[] = [];
  for (const part of indexedParts) {
    const isBolt = isAnalyzerBoltRow(part);
    const r = isBolt ? boltSearchRank(part, q) : steelPartSearchRank(part, q, intent);
    if (r < 0) continue;
    if (isBolt) boltHits.push({ kind: "part", part, rank: r });
    else partHits.push({ kind: "part", part, rank: r });
  }
  partHits.sort((a, b) => a.rank - b.rank || a.part.id.localeCompare(b.part.id));
  boltHits.sort((a, b) => a.rank - b.rank || a.part.id.localeCompare(b.part.id));

  const profileHits: Extract<GlobalSearchHit, { kind: "profile" }>[] = [];
  for (const row of profileRows) {
    const blob = profileRowHaystack(row);
    const r = matchRankProfileLike(blob, q);
    if (r < 0) continue;
    profileHits.push({ kind: "profile", row, rank: r });
  }
  profileHits.sort((a, b) => a.rank - b.rank || a.row.key.localeCompare(b.row.key));
  const profileSlice: GlobalSearchHit[] = profileHits.slice(0, MAX_PROFILE);

  // Keep categories separate: a global cap was dropping פרופיל rows when many חלקים matched the same type (e.g. HEB280).
  // Parts and bolts are intentionally returned uncapped here because the search overlay merges raw entities
  // into visible type rows; capping first would hide valid duplicate members from the merged result.
  return [...assemblySlice, ...partHits, ...boltHits, ...profileSlice];
}
