"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ViewerCanvas } from "@/components/viewer/ViewerCanvas";
import { TopBar } from "@/components/viewer/TopBar";
import { BottomModeNav } from "@/components/viewer/BottomModeNav";
import { FloatingActions } from "@/components/viewer/actions/FloatingActions";
import { BottomSheet } from "@/components/sheets/BottomSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { modeConfig } from "@/lib/modes/config";
import { useAppStore } from "@/lib/state/app-store";
import { ViewerEngine } from "@/lib/viewer/engine";
import { he } from "@/lib/i18n/he";
import type { AnalyzerAssembly, AnalyzerPart } from "@/types/domain";

type SelectionMode = "part" | "assembly";

export default function ViewerPage() {
  const router = useRouter();
  const [engine, setEngine] = useState<ViewerEngine | null>(null);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("part");
  const [selectedAssemblyId, setSelectedAssemblyId] = useState<string | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [selectionStatus, setSelectionStatus] = useState("בחר אלמנט במודל או מהטבלה");
  const {
    file,
    analyzerData,
    mode,
    setMode,
    search,
    setSearch,
    activeSheet,
    setActiveSheet,
    categoryVisibility,
    toggleCategory,
    setLoadingState,
    loadingState,
    transparencyEnabled,
    setTransparencyEnabled,
  } = useAppStore();

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

  const filteredParts = useMemo(() => {
    const list = analyzerData?.parts ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) =>
        (p.tag || "").toLowerCase().includes(q) ||
        (p.name || "").toLowerCase().includes(q) ||
        (p.profile || "").toLowerCase().includes(q) ||
        (p.material || "").toLowerCase().includes(q),
    );
  }, [analyzerData, search]);

  const selectedAssembly = useMemo(
    () => analyzerData?.assemblies.find((a) => a.id === selectedAssemblyId) || null,
    [analyzerData, selectedAssemblyId],
  );
  const selectedPart = useMemo(
    () => analyzerData?.parts.find((p) => p.id === selectedPartId) || null,
    [analyzerData, selectedPartId],
  );

  const selectAssembly = useCallback(
    async (assembly: AnalyzerAssembly | null) => {
      setSelectedAssemblyId(assembly?.id ?? null);
      setSelectedPartId(null);
      if (!engine) return;
      if (!assembly) {
        await engine.clearHighlight();
        return;
      }
      const itemIds = assembly.parts
        .map((part) => part.expressId)
        .filter((n): n is number => typeof n === "number");
      await engine.highlightItemIds(itemIds);
      await engine.focusItemIds(itemIds);
      setActiveSheet("details");
      setSelectionStatus(
        `Assembly: ${assembly.assemblyMark || assembly.name || assembly.id} (${itemIds.length} פריטים)`,
      );
    },
    [engine, setActiveSheet],
  );

  const selectPart = useCallback(
    async (part: AnalyzerPart | null) => {
      setSelectedPartId(part?.id ?? null);
      setSelectedAssemblyId(null);
      if (!engine) return;
      if (!part) {
        await engine.clearHighlight();
        return;
      }
      const itemIds = part.expressId !== null ? [part.expressId] : [];
      await engine.highlightItemIds(itemIds);
      await engine.focusItemIds(itemIds);
      setActiveSheet("details");
      setSelectionStatus(`Part: ${part.tag || part.name || part.id}`);
    },
    [engine, setActiveSheet],
  );

  useEffect(() => {
    if (!engine || !analyzerData) return;
    engine.setPickCallback(async (hit) => {
      console.log("Pick hit:", hit, "mode:", selectionMode);
      const part =
        analyzerData.parts.find((p) => p.expressId === hit.itemId) ||
        analyzerData.parts.find((p) => p.expressId === hit.localId);

      if (!part) {
        if (engine) await engine.highlightItemIds([hit.itemId]);
        setSelectionStatus(`לא זוהתה התאמה (item:${hit.itemId})`);
        return;
      }

      if (selectionMode === "assembly") {
        const assembly = analyzerData.assemblies.find((a) =>
          a.parts.some((p) => p.id === part.id),
        );
        if (assembly) {
          await selectAssembly(assembly);
          return;
        }
      }
      await selectPart(part);
    });
    return () => engine.setPickCallback(null);
  }, [engine, analyzerData, selectionMode, selectAssembly, selectPart]);

  const showDataPanel = activeSheet === "details";

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <ViewerCanvas onReady={onReady} />
      <TopBar modeLabel={modeLabel} />
      <div className="absolute right-3 top-10 z-20 text-xs text-red-300">
        {loadingState === "error" ? "שגיאה בטעינת IFC" : ""}
      </div>

      <div className="absolute right-3 top-20 z-20">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setActiveSheet("details")}>
            נתוני מודל
          </Button>
          <Button
            variant={selectionMode === "assembly" ? "default" : "secondary"}
            onClick={() => {
              setSelectionMode("assembly");
              setSelectionStatus("מצב Assembly: לחץ אלמנט במודל או שורה בטבלה");
            }}
          >
            Assembly
          </Button>
          <Button
            variant={selectionMode === "part" ? "default" : "secondary"}
            onClick={() => {
              setSelectionMode("part");
              setSelectionStatus("מצב Part: לחץ אלמנט במודל או שורה בטבלה");
            }}
          >
            Part
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              selectAssembly(null);
              selectPart(null);
              setSelectionStatus("נוקה");
            }}
          >
            נקה
          </Button>
          <Button variant="secondary" onClick={() => router.push("/")}>
            {he.backToUpload}
          </Button>
        </div>
      </div>

      {analyzerData && (
        <div className="absolute right-3 top-[8.5rem] z-20 rounded-xl border border-zinc-700 bg-zinc-900/85 px-3 py-2 text-xs text-zinc-200">
          {analyzerData.assemblies.length} הרכבות / {analyzerData.parts.length} חלקים
        </div>
      )}
      <div className="absolute right-3 top-[11rem] z-20 max-w-[90vw] truncate rounded-xl border border-zinc-700 bg-zinc-900/85 px-3 py-2 text-xs text-zinc-200">
        בחירה: {selectionStatus}
      </div>

      <FloatingActions
        onSearch={() => setActiveSheet("search")}
        onLayers={() => setActiveSheet("layers")}
        onResetView={() => engine?.resetView()}
        onFitAll={() => engine?.fitAll()}
      />
      <BottomModeNav mode={mode} onModeChange={setMode} />

      <BottomSheet open={activeSheet === "search" || activeSheet === "layers"} title="כלים">
        {activeSheet === "search" && (
          <div className="space-y-3">
            <Input
              placeholder="חפש Assembly / Part / Element"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button className="w-full" onClick={() => setActiveSheet("none")}>
              סגור
            </Button>
          </div>
        )}
        {activeSheet === "layers" && (
          <div className="grid grid-cols-2 gap-2">
            {Object.keys(categoryVisibility).map((cat) => (
              <Button key={cat} variant="secondary" onClick={() => toggleCategory(cat)}>
                {cat}
              </Button>
            ))}
            <Button
              className="col-span-2"
              onClick={() => setTransparencyEnabled(!transparencyEnabled)}
            >
              {transparencyEnabled ? "בטל שקיפות" : "מצב שקיפות"}
            </Button>
          </div>
        )}
      </BottomSheet>

      {showDataPanel && (
        <aside className="absolute right-0 top-0 z-30 h-full w-[22rem] max-w-[85vw] border-l border-zinc-700 bg-zinc-950/95 p-4 pt-24 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-zinc-100">
              נתוני ניתוח ({modeLabel})
            </p>
            <Button variant="ghost" onClick={() => setActiveSheet("none")}>
              סגור
            </Button>
          </div>

          <div className="mb-3 text-xs text-zinc-300">
            הרכבות: {filteredAssemblies.length} | חלקים: {filteredParts.length}
          </div>

          <div className="max-h-[calc(100vh-11rem)] overflow-auto rounded-xl border border-zinc-800">
            {selectionMode === "assembly" && (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900 text-zinc-300">
                  <tr>
                    <th className="p-2 text-right">Assembly</th>
                    <th className="p-2 text-right">שם</th>
                    <th className="p-2 text-right">חלקים</th>
                    <th className="p-2 text-right">משקל</th>
                  </tr>
                </thead>
                <tbody>
                  {(selectedAssembly ? [selectedAssembly] : filteredAssemblies).map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => selectAssembly(a)}
                      className={`cursor-pointer border-t border-zinc-800 hover:bg-zinc-800 ${
                        selectedAssembly?.id === a.id ? "bg-zinc-800" : ""
                      }`}
                    >
                      <td className="p-2">{a.assemblyMark || "-"}</td>
                      <td className="p-2">{a.name || "-"}</td>
                      <td className="p-2">{a.parts.length}</td>
                      <td className="p-2">{a.weightKg ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {selectionMode === "part" && (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900 text-zinc-300">
                  <tr>
                    <th className="p-2 text-right">Part</th>
                    <th className="p-2 text-right">סוג</th>
                    <th className="p-2 text-right">Profile</th>
                    <th className="p-2 text-right">חומר</th>
                  </tr>
                </thead>
                <tbody>
                  {(selectedPart ? [selectedPart] : filteredParts).map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => selectPart(p)}
                      className={`cursor-pointer border-t border-zinc-800 hover:bg-zinc-800 ${
                        selectedPart?.id === p.id ? "bg-zinc-800" : ""
                      }`}
                    >
                      <td className="p-2">{p.tag || p.name || "-"}</td>
                      <td className="p-2">{p.ifcType}</td>
                      <td className="p-2">{p.profile || "-"}</td>
                      <td className="p-2">{p.material || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {selectedPart && (
            <div className="mt-3 space-y-1 rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-300">
              <p>אורך: {selectedPart.lengthMm ?? "-"}</p>
              <p>משקל: {selectedPart.weightKg ?? "-"}</p>
              <p>X: {selectedPart.xDim ?? "-"}</p>
              <p>Y: {selectedPart.yDim ?? "-"}</p>
              <p>עובי: {selectedPart.thickness ?? "-"}</p>
            </div>
          )}
        </aside>
      )}
    </main>
  );
}
