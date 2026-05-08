/**
 * IFC GlobalId strings vary (UUID vs compressed STEP form). Normalize for comparisons
 * between ThatOpen fragments and the Python analyzer (`id` = entity GlobalId).
 */
export function normalizeIfcGuidKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.trim().toUpperCase().replace(/-/g, "").replace(/\s+/g, "");
  return u || null;
}

export function analyzerEntityMatchesPick(
  e: { id: string; expressId: number | null },
  localIds: readonly number[],
  pickGuids: readonly string[],
  /** Built after sync: normalized GlobalId key → ThatOpen local id from getLocalIdsByGuids. */
  analyzerGuidKeyToFragmentLocal?: ReadonlyMap<string, number> | null,
): boolean {
  if (e.expressId != null && localIds.includes(e.expressId)) return true;
  const want = normalizeIfcGuidKey(e.id);
  if (!want) return false;
  for (const g of pickGuids) {
    if (normalizeIfcGuidKey(g) === want) return true;
  }
  const mapped = analyzerGuidKeyToFragmentLocal?.get(want);
  if (mapped != null && localIds.includes(mapped)) return true;
  return false;
}

export type AnalyzerHighlightRef = { id: string; expressId: number | null };

export function analyzerRefsFromAssembly(assembly: {
  parts: AnalyzerHighlightRef[];
  bolts?: AnalyzerHighlightRef[] | undefined;
}): AnalyzerHighlightRef[] {
  return [
    ...assembly.parts.map((p) => ({ id: p.id, expressId: p.expressId })),
    ...(assembly.bolts ?? []).map((b) => ({ id: b.id, expressId: b.expressId })),
  ];
}
