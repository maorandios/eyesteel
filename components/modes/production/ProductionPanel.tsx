"use client";

import type { AnalyzerAssembly } from "@/types/domain";
import { Card } from "@/components/ui/card";

export function ProductionPanel({ assembly }: { assembly: AnalyzerAssembly | null }) {
  if (!assembly) return <p className="text-sm text-zinc-400">בחר Assembly להצגה</p>;
  return (
    <div className="space-y-2">
      <Card>
        <p className="text-lg font-bold">{assembly.assemblyMark || "ללא סימון"}</p>
        <p className="text-xs text-zinc-400">כמות חלקים: {assembly.parts.length}</p>
      </Card>
      {assembly.parts.slice(0, 8).map((part) => (
        <Card key={part.id} className="space-y-1">
          <p className="text-sm font-semibold">{part.tag || "ללא סימון חלק"}</p>
          <p className="text-xs text-zinc-400">{part.ifcType}</p>
          <p className="text-xs text-zinc-400">{part.profile || "-"}</p>
          <p className="text-xs text-zinc-400">{part.material || "-"}</p>
        </Card>
      ))}
    </div>
  );
}
