import type { AnalyzerPart, AnalyzerOutput } from "@/types/domain";
import { isAnalyzerBoltRow } from "@/types/domain";
import { analyzerRefsFromAssembly } from "@/lib/viewer/ifc-guid";
import { aggregateAssembliesByMark } from "@/lib/viewer/modelAggregates";
import type { ViewerEngine } from "@/lib/viewer/engine";
import {
  aggregateProfilesForModelTab,
  aggregateSteelPartsForModelTab,
} from "@/components/viewer/SelectionPickDetails";

export type ViewFilterPick = {
  hiddenAssemblyKeys: Record<string, boolean>;
  hiddenPartIds: Record<string, boolean>;
  hiddenPartTabGroupKeys: Record<string, boolean>;
  hiddenProfileTabGroupKeys: Record<string, boolean>;
  /** הבורג: fastener overlay — openings are not propagated from these ids in the engine. */
  hideAllFastenersKeepHoles?: boolean;
};

/** Structural picks vs בורג overlay — openings merge only from {@link structuralHidden}. */
export type ViewFilterHiddenLocals = {
  structuralHidden: Set<number>;
  fastenerHidden: Set<number>;
};

/**
 * Resolves analyzer + filter picks to fragment local ids for visibility.
 * Structural set gets `HasOpenings` expansion in the engine; fastener set does not (holes stay visible).
 */
export async function resolveViewFilterHiddenLocals(
  engine: ViewerEngine,
  analyzerData: AnalyzerOutput,
  filter: ViewFilterPick,
): Promise<ViewFilterHiddenLocals> {
  const structuralHidden = new Set<number>();
  const asmKeys = Object.keys(filter.hiddenAssemblyKeys);
  const partIds = Object.keys(filter.hiddenPartIds);
  const partTabKeys = Object.keys(filter.hiddenPartTabGroupKeys);
  const profileTabKeys = Object.keys(filter.hiddenProfileTabGroupKeys);

  const steelParts = analyzerData.parts.filter((p): p is AnalyzerPart => !isAnalyzerBoltRow(p));

  if (asmKeys.length > 0) {
    const rows = aggregateAssembliesByMark(analyzerData.assemblies);
    const byKey = new Map(rows.map((r) => [r.key, r] as const));
    for (const k of asmKeys) {
      const row = byKey.get(k);
      if (!row) continue;
      for (const inst of row.instances) {
        const refs = analyzerRefsFromAssembly(inst);
        const set = await engine.resolveIsolationLocalIds(refs);
        set.forEach((id) => structuralHidden.add(id));
      }
    }
  }

  const pushPartLocals = async (parts: AnalyzerPart[]) => {
    for (const p of parts) {
      const set = await engine.resolveIsolationLocalIds([{ id: p.id, expressId: p.expressId }]);
      set.forEach((id) => structuralHidden.add(id));
    }
  };

  if (partIds.length > 0) {
    for (const pid of partIds) {
      const part = analyzerData.parts.find((p) => p.id === pid);
      if (!part || isAnalyzerBoltRow(part)) continue;
      await pushPartLocals([part]);
    }
  }

  if (partTabKeys.length > 0) {
    const rows = aggregateSteelPartsForModelTab(steelParts);
    const byKey = new Map(rows.map((r) => [r.key, r] as const));
    for (const k of partTabKeys) {
      const row = byKey.get(k);
      if (!row) continue;
      await pushPartLocals(row.instances);
    }
  }

  if (profileTabKeys.length > 0) {
    const rows = aggregateProfilesForModelTab(steelParts);
    const byKey = new Map(rows.map((r) => [r.key, r] as const));
    for (const k of profileTabKeys) {
      const row = byKey.get(k);
      if (!row) continue;
      await pushPartLocals(row.instances);
    }
  }

  const fastenerHidden = new Set<number>();
  if (filter.hideAllFastenersKeepHoles) {
    const fasteners = await engine.resolveMechanicalFastenerLocalsToHide();
    for (const id of fasteners) fastenerHidden.add(id);
  }

  return { structuralHidden, fastenerHidden };
}
