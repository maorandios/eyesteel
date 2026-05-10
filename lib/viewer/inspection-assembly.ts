import type { AnalyzerAssembly } from "@/types/domain";

/** First assembly in the analyzer list that contains this part id (IfcElementAssembly → parts). */
export function findAssemblyLabelForPart(
  partId: string,
  assemblies: readonly AnalyzerAssembly[],
): string | null {
  for (const a of assemblies) {
    if (a.parts.some((p) => p.id === partId)) {
      const m = a.assemblyMark?.trim();
      if (m) return m;
      const n = a.name?.trim();
      if (n) return n;
      const t = a.tag?.trim();
      if (t) return t;
      return null;
    }
  }
  return null;
}
