import type { AnalyzerAssembly, AnalyzerBoltRow } from "@/types/domain";

/**
 * IFC GlobalId strings vary (UUID vs compressed STEP form). Normalize for comparisons
 * between ThatOpen fragments and the Python analyzer (`id` = entity GlobalId).
 */
export function normalizeIfcGuidKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u = raw.trim().toUpperCase().replace(/-/g, "").replace(/\s+/g, "");
  if (u.startsWith("{") && u.endsWith("}")) u = u.slice(1, -1);
  return u || null;
}

/**
 * Spellings to try with {@link FragmentsModel#getLocalIdsByGuids} when the analyzer string
 * does not match the fragment worker’s preferred encoding (dashed vs compact UUID, braces, etc.).
 */
export function expandIfcGuidLookupVariants(raw: string): string[] {
  const t = raw.trim();
  if (!t) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const x = s.trim();
    if (!x || seen.has(x)) return;
    seen.add(x);
    out.push(x);
  };
  add(t);
  let inner = t;
  if (inner.startsWith("{") && inner.endsWith("}")) {
    inner = inner.slice(1, -1).trim();
    add(inner);
  }
  const n = normalizeIfcGuidKey(t);
  if (n && n.length === 32 && /^[0-9A-F]+$/.test(n)) {
    const dashed = `${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20, 32)}`;
    add(dashed);
    add(`{${dashed}}`);
    add(n);
  }
  return out;
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

/**
 * Steel parts only — מצב ייצור isolation seeds. {@link analyzerRefsFromAssembly} also lists
 * `assembly.bolts`, which can preload unrelated catalog bolts into the visible set.
 */
export function analyzerSteelPartRefsFromAssembly(assembly: {
  parts: AnalyzerHighlightRef[];
}): AnalyzerHighlightRef[] {
  return assembly.parts.map((p) => ({ id: p.id, expressId: p.expressId }));
}

function partGuidsMatch(a: string, b: string): boolean {
  const ka = normalizeIfcGuidKey(a);
  const kb = normalizeIfcGuidKey(b);
  if (ka && kb && ka === kb) return true;
  return a.trim() === b.trim();
}

/** Deduplicate refs for the same IFC GlobalId (varies by encoding). */
export function dedupeAnalyzerHighlightRefs(refs: AnalyzerHighlightRef[]): AnalyzerHighlightRef[] {
  const out: AnalyzerHighlightRef[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const k = normalizeIfcGuidKey(r.id) ?? r.id.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * Normalized IFC keys for bolts IFC links to this part (not the whole assembly's bolt list).
 */
export function normalizedBoltSteelGuidsForPart(
  partId: string,
  boltSteelLinks: readonly { boltGlobalId: string; partGlobalId: string }[] | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const row of boltSteelLinks ?? []) {
    if (!partGuidsMatch(row.partGlobalId, partId)) continue;
    const bk = normalizeIfcGuidKey(row.boltGlobalId) ?? row.boltGlobalId.trim();
    if (bk) out.add(bk);
  }
  return out;
}

/**
 * Bolts whose hole overlays should appear in מצב ייצור for the given visible steel subset.
 *
 * Unions (non‑exclusive): `boltSteelLinks` hits **including bolt-hyperedge expansion** (so a joint
 * bolt listed only on the “main” part still appears when isolating the **secondary** connected
 * member), bolts listed on {@link AnalyzerAssembly} rows that share any visible part, and bolts
 * whose GlobalId appears in `productionAnalyzerRefs`.
 */
export function analyzerBoltsForProductionHoleOverlay(
  visibleSteelPartIds: readonly string[],
  assemblies: readonly AnalyzerAssembly[],
  boltSteelLinks: readonly { boltGlobalId: string; partGlobalId: string }[] | undefined,
  allBoltRows: readonly AnalyzerBoltRow[],
  productionAnalyzerRefs?: readonly { id: string }[],
): AnalyzerBoltRow[] {
  const byKey = new Map<string, AnalyzerBoltRow>();
  const take = (keys: Set<string>) => {
    for (const b of allBoltRows) {
      const bk = normalizeIfcGuidKey(b.id) ?? b.id.trim();
      if (bk && keys.has(bk)) byKey.set(bk, b);
    }
  };

  /** Hypergraph reach plus every row that names a visible steel part directly (covers “secondary” IFC spellings). */
  const linkKeys = new Set<string>();
  for (const v of visibleSteelPartIds) {
    for (const bk of normalizedBoltSteelGuidsForPart(v, boltSteelLinks)) {
      linkKeys.add(bk);
    }
  }
  for (const v of visibleSteelPartIds) {
    for (const bk of normalizedBoltSteelGuidsForBoltLinkReach(v, assemblies, boltSteelLinks)) {
      linkKeys.add(bk);
    }
  }
  take(linkKeys);

  const asmKeys = new Set<string>();
  for (const asm of assemblies) {
    if (!asm.parts.some((p) => visibleSteelPartIds.some((v) => partGuidsMatch(p.id, v)))) continue;
    for (const b of asm.bolts ?? []) {
      const bk = normalizeIfcGuidKey(b.id) ?? b.id.trim();
      if (bk) asmKeys.add(bk);
    }
  }
  take(asmKeys);

  if (productionAnalyzerRefs?.length) {
    const refKeys = new Set(
      productionAnalyzerRefs
        .map((r) => normalizeIfcGuidKey(r.id))
        .filter((k): k is string => !!k),
    );
    take(refKeys);
  }

  return [...byKey.values()];
}

/** All steel part IFC GlobalIds sitting in assemblies that contain `partId`. */
export function steelPartGuidsSharingAssembliesWith(
  partId: string,
  assemblies: readonly { parts: { id: string }[] }[],
): readonly string[] {
  const matching = assemblies.filter((asm) =>
    asm.parts.some((p) => partGuidsMatch(p.id, partId)),
  );
  if (matching.length === 0) return [partId];
  const out = new Set<string>();
  for (const asm of matching) {
    for (const p of asm.parts) out.add(p.id.trim());
  }
  return [...out];
}

function normalizedPartSteelKey(partGlobalId: string): string {
  return normalizeIfcGuidKey(partGlobalId) ?? partGlobalId.trim();
}

/**
 * IFC link graph: propagate “same joint” membership along **bolt hyperedges**.
 * Any row `(bolt → part)` bundles those parts onto one bolt; repeated expansion pulls in chains
 * e.g. `bolt₁ → {beam,plate}` then `bolt₂ → {plate,bracket}` so **bracket isolation** includes `bolt₁`
 * rows that only mentioned **beam**.
 */
export function steelPartKeysReachableViaBoltLinkGraph(
  partId: string,
  assemblies: readonly { parts: { id: string }[] }[],
  boltSteelLinks: readonly { boltGlobalId: string; partGlobalId: string }[] | undefined,
): ReadonlySet<string> {
  const reach = new Set<string>();
  const addReach = (id: string) => reach.add(normalizedPartSteelKey(id));
  addReach(partId);
  for (const m of steelPartGuidsSharingAssembliesWith(partId, assemblies)) {
    addReach(m);
  }

  const boltToParts = new Map<string, Set<string>>();
  for (const row of boltSteelLinks ?? []) {
    const bk = normalizeIfcGuidKey(row.boltGlobalId) ?? row.boltGlobalId.trim();
    if (!bk) continue;
    let ps = boltToParts.get(bk);
    if (!ps) {
      ps = new Set<string>();
      boltToParts.set(bk, ps);
    }
    ps.add(normalizedPartSteelKey(row.partGlobalId));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const partSet of boltToParts.values()) {
      let touchesReach = false;
      for (const pk of partSet) {
        if (reach.has(pk)) {
          touchesReach = true;
          break;
        }
      }
      if (!touchesReach) continue;
      for (const pk of partSet) {
        if (!reach.has(pk)) {
          reach.add(pk);
          changed = true;
        }
      }
    }
  }

  return reach;
}

/**
 * Bolt GUID keys from rows whose linked steel is in {@link steelPartKeysReachableViaBoltLinkGraph}.
 */
export function normalizedBoltSteelGuidsForBoltLinkReach(
  partId: string,
  assemblies: readonly { parts: { id: string }[] }[],
  boltSteelLinks: readonly { boltGlobalId: string; partGlobalId: string }[] | undefined,
): Set<string> {
  const reach = steelPartKeysReachableViaBoltLinkGraph(partId, assemblies, boltSteelLinks);
  const out = new Set<string>();
  for (const row of boltSteelLinks ?? []) {
    if (!reach.has(normalizedPartSteelKey(row.partGlobalId))) continue;
    const bk = normalizeIfcGuidKey(row.boltGlobalId) ?? row.boltGlobalId.trim();
    if (bk) out.add(bk);
  }
  return out;
}

/** Preserve exporter GlobalId spelling for {@link FragmentsModel.getLocalIdsByGuids}. */
export function boltGlobalIdsRawForBoltLinkReach(
  partId: string,
  assemblies: readonly { parts: { id: string }[] }[],
  boltSteelLinks: readonly { boltGlobalId: string; partGlobalId: string }[] | undefined,
): string[] {
  const reach = steelPartKeysReachableViaBoltLinkGraph(partId, assemblies, boltSteelLinks);
  const seenNorm = new Set<string>();
  const out: string[] = [];
  for (const row of boltSteelLinks ?? []) {
    if (!reach.has(normalizedPartSteelKey(row.partGlobalId))) continue;
    const raw = row.boltGlobalId.trim();
    if (!raw) continue;
    const nk = normalizeIfcGuidKey(raw) ?? raw;
    if (seenNorm.has(nk)) continue;
    seenNorm.add(nk);
    out.push(raw);
  }
  return out;
}

/**
 * Bolt GUID keys whose `boltSteelLinks` rows reference **any co-assembly mate** (including self).
 * Narrower than {@link normalizedBoltSteelGuidsForBoltLinkReach}.
 */
export function normalizedBoltSteelGuidsForJointNeighborhood(
  partId: string,
  assemblies: readonly { parts: { id: string }[] }[],
  boltSteelLinks: readonly { boltGlobalId: string; partGlobalId: string }[] | undefined,
): Set<string> {
  const mates = steelPartGuidsSharingAssembliesWith(partId, assemblies);
  const out = new Set<string>();
  for (const row of boltSteelLinks ?? []) {
    if (!mates.some((m) => partGuidsMatch(m, row.partGlobalId))) continue;
    const bk = normalizeIfcGuidKey(row.boltGlobalId) ?? row.boltGlobalId.trim();
    if (bk) out.add(bk);
  }
  return out;
}

/** Bolts listed on `IfcElementAssembly` rows that contain this part (analyzer index). */
export function normalizedBoltGuidsFromContainingAssemblies(
  partId: string,
  assemblies: Iterable<{
    parts: { id: string }[];
    bolts?: { id: string; expressId: number | null }[] | undefined;
  }>,
): Set<string> {
  const out = new Set<string>();
  for (const asm of assemblies) {
    const inAsm = asm.parts.some((p) => partGuidsMatch(p.id, partId));
    if (!inAsm) continue;
    for (const b of asm.bolts ?? []) {
      const bk = normalizeIfcGuidKey(b.id) ?? b.id.trim();
      if (bk) out.add(bk);
    }
  }
  return out;
}

export type PartIsolationBoltPolicy = {
  /**
   * Isolation seeds: steel member only (`[part]`). Fasteners never appear here as preload seeds —
   * optional assembly bolt GUID pools only gate which IFC fasteners the engine may merge from those seeds.
   */
  refs: AnalyzerHighlightRef[];
  /**
   * Normalized bolt GlobalIds the analyzer tied to this part via `IfcRelConnects*` (`boltSteelLinks`),
   * including hypergraph reach for multi-piece joints. When non-empty, the viewer treats isolation
   * hardware as **relation-backed** (no spatial assembly flood).
   */
  boltGuidIsolationAllowlist?: ReadonlySet<string>;
  /**
   * Legacy / non-link models: optional spatial pool; omitted when using relation-only isolation.
   */
  spatialBoltIsolationAllowlist?: ReadonlySet<string>;
  /**
   * True when `boltSteelLinks` drives {@link boltGuidIsolationAllowlist} (IFC-explicit bolt↔steel).
   */
  useIfcBoltSteelRelationIsolation: boolean;
  /**
   * Original `boltGlobalId` strings from matching link rows — used to resolve fragments when the
   * normalized key alone does not satisfy `getLocalIdsByGuids`.
   */
  relationBoltGlobalIdsRaw?: readonly string[];
};

/**
 * Part isolation seeds = `{ part }`.
 *
 * When **`boltSteelLinks` exists:** allowlist = {@link normalizedBoltSteelGuidsForBoltLinkReach} only
 * (IfcRelConnects* provenance). No assembly-wide bolt index or catalog union — that caused unrelated
 * assembly hardware. Spatial merge is skipped by the engine in this mode.
 *
 * When **no link table:** fall back to assembly `bolts[]` and enable spatial pool for bbox recovery.
 */
export function resolvePartIsolationBoltPolicy(
  part: { id: string; expressId: number | null },
  assemblies: readonly {
    parts: { id: string }[];
    bolts?: { id: string; expressId: number | null }[] | undefined;
  }[],
  boltSteelLinks: readonly { boltGlobalId: string; partGlobalId: string }[] | undefined,
): PartIsolationBoltPolicy {
  const fromAsm = normalizedBoltGuidsFromContainingAssemblies(part.id, assemblies);
  const fromLinkReach = normalizedBoltSteelGuidsForBoltLinkReach(
    part.id,
    assemblies,
    boltSteelLinks,
  );
  const hasLinkTable = Array.isArray(boltSteelLinks) && boltSteelLinks.length > 0;

  let boltGuidIsolationAllowlist: ReadonlySet<string> | undefined;
  let spatialBoltIsolationAllowlist: ReadonlySet<string> | undefined;
  let useIfcBoltSteelRelationIsolation = false;
  let relationBoltGlobalIdsRaw: string[] | undefined;

  if (hasLinkTable) {
    useIfcBoltSteelRelationIsolation = true;
    if (fromLinkReach.size > 0) {
      boltGuidIsolationAllowlist = fromLinkReach;
      relationBoltGlobalIdsRaw = boltGlobalIdsRawForBoltLinkReach(
        part.id,
        assemblies,
        boltSteelLinks,
      );
    } else if (fromAsm.size > 0) {
      /** Link table present but no rows reached this part — keep assembly index only. */
      useIfcBoltSteelRelationIsolation = false;
      boltGuidIsolationAllowlist = fromAsm;
      spatialBoltIsolationAllowlist = new Set<string>(fromAsm);
    }
  } else if (fromAsm.size > 0) {
    boltGuidIsolationAllowlist = fromAsm;
    spatialBoltIsolationAllowlist = new Set<string>(fromAsm);
  }

  const refs: AnalyzerHighlightRef[] = [{ id: part.id, expressId: part.expressId }];

  return {
    refs,
    boltGuidIsolationAllowlist,
    spatialBoltIsolationAllowlist,
    useIfcBoltSteelRelationIsolation,
    relationBoltGlobalIdsRaw,
  };
}

export function resolveProfileIsolationBoltPolicy(
  instances: readonly { id: string; expressId: number | null }[],
  assemblies: readonly {
    parts: { id: string }[];
    bolts?: { id: string; expressId: number | null }[] | undefined;
  }[],
  boltSteelLinks: readonly { boltGlobalId: string; partGlobalId: string }[] | undefined,
): PartIsolationBoltPolicy {
  const unionBoltAllow = new Set<string>();
  const unionLinkSpatial = new Set<string>();
  const refAcc: AnalyzerHighlightRef[] = [];
  const unionRawBolts: string[] = [];
  const seenNorm = new Set<string>();
  const hasLinkTable = Array.isArray(boltSteelLinks) && boltSteelLinks.length > 0;
  let useIfcBoltSteelRelationIsolation =
    instances.length > 0 && hasLinkTable;

  for (const p of instances) {
    const pol = resolvePartIsolationBoltPolicy(p, assemblies, boltSteelLinks);
    useIfcBoltSteelRelationIsolation &&= pol.useIfcBoltSteelRelationIsolation;
    for (const r of pol.refs) refAcc.push(r);
    if (pol.boltGuidIsolationAllowlist) {
      for (const g of pol.boltGuidIsolationAllowlist) unionBoltAllow.add(g);
    }
    if (pol.spatialBoltIsolationAllowlist) {
      for (const g of pol.spatialBoltIsolationAllowlist) unionLinkSpatial.add(g);
    }
    if (pol.relationBoltGlobalIdsRaw?.length) {
      for (const raw of pol.relationBoltGlobalIdsRaw) {
        const nk = normalizeIfcGuidKey(raw) ?? raw.trim();
        if (!nk || seenNorm.has(nk)) continue;
        seenNorm.add(nk);
        unionRawBolts.push(raw.trim());
      }
    }
  }

  return {
    refs: dedupeAnalyzerHighlightRefs(refAcc),
    boltGuidIsolationAllowlist: unionBoltAllow.size > 0 ? unionBoltAllow : undefined,
    spatialBoltIsolationAllowlist:
      unionLinkSpatial.size > 0 ? unionLinkSpatial : undefined,
    useIfcBoltSteelRelationIsolation,
    relationBoltGlobalIdsRaw: unionRawBolts.length > 0 ? unionRawBolts : undefined,
  };
}
