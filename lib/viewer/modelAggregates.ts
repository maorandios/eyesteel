import type { AnalyzerAssembly } from "@/types/domain";

export type AggregatedAssemblyRow = {
  key: string;
  displayMark: string;
  /** How many IfcElementAssembly instances share this grouping key */
  qty: number;
  /** Sum of per-instance assembly weights from IFC */
  totalWeightKg: number | null;
  instances: AnalyzerAssembly[];
};

/** Group identical marks / fallback identifiers so duplicate assemblies roll up to one row */
export function assemblyGroupKey(a: AnalyzerAssembly): string {
  const m = (a.assemblyMark || "").trim();
  if (m) return `m:${m.toLowerCase()}`;
  const pc = (a.positionCode || "").trim();
  if (pc) return `p:${pc.toLowerCase()}`;
  const n = (a.name || "").trim();
  if (n) return `n:${n.toLowerCase()}`;
  return `id:${a.id}`;
}

export function displayAssemblyMark(a: AnalyzerAssembly): string {
  return (
    (a.assemblyMark || "").trim() ||
    (a.positionCode || "").trim() ||
    (a.name || "").trim() ||
    (a.expressId != null ? `#${a.expressId}` : a.id)
  );
}

/** Natural ascending sort key for assembly labels (A1, A2, B10, …) */
export function compareAssemblyLabels(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

export function aggregateAssembliesByMark(assemblies: AnalyzerAssembly[]): AggregatedAssemblyRow[] {
  const buckets = new Map<string, AnalyzerAssembly[]>();
  for (const asm of assemblies) {
    const k = assemblyGroupKey(asm);
    const prev = buckets.get(k);
    if (prev) prev.push(asm);
    else buckets.set(k, [asm]);
  }

  const rows: AggregatedAssemblyRow[] = [];
  for (const [key, instances] of buckets) {
    const displayMark = displayAssemblyMark(instances[0]);
    let sumKg = 0;
    let any = false;
    for (const a of instances) {
      if (a.weightKg != null && !Number.isNaN(a.weightKg)) {
        sumKg += a.weightKg;
        any = true;
      }
    }
    rows.push({
      key,
      displayMark,
      qty: instances.length,
      totalWeightKg: any ? sumKg : null,
      instances,
    });
  }

  rows.sort((x, y) => compareAssemblyLabels(x.displayMark, y.displayMark));
  return rows;
}

/** How many IFC assemblies share the same grouping key as `assembly` (מספר הרכבה כפול במודל). */
export function countAssemblyOccurrencesInModel(
  assembly: AnalyzerAssembly,
  allAssemblies: AnalyzerAssembly[],
): number {
  if (!allAssemblies.length) return 1;
  const key = assemblyGroupKey(assembly);
  return allAssemblies.filter((a) => assemblyGroupKey(a) === key).length;
}
