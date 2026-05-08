"use client";

import { Card } from "@/components/ui/card";
import { formatCount, formatKgPlain } from "@/lib/format-numbers";
import { aggregateAssembliesByMark } from "@/lib/viewer/modelAggregates";
import type { AnalyzerOutput, Element } from "@/types/domain";

export function ManagementPanel({
  element,
  analyzerData,
}: {
  element: Element | null;
  analyzerData: AnalyzerOutput | null;
}) {
  if (element) {
    return (
      <Card className="space-y-1">
        <p className="text-sm font-semibold">{element.name || "ללא שם"}</p>
        <p className="text-xs text-zinc-400">סוג IFC: {element.ifcType}</p>
        <p className="text-xs text-zinc-400">Assembly mark: {element.assemblyMark || "-"}</p>
        <p className="text-xs text-zinc-400">Part mark: {element.partMark || "-"}</p>
        <p className="text-xs text-zinc-400">Profile: {element.profile || "-"}</p>
        <p className="text-xs text-zinc-400">Material: {element.material || "-"}</p>
      </Card>
    );
  }

  if (!analyzerData) return <p className="text-sm text-zinc-400">לא נמצאו נתוני ניתוח</p>;
  const assemblyGroups = aggregateAssembliesByMark(analyzerData.assemblies).length;
  return (
    <div className="space-y-2">
      <Card>
        <p className="text-sm font-semibold">סיכום מודל</p>
        <p className="text-xs text-zinc-400">
          קבוצות הרכבה: {formatCount(assemblyGroups)} · מופעי IFC:{" "}
          {formatCount(analyzerData.assemblies.length)}
        </p>
        <p className="text-xs text-zinc-400">חלקים: {formatCount(analyzerData.parts.length)}</p>
      </Card>
      {analyzerData.assemblies.slice(0, 8).map((assembly) => (
        <Card key={assembly.id} className="space-y-1">
          <p className="text-sm font-semibold">{assembly.assemblyMark || "ללא סימון"}</p>
          <p className="text-xs text-zinc-400">{assembly.name || "ללא שם הרכבה"}</p>
          <p className="text-xs text-zinc-400">כמות חלקים: {formatCount(assembly.parts.length)}</p>
          <p className="text-xs text-zinc-500">
            משקל:{" "}
            <span dir="ltr">{formatKgPlain(assembly.weightKg ?? null)}</span>
          </p>
        </Card>
      ))}
    </div>
  );
}
