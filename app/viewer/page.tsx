"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ViewerCanvas } from "@/components/viewer/ViewerCanvas";
import { CompactModeNav } from "@/components/viewer/CompactModeNav";
import { SmartMeasurementCard } from "@/components/viewer/SmartMeasurementCard";
import { ViewerBottomDock } from "@/components/viewer/ViewerBottomDock";
import { ViewSectionControls } from "@/components/viewer/ViewSectionControls";
import { Button } from "@/components/ui/button";
import { modeConfig } from "@/lib/modes/config";
import { useAppStore } from "@/lib/state/app-store";
import { useViewerToolStore } from "@/lib/state/viewer-tool-store";
import { useSmartMeasureStore } from "@/lib/state/smart-measure-store";
import { ViewerEngine } from "@/lib/viewer/engine";
import type { ViewSectionPresetId } from "@/lib/viewer/view-section-presets";
import { he } from "@/lib/i18n/he";
import type { AnalyzerAssembly, AnalyzerIndexedEntity, AnalyzerPart } from "@/types/domain";
import { isAnalyzerBoltRow } from "@/types/domain";
import {
  AssemblyPickDetailPanel,
  PartPickDetailPanel,
  ProfileGroupPickDetailPanel,
  aggregateProfilesForModelTab,
  aggregateSteelPartsForModelTab,
  displayPartMark,
  type AggregatedProfileTabRow,
} from "@/components/viewer/SelectionPickDetails";
import { formatCount, formatKgPlain, formatQuantityInt } from "@/lib/format-numbers";

import {
  aggregateAssembliesByMark,
  type AggregatedAssemblyRow,
} from "@/lib/viewer/modelAggregates";

type SelectionMode = "part" | "assembly";

type ModelDataTab = "assemblies" | "parts" | "profiles";

export default function ViewerPage() {
  const router = useRouter();
  const [engine, setEngine] = useState<ViewerEngine | null>(null);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("part");
  const [modelDataTab, setModelDataTab] = useState<ModelDataTab>("assemblies");
  const [selectedAssemblyId, setSelectedAssemblyId] = useState<string | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [profileGroupDetail, setProfileGroupDetail] = useState<{
    profileLabel: string;
    instances: AnalyzerPart[];
  } | null>(null);
  const [selectionStatus, setSelectionStatus] = useState("בחר אלמנט במודל או מהטבלה");
  const {
    file,
    analyzerData,
    mode,
    setMode,
    search,
    activeSheet,
    setActiveSheet,
    categoryVisibility,
    setLoadingState,
    loadingState,
    transparencyEnabled,
  } = useAppStore();

  const viewerTool = useViewerToolStore((s) => s.activeTool);
  const setViewerTool = useViewerToolStore((s) => s.setActiveTool);

  useEffect(() => {
    if (!engine) return;
    engine.setViewerTool(viewerTool);
  }, [engine, viewerTool]);

  useEffect(() => {
    if (!file) setViewerTool("none");
  }, [file, setViewerTool]);

  useEffect(() => {
    if (!file) router.replace("/");
  }, [file, router]);

  useEffect(() => {
    if (!engine || !file) return;
    setLoadingState("parsing");
    engine
      .loadFile(file)
      .then(() => setLoadingState("ready"))
      .catch((err) => {
        console.error("IFC load failed:", err);
        setLoadingState("error");
      });
  }, [engine, file, setLoadingState]);

  useEffect(() => {
    if (!engine) return;
    engine.setMode(mode);
  }, [engine, mode]);

  useEffect(() => {
    if (!engine) return;
    Object.entries(categoryVisibility).forEach(([cat, visible]) => {
      engine.setCategoryVisible(cat, visible);
    });
  }, [engine, categoryVisibility]);

  useEffect(() => {
    if (!engine) return;
    engine.setTransparency(transparencyEnabled);
  }, [engine, transparencyEnabled]);

  const onReady = useCallback((instance: ViewerEngine | null) => setEngine(instance), []);
  const modeLabel = modeConfig[mode].label;

  useEffect(() => {
    if (viewerTool !== "measurement") {
      useSmartMeasureStore.getState().setMeasurementDetailsOpen(false);
    }
  }, [viewerTool]);

  const toggleMeasurementTool = useCallback(() => {
    setViewerTool(viewerTool === "measurement" ? "none" : "measurement");
  }, [viewerTool, setViewerTool]);

  const finishMeasurementTool = useCallback(() => {
    setViewerTool("none");
  }, [setViewerTool]);

  const handleViewPreset = useCallback(
    (preset: ViewSectionPresetId) => {
      engine?.applyViewPreset(preset);
      setViewerTool("none");
    },
    [engine, setViewerTool],
  );

  const handleBeginFreeSection = useCallback(() => {
    engine?.beginFreeSectionPick();
    setViewerTool("free_section_pick");
  }, [engine, setViewerTool]);

  const filteredAssemblies = useMemo(() => {
    const list = analyzerData?.assemblies ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (a) =>
        (a.assemblyMark || "").toLowerCase().includes(q) ||
        (a.name || "").toLowerCase().includes(q) ||
        (a.positionCode || "").toLowerCase().includes(q),
    );
  }, [analyzerData, search]);

  const steelPartsAll = useMemo(
    () => (analyzerData?.parts ?? []).filter((p): p is AnalyzerPart => !isAnalyzerBoltRow(p)),
    [analyzerData?.parts],
  );

  const filteredParts = useMemo(() => {
    const list = (analyzerData?.parts ?? []).filter((p): p is AnalyzerPart => !isAnalyzerBoltRow(p));
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) =>
        (p.tag || "").toLowerCase().includes(q) ||
        (p.partMark || "").toLowerCase().includes(q) ||
        (p.name || "").toLowerCase().includes(q) ||
        (p.profile || "").toLowerCase().includes(q) ||
        (p.material || "").toLowerCase().includes(q),
    );
  }, [analyzerData, search]);

  const aggregatedAssemblies = useMemo(
    () => aggregateAssembliesByMark(filteredAssemblies),
    [filteredAssemblies],
  );

  const aggregatedPartsTabRows = useMemo(
    () => aggregateSteelPartsForModelTab(filteredParts),
    [filteredParts],
  );

  const aggregatedProfilesTabRows = useMemo(
    () => aggregateProfilesForModelTab(filteredParts),
    [filteredParts],
  );

  const selectedAssembly = useMemo(
    () => analyzerData?.assemblies.find((a) => a.id === selectedAssemblyId) || null,
    [analyzerData, selectedAssemblyId],
  );
  const selectedPart = useMemo(
    () => analyzerData?.parts.find((p) => p.id === selectedPartId) || null,
    [analyzerData, selectedPartId],
  );

  const selectAssembly = useCallback(
    async (assembly: AnalyzerAssembly | null, opts?: { focusCamera?: boolean }) => {
      const focusCamera = opts?.focusCamera !== false;
      setProfileGroupDetail(null);
      setSelectedAssemblyId(assembly?.id ?? null);
      setSelectedPartId(null);
      if (!engine) return;
      if (!assembly) {
        await engine.clearHighlight();
        return;
      }
      const steelIds = assembly.parts
        .map((part) => part.expressId)
        .filter((n): n is number => typeof n === "number");
      const boltIds = (assembly.bolts ?? [])
        .map((b) => b.expressId)
        .filter((n): n is number => typeof n === "number");
      const itemIds = [...steelIds, ...boltIds];
      await engine.highlightItemIds(itemIds);
      if (focusCamera) await engine.focusItemIds(itemIds);
      setActiveSheet("details");
      const boltCount = assembly.bolts?.length ?? 0;
      setSelectionStatus(
        `Assembly: ${assembly.assemblyMark || assembly.name || assembly.id} (${formatCount(assembly.parts.length)} חלקים${boltCount ? `, ${formatCount(boltCount)} ברגים` : ""})`,
      );
    },
    [engine, setActiveSheet],
  );

  const selectAggregatedAssemblyRow = useCallback(
    async (row: AggregatedAssemblyRow) => {
      setProfileGroupDetail(null);
      const primary = row.instances[0];
      if (!primary) return;
      setSelectedAssemblyId(primary.id);
      setSelectedPartId(null);
      if (!engine) return;

      const itemIds: number[] = [];
      for (const asm of row.instances) {
        for (const part of asm.parts) {
          if (typeof part.expressId === "number") itemIds.push(part.expressId);
        }
        for (const b of asm.bolts ?? []) {
          if (typeof b.expressId === "number") itemIds.push(b.expressId);
        }
      }

      await engine.highlightItemIds(itemIds);
      await engine.focusItemIds(itemIds);
      setActiveSheet("details");
      const boltTotal = row.instances.reduce((s, a) => s + (a.bolts?.length ?? 0), 0);
      const first = row.instances[0];
      const partTypes = first?.parts.length ?? 0;
      setSelectionStatus(
        row.qty > 1
          ? `הרכבה ${row.displayMark} · כמות במודל ${formatCount(row.qty)} · פרטי הרכבה ראשונה`
          : `Assembly: ${row.displayMark} (${formatCount(partTypes)} חלקים${boltTotal ? `, ${formatCount(boltTotal)} ברגים` : ""})`,
      );
    },
    [engine, setActiveSheet],
  );

  const selectProfileGroupRow = useCallback(
    async (row: AggregatedProfileTabRow) => {
      setProfileGroupDetail({
        profileLabel: row.profileLabel,
        instances: row.instances,
      });
      setSelectedAssemblyId(null);
      setSelectedPartId(null);
      if (!engine) return;
      const itemIds = row.instances
        .map((p) => p.expressId)
        .filter((n): n is number => typeof n === "number");
      await engine.highlightItemIds(itemIds);
      await engine.focusItemIds(itemIds);
      setActiveSheet("details");
      setSelectionStatus(`פרופיל: ${row.profileLabel} · ${formatCount(row.instances.length)} חלקים`);
    },
    [engine, setActiveSheet],
  );

  const selectPart = useCallback(
    async (
      part: AnalyzerIndexedEntity | null,
      opts?: { preserveProfileGroup?: boolean; focusCamera?: boolean },
    ) => {
      const focusCamera = opts?.focusCamera !== false;
      if (part !== null && !opts?.preserveProfileGroup) {
        setProfileGroupDetail(null);
      }
      setSelectedPartId(part?.id ?? null);
      setSelectedAssemblyId(null);
      if (!engine) return;
      if (!part) {
        await engine.clearHighlight();
        return;
      }
      const itemIds = part.expressId !== null ? [part.expressId] : [];
      await engine.highlightItemIds(itemIds);
      if (focusCamera) await engine.focusItemIds(itemIds);
      setActiveSheet("details");
      setSelectionStatus(
        isAnalyzerBoltRow(part)
          ? `בורג: ${part.boltName || part.name || part.id}`
          : `חלק: ${displayPartMark(part as AnalyzerPart)}`,
      );
    },
    [engine, setActiveSheet],
  );

  const selectPartInstances = useCallback(
    async (instances: AnalyzerPart[]) => {
      setProfileGroupDetail(null);
      const first = instances[0];
      if (!first) return;
      setSelectedPartId(first.id);
      setSelectedAssemblyId(null);
      if (!engine) return;
      const itemIds = instances
        .map((p) => p.expressId)
        .filter((n): n is number => typeof n === "number");
      await engine.highlightItemIds(itemIds);
      await engine.focusItemIds(itemIds);
      setActiveSheet("details");
      const label = displayPartMark(first);
      setSelectionStatus(
        instances.length > 1 ? `${label} · ${formatCount(instances.length)} פריטים` : `חלק: ${label}`,
      );
    },
    [engine, setActiveSheet],
  );

  useEffect(() => {
    if (!engine) return;
    engine.setPickCallback(async (hit) => {
      if (!analyzerData) {
        await engine.highlightItemIds([hit.itemId]);
        setSelectionStatus(`נבחר פריט IFC ${formatCount(hit.itemId)} (נתוני ניתוח לא זמינים)`);
        return;
      }

      const part =
        analyzerData.parts.find((p) => p.expressId === hit.itemId) ||
        analyzerData.parts.find((p) => p.expressId === hit.localId);

      if (!part) {
        await engine.highlightItemIds([hit.itemId]);
        setSelectionStatus(`לא זוהתה התאמה (item:${formatCount(hit.itemId)})`);
        return;
      }

      if (selectionMode === "assembly") {
        const assembly = analyzerData.assemblies.find(
          (a) =>
            a.parts.some((p) => p.id === part.id) ||
            (a.bolts ?? []).some((b) => b.id === part.id),
        );
        if (assembly) {
          await selectAssembly(assembly, { focusCamera: false });
          return;
        }
      }
      await selectPart(part, { focusCamera: false });
    });
    return () => engine.setPickCallback(null);
  }, [engine, analyzerData, selectionMode, selectAssembly, selectPart]);

  const handleDockSelectionMode = useCallback((m: SelectionMode) => {
    setSelectionMode(m);
    setSelectionStatus(
      m === "assembly"
        ? "מצב Assembly: לחץ אלמנט במודל או שורה בטבלה"
        : "מצב Part: לחץ אלמנט במודל או שורה בטבלה",
    );
  }, []);

  const clearViewerSelection = useCallback(async () => {
    await selectAssembly(null);
    await selectPart(null);
    setProfileGroupDetail(null);
    setSelectionStatus("נוקה");
  }, [selectAssembly, selectPart]);

  const showDataPanel = activeSheet === "details";

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <ViewerCanvas onReady={onReady} />

      <div className="pointer-events-auto absolute left-3 top-3 z-40 safe-top">
        <Button variant="secondary" size="lg" className="shadow-lg" onClick={() => router.push("/")}>
          {he.backToUpload}
        </Button>
      </div>

      <div className="pointer-events-auto absolute left-3 top-[3.25rem] z-30 max-w-[70vw] text-xs text-red-400 safe-top">
        {loadingState === "error" ? "שגיאה בטעינת IFC" : ""}
      </div>

      <CompactModeNav mode={mode} onModeChange={setMode} />

      <div className="pointer-events-auto absolute right-3 top-[4.75rem] z-20 flex max-w-[min(19rem,88vw)] flex-col items-end gap-1 safe-top">
        {analyzerData && (
          <div className="rounded-lg border border-zinc-700 bg-zinc-900/88 px-2 py-1 text-[10px] leading-tight text-zinc-300">
            {formatCount(analyzerData.assemblies.length)} הרכבות · {formatCount(analyzerData.parts.length)}{" "}
            חלקים
          </div>
        )}
        <div className="w-full truncate rounded-lg border border-zinc-700 bg-zinc-900/88 px-2 py-1 text-[10px] text-zinc-300">
          בחירה: {selectionStatus}
        </div>
        <Button variant="ghost" className="h-8 px-2 text-[11px] text-zinc-400 hover:text-zinc-100" onClick={() => void clearViewerSelection()}>
          נקה בחירה
        </Button>
      </div>

      <ViewerBottomDock
        selectionMode={selectionMode}
        onSelectionModeChange={handleDockSelectionMode}
        onDashboard={() => setActiveSheet("details")}
        measurementActive={viewerTool === "measurement"}
        onMeasurementToggle={toggleMeasurementTool}
        onMeasurementClear={() => engine?.clearMeasurements()}
        onMeasurementFinish={finishMeasurementTool}
        onViewPreset={handleViewPreset}
        onBeginFreeSection={handleBeginFreeSection}
      />

      <ViewSectionControls engine={engine} />

      {viewerTool === "measurement" && <SmartMeasurementCard />}

      {showDataPanel && (
        <div className="pointer-events-none absolute inset-0 z-30 flex justify-end">
          <aside
            className="pointer-events-auto flex h-full w-[22rem] max-w-[92vw] shrink-0 flex-col border-l border-zinc-700 bg-zinc-950/95 p-4 pt-16 shadow-2xl"
            dir="rtl"
          >
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-zinc-100">
              {selectedAssembly
                ? "פרטי הרכבה"
                : selectedPart
                  ? "פרטי חלק"
                  : profileGroupDetail
                    ? "פרטי פרופיל"
                    : `נתוני מודל (${modeLabel})`}
            </p>
            <Button variant="ghost" onClick={() => setActiveSheet("none")}>
              סגור
            </Button>
          </div>

          {!selectedAssembly && !selectedPart && !profileGroupDetail && (
            <div className="mb-3 text-xs text-zinc-400">
              {modelDataTab === "assemblies" && (
                <>
                  קבוצות: {formatCount(aggregatedAssemblies.length)} · מופעי IFC:{" "}
                  {formatCount(filteredAssemblies.length)}
                </>
              )}
              {modelDataTab === "parts" && (
                <>
                  קבוצות: {formatCount(aggregatedPartsTabRows.length)} · פריטי IFC:{" "}
                  {formatCount(filteredParts.length)}
                </>
              )}
              {modelDataTab === "profiles" && (
                <>
                  פרופילים ייחודיים: {formatCount(aggregatedProfilesTabRows.length)} · פריטי IFC:{" "}
                  {formatCount(filteredParts.length)}
                </>
              )}
            </div>
          )}

          <div className="max-h-[calc(100vh-11rem)] overflow-auto rounded-xl border border-zinc-800 bg-zinc-950/30 p-2">
            {selectedAssembly ? (
              <AssemblyPickDetailPanel
                assembly={selectedAssembly}
                allAssemblies={analyzerData?.assemblies ?? []}
                onSelectPartInstances={(instances) => void selectPartInstances(instances)}
                onBackToList={() => void selectAssembly(null)}
              />
            ) : selectedPart ? (
              <PartPickDetailPanel
                entity={selectedPart}
                allSteelParts={steelPartsAll}
                onBackToList={() => void selectPart(null)}
              />
            ) : profileGroupDetail ? (
              <ProfileGroupPickDetailPanel
                profileLabel={profileGroupDetail.profileLabel}
                instances={profileGroupDetail.instances}
                onBackToList={() => {
                  setProfileGroupDetail(null);
                  void engine?.clearHighlight();
                  setSelectionStatus("בחר אלמנט במודל או מהטבלה");
                }}
                onPickPart={(p) => void selectPart(p, { preserveProfileGroup: true })}
              />
            ) : (
              <>
                <div className="mb-2 flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
                  <button
                    type="button"
                    className={`flex-1 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                      modelDataTab === "assemblies"
                        ? "bg-zinc-700 text-zinc-100"
                        : "text-zinc-400 hover:bg-zinc-800/80"
                    }`}
                    onClick={() => setModelDataTab("assemblies")}
                  >
                    הרכבות
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                      modelDataTab === "parts"
                        ? "bg-zinc-700 text-zinc-100"
                        : "text-zinc-400 hover:bg-zinc-800/80"
                    }`}
                    onClick={() => setModelDataTab("parts")}
                  >
                    חלקים
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                      modelDataTab === "profiles"
                        ? "bg-zinc-700 text-zinc-100"
                        : "text-zinc-400 hover:bg-zinc-800/80"
                    }`}
                    onClick={() => setModelDataTab("profiles")}
                  >
                    פרופילים
                  </button>
                </div>

                {modelDataTab === "assemblies" && (
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
                      <tr>
                        <th className="p-2 text-right font-medium">מספר הרכבה</th>
                        <th className="p-2 text-right font-medium">כמות</th>
                        <th className="p-2 text-right font-medium">משקל (ק״ג)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aggregatedAssemblies.map((row) => (
                        <tr
                          key={row.key}
                          onClick={() => void selectAggregatedAssemblyRow(row)}
                          className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/90"
                        >
                          <td className="p-2 font-medium text-zinc-100">{row.displayMark}</td>
                          <td className="p-2 text-zinc-300">{formatCount(row.qty)}</td>
                          <td className="whitespace-nowrap p-2 text-zinc-300">
                            <span dir="ltr">{formatKgPlain(row.totalWeightKg)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {modelDataTab === "assemblies" && aggregatedAssemblies.length > 0 && (
                  <p className="mt-2 px-1 text-[11px] leading-snug text-zinc-500">
                    כמות = כמה פעמים אותה הרכבה (לפי מספר הרכבה) מופיעה במודל. משקל = סכום משקלי כל
                    המופעים.
                  </p>
                )}

                {modelDataTab === "parts" && (
                  <>
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
                        <tr>
                          <th className="p-2 text-right font-medium">מספר חלק</th>
                          <th className="p-2 text-right font-medium">פרופיל</th>
                          <th className="p-2 text-right font-medium">כמות</th>
                          <th className="p-2 text-right font-medium">משקל (ק״ג)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {aggregatedPartsTabRows.map((row) => (
                          <tr
                            key={row.key}
                            onClick={() => void selectPartInstances(row.instances)}
                            className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/90"
                          >
                            <td className="p-2 font-medium text-zinc-100">{row.displayMark}</td>
                            <td className="p-2 text-zinc-300">
                              {row.displayProfile === "ללא שם" ? (
                                row.displayProfile
                              ) : (
                                <span dir="ltr" className="inline-block text-right">
                                  {row.displayProfile}
                                </span>
                              )}
                            </td>
                            <td className="p-2 text-zinc-300">{formatQuantityInt(row.effectiveQty)}</td>
                            <td className="whitespace-nowrap p-2 text-zinc-300">
                              <span dir="ltr">{formatKgPlain(row.totalWeightKg)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {aggregatedPartsTabRows.length > 0 && (
                      <p className="mt-2 px-1 text-[11px] leading-snug text-zinc-500">
                        מיון עולה לפי מספר חלק. חלקים זהים (מספר חלק / פרופיל / שם / משקל ליחידה)
                        בשורה אחת; כמות = כפילויות במודל או Quantity מהמודל; משקל = סכום כל הפריטים.
                      </p>
                    )}
                  </>
                )}

                {modelDataTab === "profiles" && (
                  <>
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
                        <tr>
                          <th className="p-2 text-right font-medium">שם הפרופיל</th>
                          <th className="p-2 text-right font-medium">כמות</th>
                          <th className="p-2 text-right font-medium">משקל (ק״ג)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {aggregatedProfilesTabRows.map((row) => (
                          <tr
                            key={row.key}
                            onClick={() => void selectProfileGroupRow(row)}
                            className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/90"
                          >
                            <td className="p-2 font-medium text-zinc-100">
                              {row.profileLabel === "ללא שם" ? (
                                row.profileLabel
                              ) : (
                                <span dir="ltr" className="inline-block text-right">
                                  {row.profileLabel}
                                </span>
                              )}
                            </td>
                            <td className="p-2 text-zinc-300">{formatCount(row.totalQty)}</td>
                            <td className="whitespace-nowrap p-2 text-zinc-300">
                              <span dir="ltr">{formatKgPlain(row.totalWeightKg)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {aggregatedProfilesTabRows.length > 0 && (
                      <p className="mt-2 px-1 text-[11px] leading-snug text-zinc-500">
                        מיון עולה לפי שם פרופיל. כמות = סכום יחידות מכל החלקים עם אותו פרופיל (Quantity מהמודל או 1
                        לישות); משקל = סכום משקלי כל הפריטים.
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </aside>
        </div>
      )}
    </main>
  );
}
