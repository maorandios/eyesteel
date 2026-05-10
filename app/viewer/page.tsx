"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useRouter } from "next/navigation";
import { ViewerCanvas } from "@/components/viewer/ViewerCanvas";
import { CompactModeNav } from "@/components/viewer/CompactModeNav";
import { SmartMeasurementCard } from "@/components/viewer/SmartMeasurementCard";
import { ViewerBottomDock } from "@/components/viewer/ViewerBottomDock";
import { ClippingActiveBar } from "@/components/viewer/ClippingActiveBar";
import { ViewModeActiveBar } from "@/components/viewer/ViewModeActiveBar";
import { IsolationActionBar } from "@/components/viewer/IsolationActionBar";
import { MultiSelectActionBar } from "@/components/viewer/MultiSelectActionBar";
import { Button } from "@/components/ui/button";
import { modeConfig } from "@/lib/modes/config";
import { useAppStore } from "@/lib/state/app-store";
import { useClippingStore } from "@/lib/state/clipping-store";
import { useViewerToolStore } from "@/lib/state/viewer-tool-store";
import { useSmartMeasureStore } from "@/lib/state/smart-measure-store";
import { useViewerViewStore } from "@/lib/state/viewer-view-store";
import { useIsolationStore } from "@/lib/state/isolation-store";
import { useMultiSelectStore } from "@/lib/state/multi-select-store";
import { ViewerEngine } from "@/lib/viewer/engine";
import type { ViewModeId } from "@/lib/viewer/view-mode-presets";
import type { ClippingDirectionId } from "@/lib/viewer/clipping-presets";
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
import { GlobalSearchOverlay } from "@/components/viewer/GlobalSearchOverlay";
import { ViewFilterPanel } from "@/components/viewer/ViewFilterPanel";
import { useViewFilterSync } from "@/hooks/use-view-filter-sync";
import { useViewFilterStore } from "@/lib/state/view-filter-store";
import { resolveViewFilterHiddenLocals } from "@/lib/viewer/view-filter-resolve";
import { formatCount, formatKgPlain, formatQuantityInt } from "@/lib/format-numbers";
import {
  analyzerEntityMatchesPick,
  analyzerRefsFromAssembly,
} from "@/lib/viewer/ifc-guid";

import {
  aggregateAssembliesByMark,
  choosePreferredAssemblyForModelPick,
  type AggregatedAssemblyRow,
} from "@/lib/viewer/modelAggregates";

const ASSEMBLY_STRUCTURE_NOTICE_HE =
  "המודל אינו מכיל חלוקה לאסמבליז, נדרש לייצא את המודל שוב עם חלוקה לאמסבליז במצב פעיל";

type SelectionMode = "part" | "assembly";
type ModelDataTab = "assemblies" | "parts" | "profiles";

export default function ViewerPage() {
  const router = useRouter();
  const [engine, setEngine] = useState<ViewerEngine | null>(null);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("part");
  const [assemblyStructureNotice, setAssemblyStructureNotice] = useState(false);
  const [modelDataTab, setModelDataTab] = useState<ModelDataTab>("assemblies");
  const [selectedAssemblyId, setSelectedAssemblyId] = useState<string | null>(null);
  const [assemblyDetailOverride, setAssemblyDetailOverride] = useState<AnalyzerAssembly | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [profileGroupDetail, setProfileGroupDetail] = useState<{
    profileLabel: string;
    instances: AnalyzerPart[];
  } | null>(null);
  const [selectionStatus, setSelectionStatus] = useState("בחר אלמנט במודל או מהטבלה");
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
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
    sketchModeEnabled,
    toggleSketchMode,
  } = useAppStore();

  const viewerTool = useViewerToolStore((s) => s.activeTool);
  const setViewerTool = useViewerToolStore((s) => s.setActiveTool);

  const viewMode = useViewerViewStore((s) => s.viewMode);
  const setOrthographicView = useViewerViewStore((s) => s.setOrthographicView);
  const clearViewModeStore = useViewerViewStore((s) => s.clearView);

  const isolationMode = useIsolationStore((s) => s.isolationMode);
  const pickInteractionMode = useMultiSelectStore((s) => s.pickInteractionMode);
  const multiSelectedCount = useMultiSelectStore((s) => s.selectedLocalIds.length);

  const clipSnap = useClippingStore(
    useShallow((s) => ({
      active: s.active,
      direction: s.direction,
      labelHe: s.labelHe,
      depthOffset: s.depthOffset,
      depthMin: s.depthMin,
      depthMax: s.depthMax,
      flipped: s.flipped,
    })),
  );

  useEffect(() => {
    if (!engine || loadingState !== "ready") {
      useClippingStore.getState().reset();
      useIsolationStore.getState().reset();
      useMultiSelectStore.getState().reset();
      return;
    }
    useClippingStore.getState().syncFromEngine(engine.getClippingUiSnapshot());
  }, [engine, loadingState]);

  useEffect(() => {
    if (!engine) return;
    if (isolationMode !== "none") return;
    engine.setTransparency(useAppStore.getState().transparencyEnabled);
  }, [engine, isolationMode, transparencyEnabled]);

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
    clearViewModeStore();
    useAppStore.setState({ sketchModeEnabled: false });
    setLoadingState("parsing");
    engine
      .loadFile(file)
      .then(() => setLoadingState("ready"))
      .catch((err) => {
        console.error("IFC load failed:", err);
        setLoadingState("error");
      });
  }, [engine, file, setLoadingState, clearViewModeStore]);

  useEffect(() => {
    if (!engine || !analyzerData || loadingState !== "ready") return;
    void engine.syncAnalyzerGuidIndex(analyzerData);
  }, [engine, analyzerData, loadingState]);

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

  useEffect(() => {
    if (!engine) return;
    engine.setSketchModeFromUI(sketchModeEnabled);
  }, [engine, sketchModeEnabled]);

  const handleSketchToggle = useCallback(() => {
    toggleSketchMode();
    const enabled = useAppStore.getState().sketchModeEnabled;
    engine?.setSketchModeFromUI(enabled);
  }, [engine, toggleSketchMode]);

  const onReady = useCallback((instance: ViewerEngine | null) => setEngine(instance), []);
  const modeLabel = modeConfig[mode].label;

  useEffect(() => {
    if (viewerTool !== "measurement") {
      useSmartMeasureStore.getState().setMeasurementDetailsOpen(false);
    }
  }, [viewerTool]);

  const toggleMeasurementTool = useCallback(() => {
    if (viewerTool !== "measurement") {
      if (useMultiSelectStore.getState().pickInteractionMode === "multi") {
        useMultiSelectStore.getState().exitMultiSelectSession();
        void engine?.highlightFragmentLocalSet(new Set());
      }
    }
    setViewerTool(viewerTool === "measurement" ? "none" : "measurement");
  }, [viewerTool, setViewerTool, engine]);

  const finishMeasurementTool = useCallback(() => {
    setViewerTool("none");
  }, [setViewerTool]);

  const handleApplyViewMode = useCallback(
    (mode: ViewModeId) => {
      if (!engine) return;
      const ok = engine.applyViewMode(mode);
      if (ok) {
        setOrthographicView(mode);
        useClippingStore.getState().setClipSectionOrthoActive(false);
      }
    },
    [engine, setOrthographicView],
  );

  const handleExitViewMode = useCallback(() => {
    engine?.exitViewMode();
    clearViewModeStore();
    useClippingStore.getState().setClipSectionOrthoActive(false);
  }, [engine, clearViewModeStore]);

  const handlePickClippingDirection = useCallback(
    (dir: ClippingDirectionId) => {
      if (!engine) return;
      const cs = useClippingStore.getState();
      if (cs.clipSectionOrthoActive) {
        engine.exitViewMode();
        clearViewModeStore();
        cs.setClipSectionOrthoActive(false);
      }
      engine.enableClippingDirection(dir);
      useClippingStore.getState().syncFromEngine(engine.getClippingUiSnapshot());
    },
    [engine, clearViewModeStore],
  );

  const handleClippingDepth = useCallback((value: number) => {
    if (!engine) return;
    engine.setClippingDepthOffset(value);
    useClippingStore.getState().syncFromEngine(engine.getClippingUiSnapshot());
  }, [engine]);

  const handleClippingFlip = useCallback(() => {
    if (!engine) return;
    engine.flipClipping();
    useClippingStore.getState().syncFromEngine(engine.getClippingUiSnapshot());
  }, [engine]);

  const handleClippingCancel = useCallback(() => {
    if (!engine) return;
    engine.clearClipping();
    clearViewModeStore();
    useClippingStore.getState().setClipSectionOrthoActive(false);
    useClippingStore.getState().syncFromEngine(engine.getClippingUiSnapshot());
  }, [engine, clearViewModeStore]);

  const handleClippingSectionViewToggle = useCallback(() => {
    if (!engine) return;
    const cs = useClippingStore.getState();
    if (cs.clipSectionOrthoActive) {
      engine.exitViewMode();
      clearViewModeStore();
      cs.setClipSectionOrthoActive(false);
      return;
    }
    const ok = engine.applySectionViewFromActiveClipping();
    if (!ok) return;
    const snap = engine.getClippingUiSnapshot();
    if (snap.direction) setOrthographicView(snap.direction);
    cs.setClipSectionOrthoActive(true);
  }, [engine, clearViewModeStore, setOrthographicView]);

  const hasRealIfcAssemblies = useMemo(
    () => (analyzerData?.assemblies ?? []).some((a) => a.expressId != null),
    [analyzerData?.assemblies],
  );

  useEffect(() => {
    queueMicrotask(() => setAssemblyStructureNotice(false));
  }, [analyzerData, hasRealIfcAssemblies]);

  useEffect(() => {
    useViewFilterStore.getState().reset();
  }, [analyzerData]);

  useViewFilterSync(engine, analyzerData, loadingState);

  const assemblyRollupAll = useMemo(
    () => aggregateAssembliesByMark(analyzerData?.assemblies ?? []),
    [analyzerData?.assemblies],
  );

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

  const selectedAssembly = useMemo(() => {
    if (assemblyDetailOverride && assemblyDetailOverride.id === selectedAssemblyId) {
      return assemblyDetailOverride;
    }
    return analyzerData?.assemblies.find((a) => a.id === selectedAssemblyId) || null;
  }, [analyzerData, selectedAssemblyId, assemblyDetailOverride]);
  const selectedPart = useMemo(
    () => analyzerData?.parts.find((p) => p.id === selectedPartId) || null,
    [analyzerData, selectedPartId],
  );

  const isolationRefs = useMemo((): { id: string; expressId: number | null }[] => {
    if (profileGroupDetail?.instances?.length) {
      return profileGroupDetail.instances.map((p) => ({ id: p.id, expressId: p.expressId }));
    }
    if (selectedAssembly) {
      return analyzerRefsFromAssembly(selectedAssembly);
    }
    if (selectedPart) {
      return [{ id: selectedPart.id, expressId: selectedPart.expressId }];
    }
    return [];
  }, [profileGroupDetail, selectedAssembly, selectedPart]);

  /** Re-run סינון תצוגה worker state after anything that calls `resetVisible` (e.g. `clearIsolationVisuals`). */
  const reapplyViewFilterIfNeeded = useCallback(async (eng: ViewerEngine) => {
    const vf = useViewFilterStore.getState();
    const data = useAppStore.getState().analyzerData;
    if (!data) return;
    if (
      Object.keys(vf.hiddenAssemblyKeys).length === 0 &&
      Object.keys(vf.hiddenPartIds).length === 0 &&
      Object.keys(vf.hiddenPartTabGroupKeys).length === 0 &&
      Object.keys(vf.hiddenProfileTabGroupKeys).length === 0
    ) {
      return;
    }
    const hidden = await resolveViewFilterHiddenLocals(eng, data, {
      hiddenAssemblyKeys: vf.hiddenAssemblyKeys,
      hiddenPartIds: vf.hiddenPartIds,
      hiddenPartTabGroupKeys: vf.hiddenPartTabGroupKeys,
      hiddenProfileTabGroupKeys: vf.hiddenProfileTabGroupKeys,
    });
    await eng.applyViewVisibilityFilter(hidden);
  }, []);

  /**
   * Clears selection highlight / isolation without breaking סינון תצוגה: never call `clearIsolationVisuals`
   * when isolation mode is none (that resets all fragment visibility). When isolation was on, restore
   * the filter after the worker reset.
   */
  const clearEngineSelectionPreservingViewFilter = useCallback(
    async (eng: ViewerEngine) => {
      if (useIsolationStore.getState().isolationMode !== "none") {
        await eng.clearIsolationVisuals();
        useIsolationStore.getState().clearIsolation();
        await reapplyViewFilterIfNeeded(eng);
      } else {
        await eng.clearHighlight();
        useIsolationStore.getState().clearIsolation();
      }
      eng.setTransparency(useAppStore.getState().transparencyEnabled);
    },
    [reapplyViewFilterIfNeeded],
  );

  const handleIsolationIsolate = useCallback(async () => {
    if (!engine) return;
    const ids = await engine.resolveIsolationLocalIds(isolationRefs);
    if (ids.size === 0) {
      return;
    }
    const ok = await engine.applyIsolation("isolated", ids, { focus: true });
    if (ok) useIsolationStore.getState().setIsolation("isolated", [...ids]);
  }, [engine, isolationRefs]);

  const handleIsolationContext = useCallback(async () => {
    if (!engine) return;
    const ids = await engine.resolveIsolationLocalIds(isolationRefs);
    if (ids.size === 0) {
      return;
    }
    const ok = await engine.applyIsolation("context", ids, { focus: true });
    if (ok) useIsolationStore.getState().setIsolation("context", [...ids]);
  }, [engine, isolationRefs]);

  const handleIsolationHide = useCallback(async () => {
    if (!engine) return;
    const ids = await engine.resolveIsolationLocalIds(isolationRefs);
    if (ids.size === 0) {
      return;
    }
    const ok = await engine.applyIsolation("hidden", ids, { focus: true });
    if (ok) useIsolationStore.getState().setIsolation("hidden", [...ids]);
  }, [engine, isolationRefs]);

  const handleIsolationShowAll = useCallback(async () => {
    if (!engine) return;
    await engine.clearIsolationVisuals();
    useIsolationStore.getState().clearIsolation();
    engine.setTransparency(useAppStore.getState().transparencyEnabled);
    await reapplyViewFilterIfNeeded(engine);
    useMultiSelectStore.getState().exitMultiSelectSession();
  }, [engine, reapplyViewFilterIfNeeded]);

  const handleEnterMultiSelect = useCallback(() => {
    if (!engine || viewerTool === "measurement" || isolationMode !== "none") return;
    useMultiSelectStore.getState().clearSelected();
    useMultiSelectStore.getState().enterMultiSelect();
    void engine.highlightFragmentLocalSet(new Set());
    setSelectionStatus("בחירה מרובה: לחץ על אלמנטים במודל");
  }, [engine, viewerTool, isolationMode]);

  const handleMultiIsolate = useCallback(async () => {
    if (!engine) return;
    const ids = useMultiSelectStore.getState().selectedLocalIds;
    if (ids.length === 0) return;
    const ok = await engine.applyIsolation("isolated", new Set(ids), { focus: true });
    if (ok) {
      useIsolationStore.getState().setIsolation("isolated", ids);
      useMultiSelectStore.getState().exitMultiSelectSession();
    }
  }, [engine]);

  const handleMultiContext = useCallback(async () => {
    if (!engine) return;
    const ids = useMultiSelectStore.getState().selectedLocalIds;
    if (ids.length === 0) return;
    const ok = await engine.applyIsolation("context", new Set(ids), { focus: true });
    if (ok) {
      useIsolationStore.getState().setIsolation("context", ids);
      useMultiSelectStore.getState().exitMultiSelectSession();
    }
  }, [engine]);

  const handleMultiHide = useCallback(async () => {
    if (!engine) return;
    const ids = useMultiSelectStore.getState().selectedLocalIds;
    if (ids.length === 0) return;
    const ok = await engine.applyIsolation("hidden", new Set(ids), { focus: true });
    if (ok) {
      useIsolationStore.getState().setIsolation("hidden", ids);
      useMultiSelectStore.getState().exitMultiSelectSession();
    }
  }, [engine]);

  const handleMultiClear = useCallback(async () => {
    useMultiSelectStore.getState().clearSelected();
    await engine?.highlightFragmentLocalSet(new Set());
    setSelectionStatus("בחירה מרובה: נוקו בחירות");
  }, [engine]);

  const handleMultiDone = useCallback(async () => {
    useMultiSelectStore.getState().exitMultiSelectSession();
    await engine?.highlightFragmentLocalSet(new Set());
    setSelectionStatus("מצב בחירה רגיל");
  }, [engine]);

  const selectAssembly = useCallback(
    async (assembly: AnalyzerAssembly | null, opts?: { focusCamera?: boolean }) => {
      useMultiSelectStore.getState().exitMultiSelectSession();
      const focusCamera = opts?.focusCamera !== false;
      setProfileGroupDetail(null);
      setAssemblyStructureNotice(false);
      if (!assembly) {
        setAssemblyDetailOverride(null);
        setSelectedAssemblyId(null);
        setSelectedPartId(null);
        if (engine) {
          await clearEngineSelectionPreservingViewFilter(engine);
        }
        return;
      }
      const allAsm = analyzerData?.assemblies ?? [];
      const inDataset = allAsm.some((a) => a.id === assembly.id);
      setAssemblyDetailOverride(inDataset ? null : assembly);

      setSelectedAssemblyId(assembly.id);
      setSelectedPartId(null);
      if (!engine) return;
      const refs = analyzerRefsFromAssembly(assembly);
      await engine.highlightAnalyzerSubset(refs);
      if (focusCamera) await engine.focusAnalyzerSubset(refs);
      setActiveSheet("details");
      const partIds = new Set(assembly.parts.map((p) => p.id));
      const boltCount = assembly.bolts?.length ?? 0;
      setSelectionStatus(
        `Assembly: ${assembly.assemblyMark || assembly.name || assembly.id} (${formatCount(partIds.size)} חלקים${boltCount ? `, ${formatCount(boltCount)} ברגים` : ""})`,
      );
    },
    [engine, setActiveSheet, analyzerData?.assemblies, clearEngineSelectionPreservingViewFilter],
  );

  const selectAggregatedAssemblyRow = useCallback(
    async (row: AggregatedAssemblyRow) => {
      useMultiSelectStore.getState().exitMultiSelectSession();
      setProfileGroupDetail(null);
      setAssemblyDetailOverride(null);
      setAssemblyStructureNotice(false);
      const primary = row.instances[0];
      if (!primary) return;
      setSelectedAssemblyId(primary.id);
      setSelectedPartId(null);
      if (!engine) return;

      const refs: { id: string; expressId: number | null }[] = [];
      for (const asm of row.instances) {
        refs.push(...analyzerRefsFromAssembly(asm));
      }

      await engine.highlightAnalyzerSubset(refs);
      await engine.focusAnalyzerSubset(refs);
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
      useMultiSelectStore.getState().exitMultiSelectSession();
      setProfileGroupDetail({
        profileLabel: row.profileLabel,
        instances: row.instances,
      });
      setSelectedAssemblyId(null);
      setAssemblyDetailOverride(null);
      setAssemblyStructureNotice(false);
      setSelectedPartId(null);
      if (!engine) return;
      const refs = row.instances.map((p) => ({ id: p.id, expressId: p.expressId }));
      await engine.highlightAnalyzerSubset(refs);
      await engine.focusAnalyzerSubset(refs);
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
      useMultiSelectStore.getState().exitMultiSelectSession();
      const focusCamera = opts?.focusCamera !== false;
      if (part !== null && !opts?.preserveProfileGroup) {
        setProfileGroupDetail(null);
      }
      setAssemblyStructureNotice(false);
      setAssemblyDetailOverride(null);
      setSelectedPartId(part?.id ?? null);
      setSelectedAssemblyId(null);
      if (!engine) return;
      if (!part) {
        await clearEngineSelectionPreservingViewFilter(engine);
        return;
      }
      const refs = [{ id: part.id, expressId: part.expressId }];
      await engine.highlightAnalyzerSubset(refs);
      if (focusCamera) await engine.focusAnalyzerSubset(refs);
      setActiveSheet("details");
      setSelectionStatus(
        isAnalyzerBoltRow(part)
          ? `בורג: ${part.boltName || part.name || part.id}`
          : `חלק: ${displayPartMark(part as AnalyzerPart)}`,
      );
    },
    [engine, setActiveSheet, clearEngineSelectionPreservingViewFilter],
  );

  const selectPartInstances = useCallback(
    async (instances: AnalyzerPart[]) => {
      useMultiSelectStore.getState().exitMultiSelectSession();
      setProfileGroupDetail(null);
      setAssemblyDetailOverride(null);
      setAssemblyStructureNotice(false);
      const first = instances[0];
      if (!first) return;
      setSelectedPartId(first.id);
      setSelectedAssemblyId(null);
      if (!engine) return;
      const refs = instances.map((p) => ({ id: p.id, expressId: p.expressId }));
      await engine.highlightAnalyzerSubset(refs);
      await engine.focusAnalyzerSubset(refs);
      setActiveSheet("details");
      const label = displayPartMark(first);
      setSelectionStatus(
        instances.length > 1 ? `${label} · ${formatCount(instances.length)} פריטים` : `חלק: ${label}`,
      );
    },
    [engine, setActiveSheet],
  );

  const clearViewerSelection = useCallback(async () => {
    setAssemblyStructureNotice(false);
    useMultiSelectStore.getState().exitMultiSelectSession();
    setAssemblyDetailOverride(null);
    setSelectedAssemblyId(null);
    setSelectedPartId(null);
    setProfileGroupDetail(null);
    if (engine) {
      await clearEngineSelectionPreservingViewFilter(engine);
    }
    setSelectionStatus("נוקה");
  }, [engine, clearEngineSelectionPreservingViewFilter]);

  const handleGlobalSearchPickAssembly = useCallback(
    async (a: AnalyzerAssembly) => {
      setGlobalSearchOpen(false);
      setModelDataTab("assemblies");
      await selectAssembly(a);
    },
    [selectAssembly],
  );

  const handleGlobalSearchPickPart = useCallback(
    async (p: AnalyzerIndexedEntity) => {
      setGlobalSearchOpen(false);
      setModelDataTab("parts");
      await selectPart(p);
    },
    [selectPart],
  );

  const handleGlobalSearchPickProfile = useCallback(
    async (r: AggregatedProfileTabRow) => {
      setGlobalSearchOpen(false);
      setModelDataTab("profiles");
      await selectProfileGroupRow(r);
    },
    [selectProfileGroupRow],
  );

  useEffect(() => {
    if (!engine) return;
    engine.setPickCallback(async (hit) => {
      if (!hit) {
        /**
         * Empty-canvas tap: clear the current selection so users can deselect by clicking away.
         * In "בחירה מרובה" we keep the running set so accidental misses don't wipe it.
         */
        if (useMultiSelectStore.getState().pickInteractionMode === "multi") return;
        await clearViewerSelection();
        return;
      }

      const highlightIds =
        typeof hit.localId === "number"
          ? [hit.localId]
          : typeof hit.itemId === "number"
            ? [hit.itemId]
            : [];

      const pickCtx = await engine.resolvePickMatchContext(hit);
      const guidIdx = engine.getAnalyzerGuidIndex();

      if (useMultiSelectStore.getState().pickInteractionMode === "multi") {
        const toggleAndHighlight = async (targetIds: number[]) => {
          const uniq = [...new Set(targetIds)].filter(
            (n) => typeof n === "number" && Number.isFinite(n),
          );
          if (uniq.length === 0) return;
          useMultiSelectStore.getState().toggleLocalIds(uniq);
          const sel = useMultiSelectStore.getState().selectedLocalIds;
          await engine.highlightFragmentLocalSet(new Set(sel));
          setSelectionStatus(`בחירה מרובה: ${formatCount(sel.length)} אלמנטים`);
        };

        if (!analyzerData) {
          await toggleAndHighlight(highlightIds);
          if (highlightIds.length === 0) {
            setSelectionStatus("בחירה מרובה: לא נמצאו מזהים (נדרש ניתוח למודל)");
          }
          return;
        }

        if (selectionMode === "assembly" && !hasRealIfcAssemblies) {
          if (highlightIds.length) await toggleAndHighlight(highlightIds);
          setAssemblyStructureNotice(true);
          setAssemblyDetailOverride(null);
          setSelectedAssemblyId(null);
          setSelectedPartId(null);
          setProfileGroupDetail(null);
          setActiveSheet("details");
          setSelectionStatus(ASSEMBLY_STRUCTURE_NOTICE_HE);
          return;
        }

        if (selectionMode === "assembly" && hasRealIfcAssemblies) {
          const candidates = analyzerData.assemblies.filter(
            (a) =>
              a.expressId != null &&
              (a.parts.some((p) =>
                analyzerEntityMatchesPick(p, pickCtx.localIds, pickCtx.guids, guidIdx),
              ) ||
                (a.bolts ?? []).some((b) =>
                  analyzerEntityMatchesPick(b, pickCtx.localIds, pickCtx.guids, guidIdx),
                )),
          );
          const assembly = choosePreferredAssemblyForModelPick(candidates);
          if (assembly) {
            const set = await engine.resolveIsolationLocalIds(analyzerRefsFromAssembly(assembly));
            await toggleAndHighlight([...set]);
            return;
          }
        }

        const part = analyzerData.parts.find((p) =>
          analyzerEntityMatchesPick(p, pickCtx.localIds, pickCtx.guids, guidIdx),
        );

        if (part) {
          const set = await engine.resolveIsolationLocalIds([{ id: part.id, expressId: part.expressId }]);
          await toggleAndHighlight([...set]);
          return;
        }

        const fallback = [...new Set([...pickCtx.localIds, ...highlightIds])].filter(
          (n) => typeof n === "number" && Number.isFinite(n),
        );
        if (fallback.length) await toggleAndHighlight(fallback);
        else setSelectionStatus("בחירה מרובה: לא נמצאה התאמה לנקודת המגע");
        return;
      }

      if (!analyzerData) {
        if (highlightIds.length) await engine.highlightItemIds(highlightIds);
        setSelectionStatus(
          highlightIds.length
            ? `נבחר פריט IFC ${formatCount(highlightIds[0])} (נתוני ניתוח לא זמינים)`
            : "נבחרה נקודה במודל (נתוני ניתוח לא זמינים)",
        );
        return;
      }

      if (selectionMode === "assembly" && !hasRealIfcAssemblies) {
        if (highlightIds.length) await engine.highlightItemIds(highlightIds);
        setAssemblyStructureNotice(true);
        setAssemblyDetailOverride(null);
        setSelectedAssemblyId(null);
        setSelectedPartId(null);
        setProfileGroupDetail(null);
        setActiveSheet("details");
        setSelectionStatus(ASSEMBLY_STRUCTURE_NOTICE_HE);
        return;
      }

      if (selectionMode === "assembly" && hasRealIfcAssemblies) {
        const candidates = analyzerData.assemblies.filter(
          (a) =>
            a.expressId != null &&
            (a.parts.some((p) =>
              analyzerEntityMatchesPick(p, pickCtx.localIds, pickCtx.guids, guidIdx),
            ) ||
              (a.bolts ?? []).some((b) =>
                analyzerEntityMatchesPick(b, pickCtx.localIds, pickCtx.guids, guidIdx),
              )),
        );
        const assembly = choosePreferredAssemblyForModelPick(candidates);
        if (assembly) {
          await selectAssembly(assembly, { focusCamera: false });
          return;
        }
      }

      const part = analyzerData.parts.find((p) =>
        analyzerEntityMatchesPick(p, pickCtx.localIds, pickCtx.guids, guidIdx),
      );

      if (!part) {
        if (highlightIds.length) await engine.highlightItemIds(highlightIds);
        setSelectionStatus(
          `לא זוהתה התאמה (local:${formatCount(hit.localId)}, item:${formatCount(hit.itemId)})`,
        );
        return;
      }

      await selectPart(part, { focusCamera: false });
    });
    return () => engine.setPickCallback(null);
  }, [
    engine,
    analyzerData,
    selectionMode,
    hasRealIfcAssemblies,
    selectAssembly,
    selectPart,
    setActiveSheet,
    clearViewerSelection,
  ]);

  const handleDockSelectionMode = useCallback((m: SelectionMode) => {
    setSelectionMode(m);
    if (m === "part") {
      setAssemblyStructureNotice(false);
    }
    setSelectionStatus(
      m === "assembly"
        ? "מצב Assembly: לחץ אלמנט במודל או שורה בטבלה"
        : "מצב Part: לחץ אלמנט במודל או שורה בטבלה",
    );
  }, []);

  const showDataPanel = activeSheet === "details";
  const showFilterPanel = activeSheet === "filter";

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <div className="absolute inset-0 z-0">
        <ViewerCanvas onReady={onReady} />
      </div>
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
            {formatCount(assemblyRollupAll.length)} הרכבות · {formatCount(analyzerData.parts.length)} חלקים
          </div>
        )}
        <div className="w-full truncate rounded-lg border border-zinc-700 bg-zinc-900/88 px-2 py-1 text-[10px] text-zinc-300">
          בחירה: {selectionStatus}
        </div>
        <Button variant="ghost" className="h-8 px-2 text-[11px] text-zinc-400 hover:text-zinc-100" onClick={() => void clearViewerSelection()}>
          נקה בחירה
        </Button>
      </div>

      <IsolationActionBar
        visible={
          pickInteractionMode !== "multi" &&
          (isolationMode !== "none" || isolationRefs.length > 0) &&
          loadingState === "ready"
        }
        isolationMode={isolationMode}
        disabled={!engine || viewerTool === "measurement"}
        onIsolate={() => void handleIsolationIsolate()}
        onContext={() => void handleIsolationContext()}
        onHide={() => void handleIsolationHide()}
        onShowAll={() => void handleIsolationShowAll()}
      />

      <MultiSelectActionBar
        visible={pickInteractionMode === "multi" && loadingState === "ready" && isolationMode === "none"}
        selectedCount={multiSelectedCount}
        disabled={!engine || viewerTool === "measurement"}
        onIsolate={() => void handleMultiIsolate()}
        onContext={() => void handleMultiContext()}
        onHide={() => void handleMultiHide()}
        onClear={() => void handleMultiClear()}
        onDone={() => void handleMultiDone()}
      />

      <ViewerBottomDock
        selectionMode={selectionMode}
        onSelectionModeChange={handleDockSelectionMode}
        onDashboard={() => setActiveSheet("details")}
        onViewFilter={
          loadingState === "ready" && analyzerData
            ? () => setActiveSheet("filter")
            : undefined
        }
        onGlobalSearch={
          loadingState === "ready" && analyzerData ? () => setGlobalSearchOpen(true) : undefined
        }
        measurementActive={viewerTool === "measurement"}
        onMeasurementToggle={toggleMeasurementTool}
        onMeasurementClear={() => engine?.clearMeasurements()}
        onMeasurementFinish={finishMeasurementTool}
        onApplyViewMode={handleApplyViewMode}
        viewModeDisabled={
          viewerTool === "measurement" || loadingState !== "ready"
        }
        sketchModeActive={sketchModeEnabled}
        onSketchToggle={handleSketchToggle}
        sketchDisabled={loadingState !== "ready"}
        clippingDisabled={loadingState !== "ready"}
        onPickClippingDirection={handlePickClippingDirection}
        multiSelectActive={pickInteractionMode === "multi"}
        multiSelectEnterDisabled={
          loadingState !== "ready" || isolationMode !== "none" || viewerTool === "measurement"
        }
        onMultiSelectEnter={handleEnterMultiSelect}
      />

      <ClippingActiveBar
        snapshot={clipSnap}
        onDepthChange={handleClippingDepth}
        onFlip={handleClippingFlip}
        onSectionViewToggle={handleClippingSectionViewToggle}
        onCancel={handleClippingCancel}
      />

      {viewMode !== "none" && (
        <ViewModeActiveBar
          viewMode={viewMode}
          onExit={handleExitViewMode}
          liftAboveClippingHud={clipSnap.active}
        />
      )}

      {viewerTool === "measurement" && <SmartMeasurementCard />}

      {analyzerData && (
        <GlobalSearchOverlay
          open={globalSearchOpen}
          onClose={() => setGlobalSearchOpen(false)}
          assemblies={analyzerData.assemblies}
          indexedParts={analyzerData.parts}
          steelParts={steelPartsAll}
          onPickAssembly={handleGlobalSearchPickAssembly}
          onPickPart={handleGlobalSearchPickPart}
          onPickProfileRow={handleGlobalSearchPickProfile}
        />
      )}

      {showFilterPanel && (
        <div className="pointer-events-none absolute inset-0 z-30 flex justify-end">
          <aside
            className="pointer-events-auto flex h-full w-[22rem] max-w-[92vw] shrink-0 flex-col border-l border-zinc-700 bg-zinc-950/95 p-4 pt-16 shadow-2xl"
            dir="rtl"
          >
            <ViewFilterPanel
              assemblies={analyzerData?.assemblies ?? []}
              steelParts={steelPartsAll}
              onClose={() => setActiveSheet("none")}
            />
          </aside>
        </div>
      )}

      {showDataPanel && (
        <div className="pointer-events-none absolute inset-0 z-30 flex justify-end">
          <aside
            className="pointer-events-auto flex h-full w-[22rem] max-w-[92vw] shrink-0 flex-col border-l border-zinc-700 bg-zinc-950/95 p-4 pt-16 shadow-2xl"
            dir="rtl"
          >
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-zinc-100">
              {assemblyStructureNotice
                ? "מצב הרכבה"
                : selectedAssembly
                  ? "פרטי הרכבה"
                  : selectedPart
                    ? "פרטי חלק"
                    : profileGroupDetail
                      ? "פרטי פרופיל"
                      : `נתוני מודל (${modeLabel})`}
            </p>
            <Button
              variant="ghost"
              onClick={() => {
                setAssemblyStructureNotice(false);
                setActiveSheet("none");
              }}
            >
              סגור
            </Button>
          </div>

          {!selectedAssembly && !selectedPart && !profileGroupDetail && !assemblyStructureNotice && (
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
            {assemblyStructureNotice ? (
              <p className="px-1 text-sm leading-relaxed text-zinc-200">{ASSEMBLY_STRUCTURE_NOTICE_HE}</p>
            ) : selectedAssembly ? (
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
