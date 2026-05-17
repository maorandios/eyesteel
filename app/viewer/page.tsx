"use client";

import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useRouter } from "next/navigation";
import { ViewerCanvas } from "@/components/viewer/ViewerCanvas";
import { ViewerBottomDock } from "@/components/viewer/ViewerBottomDock";
import {
  ProductionModeOverlay,
  type ProductionAppMode,
  type ProductionPartRow,
  type ProductionSelection,
  type ProductionTab,
} from "@/components/viewer/ProductionModeOverlay";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/state/app-store";
import { useClippingStore } from "@/lib/state/clipping-store";
import { useViewerToolStore } from "@/lib/state/viewer-tool-store";
import { useSmartMeasureStore } from "@/lib/state/smart-measure-store";
import { useViewerViewStore } from "@/lib/state/viewer-view-store";
import { useIsolationStore } from "@/lib/state/isolation-store";
import {
  type MultiSelectWeightItem,
  useMultiSelectStore,
} from "@/lib/state/multi-select-store";
import {
  ViewerEngine,
  type ApplyIsolationOptions,
  type ProductionHoleOverlayInput,
} from "@/lib/viewer/engine";
import type { ViewModeId } from "@/lib/viewer/view-mode-presets";
import type { ClippingDirectionId } from "@/lib/viewer/clipping-presets";
import type { AnalyzerAssembly, AnalyzerBoltRow, AnalyzerIndexedEntity, AnalyzerPart } from "@/types/domain";
import { isAnalyzerBoltRow } from "@/types/domain";
import { Bolt, LayoutList, MoveLeft, SquaresIntersect, SquaresUnite, X } from "lucide-react";
import {
  AssemblyPickDetailPanel,
  PartPickDetailPanel,
  ProfileGroupPickDetailPanel,
  aggregateProfilesForModelTab,
  aggregateSteelPartsForModelTab,
  countSteelPartsMatchingIdentity,
  displayPartIfcName,
  displayPartMark,
  displayPartProfileCell,
  type AggregatedProfileTabRow,
} from "@/components/viewer/SelectionPickDetails";
import {
  DrawingMarkupLayer,
  type DrawingMarkupLayerHandle,
} from "@/components/viewer/DrawingMarkupLayer";
import {
  ElementPickContextPanel,
  ELEMENT_PICK_PANEL_ATTR,
  type ElementPickContextPanelState,
} from "@/components/viewer/ElementPickContextPanel";
import { ViewerSnapshotToasts } from "@/components/viewer/ViewerSnapshotToasts";
import { GlobalSearchOverlay } from "@/components/viewer/GlobalSearchOverlay";
import { ViewFilterPanel } from "@/components/viewer/ViewFilterPanel";
import { useViewFilterSync } from "@/hooks/use-view-filter-sync";
import { useViewFilterStore } from "@/lib/state/view-filter-store";
import { resolveViewFilterHiddenLocals } from "@/lib/viewer/view-filter-resolve";
import { formatCount, formatElevationMm, formatKgPlain, formatMmPlain, formatQuantityInt } from "@/lib/format-numbers";
import {
  analyzerBoltsForProductionHoleOverlay,
  analyzerEntityMatchesPick,
  analyzerRefsFromAssembly,
  analyzerSteelPartRefsFromAssembly,
  normalizeIfcGuidKey,
  resolvePartIsolationBoltPolicy,
  resolveProfileIsolationBoltPolicy,
  steelPartGuidsSharingAssembliesWith,
} from "@/lib/viewer/ifc-guid";
import {
  compositeViewerSnapshotPngBlob,
  copyImageBlobToClipboard,
} from "@/lib/viewer/view-snapshot";

import {
  aggregateAssembliesByMark,
  choosePreferredAssemblyForModelPick,
  countAssemblyOccurrencesInModel,
  displayAssemblyMark,
  type AggregatedAssemblyRow,
} from "@/lib/viewer/modelAggregates";

const ASSEMBLY_STRUCTURE_NOTICE_HE =
  "המודל אינו מכיל חלוקה לאסמבליז, נדרש לייצא את המודל שוב עם חלוקה לאמסבליז במצב פעיל";

const ELEMENT_PICK_CONTEXT_PANEL_SELECTOR = `[${ELEMENT_PICK_PANEL_ATTR}]`;
const VIEWER_CONTEXT_MENU_EXCLUDED_SELECTOR =
  `${ELEMENT_PICK_CONTEXT_PANEL_SELECTOR},button,a[href],input,textarea,select,label,aside,` +
  "[role='button'],[role='menu'],[role='menuitem'],[role='tab'],[role='dialog']";
const VIEWER_SIDE_PANEL_CHROME =
  "pointer-events-auto flex h-full w-[22rem] max-w-[92vw] shrink-0 flex-col border-l border-zinc-300/80 bg-[#eef1f3]/95 p-3 pt-8 text-zinc-800 shadow-[-18px_0_45px_rgba(39,39,42,0.18)] backdrop-blur-xl " +
  "[&_button]:text-zinc-700 [&_button:hover]:bg-zinc-200/80 [&_button:hover]:text-zinc-950 [&_svg]:text-zinc-500 " +
  "[&_thead]:text-zinc-500 [&_tbody_tr]:border-zinc-200 [&_th]:text-zinc-500 [&_td]:text-zinc-700 [&_td.font-medium]:text-zinc-900 [&_p]:text-zinc-600";
const VIEWER_SIDE_PANEL_SCROLL =
  "scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-400/70 hover:scrollbar-thumb-zinc-500/80 [scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-400/70 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-500/80";
const VIEWER_TOP_STRIP_RESERVE = "top-[calc(2.5rem+env(safe-area-inset-top))]";
const VIEWER_BOTTOM_STRIP_RESERVE = "bottom-[calc(3.75rem+env(safe-area-inset-bottom))]";

type SelectionMode = "part" | "assembly";
type ModelDataTab = "assemblies" | "parts" | "profiles";
type FlashTooltipRow = { label: string; value: string };
type FlashTooltipState = {
  x: number;
  y: number;
  kind: "assembly" | "part" | "bolt";
  title: string;
  rows: FlashTooltipRow[];
};

function multiSelectFallbackWeightKey(ids: readonly number[]): string {
  return `local:${[...new Set(ids)].filter(Number.isFinite).sort((a, b) => a - b).join(",")}`;
}

function flashTooltipPosition(clientX: number, clientY: number): { x: number; y: number } {
  const width = 280;
  const height = 260;
  const pad = 12;
  const x = Math.min(Math.max(clientX + 16, pad), Math.max(pad, window.innerWidth - width - pad));
  const y = Math.min(Math.max(clientY + 16, pad), Math.max(pad, window.innerHeight - height - pad));
  return { x, y };
}

function assemblyFlashRows(
  assembly: AnalyzerAssembly,
  allAssemblies: AnalyzerAssembly[],
): FlashTooltipRow[] {
  return [
    { label: "מספר אסמבלי", value: assembly.assemblyMark || "—" },
    { label: "שם אסמבלי", value: assembly.name || assembly.tag || "—" },
    { label: 'משקל כולל (ק״ג)', value: formatKgPlain(assembly.weightKg) },
    { label: "גובה עליון", value: formatElevationMm(assembly.topElevation) },
    { label: "גובה תחתון", value: formatElevationMm(assembly.bottomElevation) },
    { label: "כמות במודל", value: formatCount(countAssemblyOccurrencesInModel(assembly, allAssemblies)) },
  ];
}

function partFlashRows(part: AnalyzerPart, allSteelParts: AnalyzerPart[]): FlashTooltipRow[] {
  const modelCount = allSteelParts.length > 0 ? countSteelPartsMatchingIdentity(part, allSteelParts) : null;
  return [
    { label: "מספר חלק", value: displayPartMark(part) },
    { label: "פרופיל", value: displayPartProfileCell(part) },
    { label: "שם חלק", value: displayPartIfcName(part) },
    { label: "חומר", value: part.material || "—" },
    { label: "כמות", value: modelCount != null ? formatCount(modelCount) : "—" },
    { label: "גובה עליון", value: formatElevationMm(part.topElevation ?? null) },
    { label: "גובה תחתון", value: formatElevationMm(part.bottomElevation ?? null) },
  ];
}

function boltFlashRows(bolt: AnalyzerBoltRow): FlashTooltipRow[] {
  return [
    { label: "שם הבורג", value: bolt.boltName || bolt.name || "—" },
    { label: "אורך (מ״מ)", value: formatMmPlain(bolt.boltLengthMm) },
    { label: "תקן", value: bolt.boltStandard || "—" },
    { label: "קוטר חור (מ״מ)", value: formatMmPlain(bolt.boltHoleDiameterMm) },
    { label: "כמות", value: formatQuantityInt(bolt.boltQty) },
  ];
}

export default function ViewerPage() {
  const router = useRouter();
  const [engine, setEngine] = useState<ViewerEngine | null>(null);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("part");
  const [assemblyStructureNotice, setAssemblyStructureNotice] = useState(false);
  const [modelDataTab, setModelDataTab] = useState<ModelDataTab>("assemblies");
  const [productionTab, setProductionTab] = useState<ProductionTab>("assemblies");
  const [productionSearch, setProductionSearch] = useState("");
  const [productionViewerOpen, setProductionViewerOpen] = useState(false);
  const [, setProductionSelection] = useState<ProductionSelection>({
    type: null,
    id: null,
  });
  const [productionPartsDrawerOpen, setProductionPartsDrawerOpen] = useState(false);
  const [selectedAssemblyId, setSelectedAssemblyId] = useState<string | null>(null);
  const [assemblyDetailOverride, setAssemblyDetailOverride] = useState<AnalyzerAssembly | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [profileGroupDetail, setProfileGroupDetail] = useState<{
    profileLabel: string;
    instances: AnalyzerPart[];
  } | null>(null);
  const [, setSelectionStatus] = useState("בחר אלמנט במודל או מהטבלה");
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [markupDrawingEnabled, setMarkupDrawingEnabled] = useState(false);
  const [drawingClearSignal, setDrawingClearSignal] = useState(0);
  const markupLayerRef = useRef<DrawingMarkupLayerHandle>(null);
  const [snapshotCopyToast, setSnapshotCopyToast] = useState(false);
  const [snapshotSessionOpen, setSnapshotSessionOpen] = useState(false);
  const [elementContextPanel, setElementContextPanel] = useState<ElementPickContextPanelState | null>(
    null,
  );
  const [flashTooltip, setFlashTooltip] = useState<FlashTooltipState | null>(null);
  const desktopMultiSelectKeyDownRef = useRef(false);
  const [snapshotCapturePending, setSnapshotCapturePending] = useState(false);
  const snapshotBlobRef = useRef<Blob | null>(null);
  const snapshotCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidePanelSnapshotRef = useRef<HTMLDivElement>(null);
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
  const appMode: ProductionAppMode = mode === "production" ? "production" : "management";

  const viewerTool = useViewerToolStore((s) => s.activeTool);
  const setViewerTool = useViewerToolStore((s) => s.setActiveTool);

  const viewMode = useViewerViewStore((s) => s.viewMode);
  const setOrthographicView = useViewerViewStore((s) => s.setOrthographicView);
  const clearViewModeStore = useViewerViewStore((s) => s.clearView);

  const isolationMode = useIsolationStore((s) => s.isolationMode);
  const pickInteractionMode = useMultiSelectStore((s) => s.pickInteractionMode);
  const multiSelectedLocalIds = useMultiSelectStore((s) => s.selectedLocalIds);
  const multiSelectedCount = useMultiSelectStore((s) => s.selectedLocalIds.length);
  const multiSelectWeightItems = useMultiSelectStore((s) => s.selectedWeightItems);

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

  const multiSelectTotalWeightKg = useMemo(() => {
    if (multiSelectedCount === 0 || multiSelectWeightItems.length === 0) return null;
    let total = 0;
    for (const item of multiSelectWeightItems) {
      if (item.weightKg == null || Number.isNaN(item.weightKg)) return null;
      total += item.weightKg;
    }
    return total;
  }, [multiSelectedCount, multiSelectWeightItems]);

  useEffect(() => {
    const releaseDesktopMultiSelect = () => {
      desktopMultiSelectKeyDownRef.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control") desktopMultiSelectKeyDownRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control") releaseDesktopMultiSelect();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseDesktopMultiSelect);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseDesktopMultiSelect);
    };
  }, []);

  useEffect(() => {
    if (!elementContextPanel) return;

    const dismiss = () => setElementContextPanel(null);

    const inside = (t: EventTarget | null) =>
      t instanceof Element && t.closest(ELEMENT_PICK_CONTEXT_PANEL_SELECTOR) !== null;

    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) dismiss();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.buttons !== 0) dismiss();
    };

    const onWheel = () => dismiss();

    const onContextMenu = (e: MouseEvent) => {
      if (!inside(e.target)) dismiss();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    document.addEventListener("contextmenu", onContextMenu, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      document.removeEventListener("contextmenu", onContextMenu, true);
    };
  }, [elementContextPanel]);

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
    const exitSnap = engine.setViewerTool(viewerTool);
    if (!exitSnap) return;
    if (exitSnap.orthoMode !== null) setOrthographicView(exitSnap.orthoMode);
    else clearViewModeStore();
  }, [engine, viewerTool, setOrthographicView, clearViewModeStore]);

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

  useEffect(() => {
    if (viewerTool !== "measurement") {
      useSmartMeasureStore.getState().clearBreakdown();
    }
    if (viewerTool !== "flash") {
      queueMicrotask(() => setFlashTooltip(null));
    }
  }, [viewerTool]);

  const toggleMeasurementTool = useCallback(() => {
    if (viewerTool !== "measurement") {
      setMarkupDrawingEnabled(false);
      setElementContextPanel(null);
      setFlashTooltip(null);
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

  const toggleFlashTool = useCallback(() => {
    const next = viewerTool === "flash" ? "none" : "flash";
    if (next === "flash") {
      setMarkupDrawingEnabled(false);
      setElementContextPanel(null);
      if (useMultiSelectStore.getState().pickInteractionMode === "multi") {
        useMultiSelectStore.getState().exitMultiSelectSession();
        void engine?.highlightFragmentLocalSet(new Set());
      }
    } else {
      setFlashTooltip(null);
    }
    setViewerTool(next);
  }, [engine, setViewerTool, viewerTool]);

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

  const handleResetView = useCallback(() => {
    if (!engine || loadingState !== "ready") return;
    engine.resetView();
    clearViewModeStore();
    useClippingStore.getState().setClipSectionOrthoActive(false);
  }, [engine, loadingState, clearViewModeStore]);

  const toggleDashboardSheet = useCallback(() => {
    if (activeSheet === "details") {
      setActiveSheet("none");
      return;
    }
    setActiveSheet("details");
  }, [activeSheet, setActiveSheet]);

  const toggleFilterSheet = useCallback(() => {
    if (activeSheet === "filter") {
      setActiveSheet("none");
      return;
    }
    setActiveSheet("filter");
  }, [activeSheet, setActiveSheet]);

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

  const hideAllFastenersKeepHoles = useViewFilterStore((s) => s.hideAllFastenersKeepHoles);
  const toggleHideAllFastenersKeepHoles = useViewFilterStore(
    (s) => s.toggleHideAllFastenersKeepHoles,
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

  const productionAssemblyRows = useMemo(() => {
    const q = productionSearch.trim().toLowerCase();
    const rows = aggregateAssembliesByMark(analyzerData?.assemblies ?? []);
    if (!q) return rows;
    return rows.filter((row) => row.displayMark.toLowerCase().includes(q));
  }, [analyzerData?.assemblies, productionSearch]);

  const productionPartRows = useMemo(() => {
    const q = productionSearch.trim().toLowerCase();
    const rows = aggregateSteelPartsForModelTab(steelPartsAll);
    if (!q) return rows;
    return rows.filter(
      (row) =>
        row.displayMark.toLowerCase().includes(q) ||
        row.displayProfile.toLowerCase().includes(q),
    );
  }, [productionSearch, steelPartsAll]);

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

  /** Part / profile isolation: refs + GUID sets (links with assembly fallback; spatial pass links-only when present). */
  const partIsolationBoltPolicy = useMemo(() => {
    if (selectedAssembly) return null;
    const assemblies = analyzerData?.assemblies ?? [];
    const boltLinks = analyzerData?.boltSteelLinks;
    if (profileGroupDetail?.instances?.length) {
      return resolveProfileIsolationBoltPolicy(
        profileGroupDetail.instances,
        assemblies,
        boltLinks,
      );
    }
    if (selectedPart) {
      return resolvePartIsolationBoltPolicy(selectedPart, assemblies, boltLinks);
    }
    return null;
  }, [
    analyzerData?.assemblies,
    analyzerData?.boltSteelLinks,
    profileGroupDetail,
    selectedAssembly,
    selectedPart,
  ]);

  const isolationRefs = useMemo((): { id: string; expressId: number | null }[] => {
    if (selectedAssembly) {
      return analyzerRefsFromAssembly(selectedAssembly);
    }
    return partIsolationBoltPolicy?.refs ?? [];
  }, [partIsolationBoltPolicy, selectedAssembly]);

  useEffect(() => {
    if (!engine) return;
    let cancelled = false;

    if (pickInteractionMode === "multi") {
      engine.setPickPriorityLocalIds(multiSelectedLocalIds, "all");
      return;
    }

    const syncNormalSelectionRightClickPriority = async () => {
      const refs = selectedAssembly
        ? analyzerRefsFromAssembly(selectedAssembly)
        : selectedPart
          ? [{ id: selectedPart.id, expressId: selectedPart.expressId }]
          : (profileGroupDetail?.instances.map((p) => ({
              id: p.id,
              expressId: p.expressId,
            })) ?? []);

      if (refs.length === 0) {
        engine.setPickPriorityLocalIds([], "right-click");
        return;
      }

      const ids = await engine.resolveIsolationLocalIds(refs);
      if (!cancelled) {
        engine.setPickPriorityLocalIds(ids, "right-click");
      }
    };

    void syncNormalSelectionRightClickPriority();
    return () => {
      cancelled = true;
    };
  }, [
    engine,
    multiSelectedLocalIds,
    pickInteractionMode,
    profileGroupDetail,
    selectedAssembly,
    selectedPart,
  ]);

  /** Re-run סינון תצוגה worker state after anything that calls `resetVisible` (e.g. `clearIsolationVisuals`). */
  const reapplyViewFilterIfNeeded = useCallback(async (eng: ViewerEngine) => {
    const vf = useViewFilterStore.getState();
    const data = useAppStore.getState().analyzerData;
    if (!data) return;
    if (
      Object.keys(vf.hiddenAssemblyKeys).length === 0 &&
      Object.keys(vf.hiddenPartIds).length === 0 &&
      Object.keys(vf.hiddenPartTabGroupKeys).length === 0 &&
      Object.keys(vf.hiddenProfileTabGroupKeys).length === 0 &&
      !vf.hideAllFastenersKeepHoles
    ) {
      return;
    }
    const { structuralHidden, fastenerHidden } = await resolveViewFilterHiddenLocals(eng, data, {
      hiddenAssemblyKeys: vf.hiddenAssemblyKeys,
      hiddenPartIds: vf.hiddenPartIds,
      hiddenPartTabGroupKeys: vf.hiddenPartTabGroupKeys,
      hiddenProfileTabGroupKeys: vf.hiddenProfileTabGroupKeys,
      hideAllFastenersKeepHoles: vf.hideAllFastenersKeepHoles,
    });
    await eng.applyViewVisibilityFilter(structuralHidden, fastenerHidden);
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

  const isolationApplyOpts = useMemo((): ApplyIsolationOptions => {
    const base: ApplyIsolationOptions = { focus: true };
    if (!partIsolationBoltPolicy) return base;
    if (
      partIsolationBoltPolicy.boltGuidIsolationAllowlist &&
      partIsolationBoltPolicy.boltGuidIsolationAllowlist.size > 0
    ) {
      base.boltGuidIsolationAllowlist = partIsolationBoltPolicy.boltGuidIsolationAllowlist;
    }
    if (partIsolationBoltPolicy.spatialBoltIsolationAllowlist !== undefined) {
      base.spatialBoltIsolationAllowlist =
        partIsolationBoltPolicy.spatialBoltIsolationAllowlist;
    }
    if (partIsolationBoltPolicy.useIfcBoltSteelRelationIsolation) {
      base.useIfcBoltSteelRelationIsolation = true;
    }
    if (
      partIsolationBoltPolicy.relationBoltGlobalIdsRaw &&
      partIsolationBoltPolicy.relationBoltGlobalIdsRaw.length > 0
    ) {
      base.relationBoltGlobalIdsRaw = partIsolationBoltPolicy.relationBoltGlobalIdsRaw;
    }
    return base;
  }, [partIsolationBoltPolicy]);

  const resolveActiveIsolationLocalIds = useCallback(async () => {
    if (!engine) return new Set<number>();
    const ids = await engine.resolveIsolationLocalIds(isolationRefs);
    if (ids.size > 0) return ids;
    return new Set(useMultiSelectStore.getState().selectedLocalIds);
  }, [engine, isolationRefs]);

  const applyIsolationModeToLocalIds = useCallback(
    async (
      mode: "isolated" | "context" | "hidden",
      ids: Iterable<number>,
      options?: ApplyIsolationOptions,
    ) => {
      if (!engine) return false;
      const target = new Set(ids);
      const isolationState = useIsolationStore.getState();
      if (mode === "hidden" && isolationState.isolationMode === "hidden") {
        for (const id of isolationState.isolatedFragmentLocalIds) target.add(id);
      }
      if (target.size === 0) return false;
      const ok = await engine.applyIsolation(mode, target, { ...options, focus: false });
      if (ok) useIsolationStore.getState().setIsolation(mode, [...target]);
      return ok;
    },
    [engine],
  );

  const handleIsolationIsolate = useCallback(async () => {
    if (!engine) return;
    const ids = await resolveActiveIsolationLocalIds();
    if (ids.size === 0) {
      return;
    }
    await applyIsolationModeToLocalIds("isolated", ids, isolationApplyOpts);
  }, [engine, applyIsolationModeToLocalIds, resolveActiveIsolationLocalIds, isolationApplyOpts]);

  const handleIsolationContext = useCallback(async () => {
    if (!engine) return;
    const ids = await resolveActiveIsolationLocalIds();
    if (ids.size === 0) {
      return;
    }
    await applyIsolationModeToLocalIds("context", ids, isolationApplyOpts);
  }, [engine, applyIsolationModeToLocalIds, resolveActiveIsolationLocalIds, isolationApplyOpts]);

  const handleIsolationHide = useCallback(async () => {
    if (!engine) return;
    const ids = await resolveActiveIsolationLocalIds();
    if (ids.size === 0) {
      return;
    }
    await applyIsolationModeToLocalIds("hidden", ids, isolationApplyOpts);
  }, [engine, applyIsolationModeToLocalIds, resolveActiveIsolationLocalIds, isolationApplyOpts]);

  /** Same visual reset as “הצג הכל” — used from בחירה מרובה submenuאיפוס/X without requiring the isolation bar. */
  const restoreFullModelIsolationState = useCallback(async () => {
    if (!engine) return;
    useViewFilterStore.getState().exitGhostRevealMode();
    await engine.clearIsolationVisuals();
    useIsolationStore.getState().clearIsolation();
    engine.setTransparency(useAppStore.getState().transparencyEnabled);
    await reapplyViewFilterIfNeeded(engine);
  }, [engine, reapplyViewFilterIfNeeded]);

  const handleIsolationShowAll = useCallback(async () => {
    await restoreFullModelIsolationState();
    useMultiSelectStore.getState().exitMultiSelectSession();
  }, [restoreFullModelIsolationState]);

  const handleEnterMultiSelect = useCallback(async () => {
    if (!engine || viewerTool === "measurement") return;

    setElementContextPanel(null);
    if (useMultiSelectStore.getState().pickInteractionMode === "multi") {
      await restoreFullModelIsolationState();
      useMultiSelectStore.getState().exitMultiSelectSession();
      void engine.highlightFragmentLocalSet(new Set());
      setSelectionStatus("מצב בחירה רגיל");
      return;
    }

    setMarkupDrawingEnabled(false);
    useMultiSelectStore.getState().clearSelected();
    useMultiSelectStore.getState().enterMultiSelect();
    const activeIsolationIds = useIsolationStore.getState().isolatedFragmentLocalIds;
    if (isolationMode !== "none" && activeIsolationIds.length > 0) {
      useMultiSelectStore.getState().toggleLocalIds(activeIsolationIds, {
        key: `active-isolation:${isolationMode}`,
        weightKg: null,
      });
    }
    if (isolationMode === "none") {
      void engine.highlightFragmentLocalSet(new Set());
    }
    setSelectionStatus("בחירה מרובה: לחץ על אלמנטים במודל");
  }, [engine, viewerTool, isolationMode, restoreFullModelIsolationState]);

  const handleMultiIsolate = useCallback(async () => {
    if (!engine) return;
    const ids = useMultiSelectStore.getState().selectedLocalIds;
    if (ids.length === 0) return;
    await applyIsolationModeToLocalIds("isolated", ids);
  }, [engine, applyIsolationModeToLocalIds]);

  const handleMultiContext = useCallback(async () => {
    if (!engine) return;
    const ids = useMultiSelectStore.getState().selectedLocalIds;
    if (ids.length === 0) return;
    await applyIsolationModeToLocalIds("context", ids);
  }, [engine, applyIsolationModeToLocalIds]);

  const handleMultiHide = useCallback(async () => {
    if (!engine) return;
    const ids = useMultiSelectStore.getState().selectedLocalIds;
    if (ids.length === 0) return;
    await applyIsolationModeToLocalIds("hidden", ids);
  }, [engine, applyIsolationModeToLocalIds]);

  const handleMultiClear = useCallback(async () => {
    await restoreFullModelIsolationState();
    useMultiSelectStore.getState().clearSelected();
    if (engine) await engine.highlightFragmentLocalSet(new Set());
    setSelectionStatus("בחירה מרובה: איפוס — כל המודל מוצג, אפשר לבחור מחדש");
  }, [engine, restoreFullModelIsolationState]);

  const handleMultiDone = useCallback(async () => {
    await restoreFullModelIsolationState();
    useMultiSelectStore.getState().exitMultiSelectSession();
    if (engine) await engine.highlightFragmentLocalSet(new Set());
    setSelectionStatus("מצב בחירה רגיל");
  }, [engine, restoreFullModelIsolationState]);

  const handleViewerContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (
        loadingState !== "ready" ||
        viewerTool === "measurement" ||
        snapshotSessionOpen ||
        markupDrawingEnabled
      ) {
        return;
      }

      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(VIEWER_CONTEXT_MENU_EXCLUDED_SELECTOR) !== null
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (isolationMode !== "none") return;

      const ids = useMultiSelectStore.getState().selectedLocalIds;
      if (ids.length === 0) return;

      setElementContextPanel({
        clientX: event.clientX,
        clientY: event.clientY,
        isolationLocalIds: [...ids],
      });
    },
    [
      isolationMode,
      loadingState,
      markupDrawingEnabled,
      snapshotSessionOpen,
      viewerTool,
    ],
  );

  const handleElementPanelIsolate = useCallback(
    async (panel: ElementPickContextPanelState) => {
      if (!engine) return;
      const idArr = panel.isolationLocalIds;
      if (idArr.length === 0) return;
      await applyIsolationModeToLocalIds("isolated", idArr, isolationApplyOpts);
      setElementContextPanel(null);
    },
    [engine, applyIsolationModeToLocalIds, isolationApplyOpts],
  );

  const handleElementPanelContext = useCallback(
    async (panel: ElementPickContextPanelState) => {
      if (!engine) return;
      const idArr = panel.isolationLocalIds;
      if (idArr.length === 0) return;
      await applyIsolationModeToLocalIds("context", idArr, isolationApplyOpts);
      setElementContextPanel(null);
    },
    [engine, applyIsolationModeToLocalIds, isolationApplyOpts],
  );

  const handleElementPanelHide = useCallback(
    async (panel: ElementPickContextPanelState) => {
      if (!engine) return;
      const idArr = panel.isolationLocalIds;
      if (idArr.length === 0) return;
      await applyIsolationModeToLocalIds("hidden", idArr, isolationApplyOpts);
      setElementContextPanel(null);
    },
    [engine, applyIsolationModeToLocalIds, isolationApplyOpts],
  );

  const applySelectionVisuals = useCallback(
    async (refs: readonly { id: string; expressId: number | null }[]) => {
      if (!engine) return;
      await engine.highlightAnalyzerSubset(refs);
    },
    [engine],
  );

  const selectAssembly = useCallback(
    async (assembly: AnalyzerAssembly | null, opts?: { focusCamera?: boolean }) => {
      useMultiSelectStore.getState().exitMultiSelectSession();
      setElementContextPanel(null);
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
      await applySelectionVisuals(refs);
      if (focusCamera) await engine.focusAnalyzerSubset(refs);
      setActiveSheet("details");
      const partIds = new Set(assembly.parts.map((p) => p.id));
      const boltCount = assembly.bolts?.length ?? 0;
      setSelectionStatus(
        `Assembly: ${assembly.assemblyMark || assembly.name || assembly.id} (${formatCount(partIds.size)} חלקים${boltCount ? `, ${formatCount(boltCount)} ברגים` : ""})`,
      );
    },
    [
      engine,
      setActiveSheet,
      analyzerData?.assemblies,
      clearEngineSelectionPreservingViewFilter,
      applySelectionVisuals,
    ],
  );

  const selectAggregatedAssemblyRow = useCallback(
    async (row: AggregatedAssemblyRow) => {
      useMultiSelectStore.getState().exitMultiSelectSession();
      setElementContextPanel(null);
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

      await applySelectionVisuals(refs);
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
    [engine, setActiveSheet, applySelectionVisuals],
  );

  const selectProfileGroupRow = useCallback(
    async (row: AggregatedProfileTabRow) => {
      useMultiSelectStore.getState().exitMultiSelectSession();
      setElementContextPanel(null);
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
      await applySelectionVisuals(refs);
      await engine.focusAnalyzerSubset(refs);
      setActiveSheet("details");
      setSelectionStatus(`פרופיל: ${row.profileLabel} · ${formatCount(row.instances.length)} חלקים`);
    },
    [engine, setActiveSheet, applySelectionVisuals],
  );

  const selectPart = useCallback(
    async (
      part: AnalyzerIndexedEntity | null,
      opts?: { preserveProfileGroup?: boolean; focusCamera?: boolean },
    ) => {
      useMultiSelectStore.getState().exitMultiSelectSession();
      setElementContextPanel(null);
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
      await applySelectionVisuals(refs);
      if (focusCamera) await engine.focusAnalyzerSubset(refs);
      setActiveSheet("details");
      setSelectionStatus(
        isAnalyzerBoltRow(part)
          ? `בורג: ${part.boltName || part.name || part.id}`
          : `חלק: ${displayPartMark(part as AnalyzerPart)}`,
      );
    },
    [engine, setActiveSheet, clearEngineSelectionPreservingViewFilter, applySelectionVisuals],
  );

  const selectPartInstances = useCallback(
    async (instances: AnalyzerPart[]) => {
      useMultiSelectStore.getState().exitMultiSelectSession();
      setElementContextPanel(null);
      setProfileGroupDetail(null);
      setAssemblyDetailOverride(null);
      setAssemblyStructureNotice(false);
      const first = instances[0];
      if (!first) return;
      setSelectedPartId(first.id);
      setSelectedAssemblyId(null);
      if (!engine) return;
      const refs = instances.map((p) => ({ id: p.id, expressId: p.expressId }));
      await applySelectionVisuals(refs);
      await engine.focusAnalyzerSubset(refs);
      setActiveSheet("details");
      const label = displayPartMark(first);
      setSelectionStatus(
        instances.length > 1 ? `${label} · ${formatCount(instances.length)} פריטים` : `חלק: ${label}`,
      );
    },
    [engine, setActiveSheet, applySelectionVisuals],
  );

  const clearViewerSelection = useCallback(async () => {
    setElementContextPanel(null);
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

  const showOnlyProductionRefs = useCallback(
    async (
      refs: readonly { id: string; expressId: number | null }[],
      holeOverlay?: Pick<ProductionHoleOverlayInput, "visibleSteelPartIds" | "visibleSteelRefs"> & {
        /**
         * חלק mode only: the single part the user is fabricating. When set,
         * {@link ProductionHoleOverlayInput.visibleSteelPartIds} should describe the **full
         * אסמבלי context** (so the overlay places discs on natural faces exactly like
         * אסמבלי mode) and this field tells the overlay which part to actually keep discs on.
         * See {@link ProductionHoleOverlayInput.productionDisplayedSteelRefs}.
         */
        displayedSteelRefs?: readonly { id: string; expressId: number | null }[];
      },
    ) => {
      if (!engine || refs.length === 0) return false;
      /**
       * Reuse the exact ניהול isolation pipeline so materials, lighting, edge overlay and camera
       * sensitivity match the rest of the app pixel-for-pixel. We intentionally do **not** call
       * `useIsolationStore.setIsolation(...)` — that store only drives the floating "בודד /
       * הסתר / הצג בהקשר / הצג הכל" HUD, which we don't want in ייצור mode. The engine's own
       * `isolationVisualMode` still tracks the visual state internally, and the standard
       * `clearIsolationVisuals` path restores the full model when leaving ייצור.
       *
       * Pass `focus: false` so we skip `focusBboxMap` (which places the camera at
       * `bbox.diagonal × √3` from center → far too far for a single part) and instead call
       * `frameAnalyzerSubsetIso` to get the same auto-centered iso pose the model uses on first
       * load. This makes every ייצור pick snap to a clean, view-filling iso view.
       */
      useIsolationStore.getState().clearIsolation();
      const ids = await engine.resolveIsolationLocalIds(refs);
      if (ids.size === 0) {
        engine.clearProductionHoleOverlays();
        return false;
      }

      const steelIds = holeOverlay?.visibleSteelPartIds;
      /** חלק: prune isolation to the fabricated member only; אסמבלי: full visible steel set. */
      const productionVisibleSteelGuidKeys = (() => {
        const scopeIds =
          holeOverlay?.displayedSteelRefs && holeOverlay.displayedSteelRefs.length > 0
            ? holeOverlay.displayedSteelRefs.map((r) => r.id)
            : steelIds;
        if (!scopeIds || scopeIds.length === 0) return null;
        return new Set(
          scopeIds.map((id) => normalizeIfcGuidKey(id)).filter((k): k is string => !!k),
        );
      })();

      const overlayPack =
        steelIds && steelIds.length > 0 && analyzerData
          ? (() => {
              const allBolts = (analyzerData.parts ?? []).filter(isAnalyzerBoltRow);
              /** חלק uses the same assembly bolt pool as אסמבלי; discs filter to {@link productionDisplayedSteelRefs}. */
              const boltsForOverlay = analyzerBoltsForProductionHoleOverlay(
                steelIds,
                analyzerData.assemblies ?? [],
                analyzerData.boltSteelLinks,
                allBolts,
                refs,
              );
              return {
                allBolts,
                boltsForOverlay,
                input: {
                  boltSteelLinks: analyzerData.boltSteelLinks ?? [],
                  bolts: allBolts,
                  visibleSteelPartIds: steelIds,
                  isolationSteelLocalIds: [...ids],
                  ...(holeOverlay?.visibleSteelRefs && holeOverlay.visibleSteelRefs.length > 0
                    ? { visibleSteelRefs: holeOverlay.visibleSteelRefs }
                    : {}),
                  overlayBoltRows: boltsForOverlay,
                  ...(holeOverlay?.displayedSteelRefs && holeOverlay.displayedSteelRefs.length > 0
                    ? { productionDisplayedSteelRefs: holeOverlay.displayedSteelRefs }
                    : {}),
                } satisfies Parameters<ViewerEngine["primeProductionBoltAllowlistForIsolation"]>[0],
              };
            })()
          : null;

      if (overlayPack) {
        await engine.primeProductionBoltAllowlistForIsolation(overlayPack.input);
      } else {
        engine.clearProductionHoleOverlays();
      }

      const snapshotGuids = engine.getProductionBoltGuidAllowlistSnapshot();
      /**
       * Restrict isolation fasteners to the same GUID set the overlay discovered (analyzer +
       * IFC `ConnectedTo` near visible steel) — avoids floating neighbour bolts and keeps allowlist
       * in sync with red hole discs.
       */
      const ok = await engine.applyIsolation("isolated", ids, {
        focus: false,
        /** ייצור: steel + red hole discs only — strip bolt/nut/washer meshes after isolation merges. */
        hideBoltsKeepHoles: true,
        enforceProductionBoltHardwareAllowlist: true,
        ...(snapshotGuids != null && snapshotGuids.size > 0
          ? {
              boltGuidIsolationAllowlist: snapshotGuids,
              spatialBoltIsolationAllowlist: snapshotGuids,
            }
          : {}),
        ...(productionVisibleSteelGuidKeys != null && productionVisibleSteelGuidKeys.size > 0
          ? { productionVisibleSteelGuidKeys }
          : {}),
      });
      if (!ok) {
        engine.clearProductionHoleOverlays();
        return false;
      }

      if (overlayPack) {
        const visibleLocals = engine.getLastIsolatedVisibleLocals();
        /**
         * חלק: fasteners are stripped from `lastIsolatedVisibleLocals` before overlays run — do not
         * gate discs on that set or every bolt is filtered out. אסמבלי keeps the allowlist to drop
         * neighbour ghosts when the merged isolation set is wider than the assembly.
         */
        const partScopeActive =
          (holeOverlay?.displayedSteelRefs?.length ?? 0) > 0;
        await engine.showProductionHoleOverlays({
          ...overlayPack.input,
          ...(!partScopeActive && visibleLocals != null && visibleLocals.size > 0
            ? { fastenerDiscLocalIdAllowlist: visibleLocals }
            : {}),
        });
      }

      await engine.frameAnalyzerSubsetIso(refs);

      return true;
    },
    [analyzerData, engine],
  );

  const handleAppModeChange = useCallback(
    (nextMode: ProductionAppMode) => {
      if (appMode === nextMode) return;
      setMode(nextMode);
      setGlobalSearchOpen(false);
      setElementContextPanel(null);
      setFlashTooltip(null);
      setSnapshotSessionOpen(false);
      setMarkupDrawingEnabled(false);
      useAppStore.setState({ sketchModeEnabled: false });
      engine?.setSketchModeFromUI(false);
      setViewerTool("none");
      setActiveSheet("none");
      setProductionPartsDrawerOpen(false);

      if (nextMode === "production") {
        setProductionViewerOpen(false);
        setProductionSelection({ type: null, id: null });
        return;
      }

      setProductionViewerOpen(false);
      setProductionSelection({ type: null, id: null });
      /**
       * `restoreFullModelIsolationState` calls `engine.clearIsolationVisuals()`, which fully
       * resets fragment visibility, highlights and the engine's internal `isolationVisualMode`.
       * That undoes the silent isolation we applied for ייצור so ניהול resumes with the full
       * model visible.
       */
      void restoreFullModelIsolationState();
      void clearViewerSelection();
    },
    [
      appMode,
      clearViewerSelection,
      restoreFullModelIsolationState,
      setActiveSheet,
      setMode,
      setViewerTool,
      engine,
    ],
  );

  const openProductionAssembly = useCallback(
    async (row: AggregatedAssemblyRow) => {
      const primary = row.instances[0];
      if (!primary) return;
      /** Steel parts only — `assembly.bolts` preloaded unrelated fasteners into isolation. */
      const refs = analyzerSteelPartRefsFromAssembly(primary);
      setProductionSelection({ type: "assembly", id: primary.id });
      setProductionViewerOpen(true);
      setProductionPartsDrawerOpen(false);
      setGlobalSearchOpen(false);
      setActiveSheet("none");
      engine?.exitViewMode();
      useAppStore.setState({ sketchModeEnabled: false });
      engine?.setSketchModeFromUI(false);
      clearViewModeStore();
      useClippingStore.getState().setClipSectionOrthoActive(false);
      useMultiSelectStore.getState().exitMultiSelectSession();
      setElementContextPanel(null);
      setProfileGroupDetail(null);
      setAssemblyDetailOverride(null);
      setAssemblyStructureNotice(false);
      setSelectedAssemblyId(primary.id);
      setSelectedPartId(null);
      setActiveSheet("none");
      setSelectionStatus(`ייצור אסמבלי: ${row.displayMark}`);
      const visibleSteelPartIds = primary.parts.map((p) => p.id);
      const visibleSteelRefs = primary.parts.map((p) => ({ id: p.id, expressId: p.expressId }));
      await showOnlyProductionRefs(refs, {
        visibleSteelPartIds,
        visibleSteelRefs,
      });
    },
    [clearViewModeStore, engine, setActiveSheet, showOnlyProductionRefs],
  );

  const openProductionPart = useCallback(
    async (row: ProductionPartRow) => {
      const first = row.instances[0];
      if (!first) return;
      /** One IFC instance only — same rule as {@link openProductionAssembly} (not total row qty). */
      const refs = [{ id: first.id, expressId: first.expressId }];
      setProductionSelection({ type: "part", id: first.id });
      setProductionViewerOpen(true);
      setProductionPartsDrawerOpen(false);
      setGlobalSearchOpen(false);
      setActiveSheet("none");
      engine?.exitViewMode();
      useAppStore.setState({ sketchModeEnabled: false });
      engine?.setSketchModeFromUI(false);
      clearViewModeStore();
      useClippingStore.getState().setClipSectionOrthoActive(false);
      useMultiSelectStore.getState().exitMultiSelectSession();
      setElementContextPanel(null);
      setProfileGroupDetail(null);
      setAssemblyDetailOverride(null);
      setAssemblyStructureNotice(false);
      setSelectedPartId(first.id);
      setSelectedAssemblyId(null);
      setActiveSheet("none");
      setSelectionStatus(`ייצור חלק: ${row.displayMark}`);
      const assemblies = analyzerData?.assemblies ?? [];
      const assemblyMateIds = steelPartGuidsSharingAssembliesWith(first.id, assemblies);
      const parts = analyzerData?.parts ?? [];
      const visibleSteelRefs = assemblyMateIds.map((id) => {
        const nk = normalizeIfcGuidKey(id);
        const part =
          parts.find((p) => normalizeIfcGuidKey(p.id) === nk) ??
          parts.find((p) => p.id.trim() === id.trim());
        return { id, expressId: part?.expressId ?? null };
      });
      await showOnlyProductionRefs(refs, {
        visibleSteelPartIds: assemblyMateIds,
        visibleSteelRefs,
        displayedSteelRefs: [{ id: first.id, expressId: first.expressId }],
      });
    },
    [analyzerData?.assemblies, analyzerData?.parts, clearViewModeStore, engine, setActiveSheet, showOnlyProductionRefs],
  );

  const handleProductionPickAssemblyPart = useCallback(
    async (part: AnalyzerPart) => {
      if (!engine) return;
      const refs = [{ id: part.id, expressId: part.expressId }];
      await applySelectionVisuals(refs);
      await engine.focusAnalyzerSubset(refs);
      setSelectionStatus(`חלק: ${displayPartMark(part)}`);
    },
    [applySelectionVisuals, engine],
  );

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
         * Empty-canvas tap: clear normal selections only. In "בחירה מרובה" and Ctrl multi-select,
         * keep the running set so accidental misses don't wipe it; reset is available in the bottom HUD.
         */
        if (useIsolationStore.getState().isolationMode !== "none") return;
        const multiSelectState = useMultiSelectStore.getState();
        if (
          multiSelectState.pickInteractionMode === "multi" ||
          multiSelectState.selectedLocalIds.length > 0
        ) {
          return;
        }
        if (desktopMultiSelectKeyDownRef.current) return;
        await clearViewerSelection();
        return;
      }

      const highlightIds =
        typeof hit.localId === "number"
          ? [hit.localId]
          : typeof hit.itemId === "number"
            ? [hit.itemId]
            : [];
      const isContextPick = hit.button === 2;

      if (isContextPick && typeof hit.clientX === "number" && typeof hit.clientY === "number") {
        const currentSelectionRefs = selectedAssembly
          ? analyzerRefsFromAssembly(selectedAssembly)
          : selectedPart
            ? [{ id: selectedPart.id, expressId: selectedPart.expressId }]
            : (profileGroupDetail?.instances.map((p) => ({
                id: p.id,
                expressId: p.expressId,
              })) ?? []);

        if (currentSelectionRefs.length > 0) {
          const currentSelectionIds = await engine.resolveIsolationLocalIds(currentSelectionRefs);
          const hitIds = [hit.localId, hit.itemId].filter(
            (id) => typeof id === "number" && Number.isFinite(id),
          );
          if (hitIds.some((id) => currentSelectionIds.has(id))) {
            setElementContextPanel({
              clientX: hit.clientX,
              clientY: hit.clientY,
              isolationLocalIds: [...currentSelectionIds],
            });
            return;
          }
        }
      }

      const pickCtx = await engine.resolvePickMatchContext(hit);
      const guidIdx = engine.getAnalyzerGuidIndex();

      if (isContextPick) {
        setElementContextPanel(null);
        const selectedIds = useMultiSelectStore.getState().selectedLocalIds;
        if (selectedIds.length > 0) {
          if (typeof hit.clientX === "number" && typeof hit.clientY === "number") {
            setElementContextPanel({
              clientX: hit.clientX,
              clientY: hit.clientY,
              isolationLocalIds: [...selectedIds],
            });
          }
          return;
        }

        const selectedAssemblyMatchesPick =
          selectedAssembly != null &&
          (selectedAssembly.parts.some((p) =>
            analyzerEntityMatchesPick(p, pickCtx.localIds, pickCtx.guids, guidIdx),
          ) ||
            (selectedAssembly.bolts ?? []).some((b) =>
              analyzerEntityMatchesPick(b, pickCtx.localIds, pickCtx.guids, guidIdx),
            ));
        const selectedPartMatchesPick =
          selectedPart != null &&
          analyzerEntityMatchesPick(selectedPart, pickCtx.localIds, pickCtx.guids, guidIdx);
        const profileSelectionMatchesPick =
          profileGroupDetail?.instances.some((p) =>
            analyzerEntityMatchesPick(p, pickCtx.localIds, pickCtx.guids, guidIdx),
          ) ?? false;

        if (
          typeof hit.clientX === "number" &&
          typeof hit.clientY === "number" &&
          (selectedAssemblyMatchesPick || selectedPartMatchesPick || profileSelectionMatchesPick)
        ) {
          const refs = selectedAssembly
            ? analyzerRefsFromAssembly(selectedAssembly)
            : selectedPart
              ? [{ id: selectedPart.id, expressId: selectedPart.expressId }]
              : (profileGroupDetail?.instances.map((p) => ({
                  id: p.id,
                  expressId: p.expressId,
                })) ?? []);
          const ids = await engine.resolveIsolationLocalIds(refs);
          setElementContextPanel({
            clientX: hit.clientX,
            clientY: hit.clientY,
            isolationLocalIds: [...ids],
          });
          return;
        }

        if (!analyzerData) {
          if (highlightIds.length) {
            await engine.highlightItemIds(highlightIds);
            if (typeof hit.clientX === "number" && typeof hit.clientY === "number") {
              setElementContextPanel({
                clientX: hit.clientX,
                clientY: hit.clientY,
                isolationLocalIds: highlightIds,
              });
            }
          }
          setSelectionStatus(
            highlightIds.length
              ? `נבחר פריט IFC ${formatCount(highlightIds[0])} (נתוני ניתוח לא זמינים)`
              : "נבחרה נקודה במודל (נתוני ניתוח לא זמינים)",
          );
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
            if (typeof hit.clientX === "number" && typeof hit.clientY === "number") {
              const set = await engine.resolveIsolationLocalIds(analyzerRefsFromAssembly(assembly));
              setElementContextPanel({
                clientX: hit.clientX,
                clientY: hit.clientY,
                isolationLocalIds: [...set],
              });
            }
            return;
          }
        }

        const contextPart = analyzerData.parts.find((p) =>
          analyzerEntityMatchesPick(p, pickCtx.localIds, pickCtx.guids, guidIdx),
        );

        if (contextPart) {
          await selectPart(contextPart, { focusCamera: false });
          if (typeof hit.clientX === "number" && typeof hit.clientY === "number") {
            const ids = await engine.resolveIsolationLocalIds([
              { id: contextPart.id, expressId: contextPart.expressId },
            ]);
            setElementContextPanel({
              clientX: hit.clientX,
              clientY: hit.clientY,
              isolationLocalIds: [...ids],
            });
          }
          return;
        }

        const fallback = [...new Set([...pickCtx.localIds, ...highlightIds])].filter(
          (n) => typeof n === "number" && Number.isFinite(n),
        );
        if (fallback.length) {
          await engine.highlightItemIds(fallback);
          if (typeof hit.clientX === "number" && typeof hit.clientY === "number") {
            setElementContextPanel({
              clientX: hit.clientX,
              clientY: hit.clientY,
              isolationLocalIds: fallback,
            });
          }
        }
        return;
      }

      const activePickInteractionMode = useMultiSelectStore.getState().pickInteractionMode;
      const desktopMultiSelectPick =
        activePickInteractionMode !== "multi" &&
        Boolean(hit.ctrlKey || desktopMultiSelectKeyDownRef.current) &&
        loadingState === "ready" &&
        viewerTool !== "measurement" &&
        !markupDrawingEnabled &&
        !snapshotSessionOpen;

      if (
        activePickInteractionMode === "multi" ||
        desktopMultiSelectPick
      ) {
        setElementContextPanel(null);
        const toggleAndHighlight = async (
          targetIds: number[],
          weightItem?: MultiSelectWeightItem,
        ) => {
          const uniq = [...new Set(targetIds)].filter(
            (n) => typeof n === "number" && Number.isFinite(n),
          );
          if (uniq.length === 0) return;
          useMultiSelectStore.getState().toggleLocalIds(
            uniq,
            weightItem ?? {
              key: multiSelectFallbackWeightKey(uniq),
              weightKg: null,
            },
          );
          const sel = useMultiSelectStore.getState().selectedLocalIds;
          await engine.highlightFragmentLocalSet(new Set(sel));
          setSelectionStatus(`בחירה מרובה: ${formatCount(sel.length)} אלמנטים`);
        };

        const seedCurrentDesktopSelection = async () => {
          if (!desktopMultiSelectPick || useMultiSelectStore.getState().selectedLocalIds.length > 0) {
            return;
          }
          if (selectedAssembly) {
            const ids = await engine.resolveIsolationLocalIds(analyzerRefsFromAssembly(selectedAssembly));
            if (ids.size > 0) {
              useMultiSelectStore.getState().toggleLocalIds([...ids], {
                key: `assembly:${selectedAssembly.id}`,
                weightKg: selectedAssembly.weightKg,
              });
            }
            return;
          }
          if (selectedPart) {
            const ids = await engine.resolveIsolationLocalIds([
              { id: selectedPart.id, expressId: selectedPart.expressId },
            ]);
            if (ids.size > 0) {
              useMultiSelectStore.getState().toggleLocalIds([...ids], {
                key: `${isAnalyzerBoltRow(selectedPart) ? "bolt" : "part"}:${selectedPart.id}`,
                weightKg: isAnalyzerBoltRow(selectedPart) ? null : selectedPart.weightKg,
              });
            }
            return;
          }
          if (profileGroupDetail?.instances.length) {
            const refs = profileGroupDetail.instances.map((p) => ({
              id: p.id,
              expressId: p.expressId,
            }));
            const ids = await engine.resolveIsolationLocalIds(refs);
            if (ids.size > 0) {
              const totalWeight = profileGroupDetail.instances.reduce((sum, p) => {
                const weight = p.weightKg;
                return weight == null || Number.isNaN(weight) ? sum : sum + weight;
              }, 0);
              useMultiSelectStore.getState().toggleLocalIds([...ids], {
                key: `profile:${profileGroupDetail.profileLabel}`,
                weightKg: totalWeight,
              });
            }
          }
        };

        if (desktopMultiSelectPick) {
          await seedCurrentDesktopSelection();
          setAssemblyStructureNotice(false);
          setAssemblyDetailOverride(null);
          setSelectedAssemblyId(null);
          setSelectedPartId(null);
          setProfileGroupDetail(null);
        }

        const pickedSelectedWeightItem = useMultiSelectStore
          .getState()
          .selectedWeightItems.find((item) =>
            (item.localIds ?? []).some((id) => pickCtx.localIds.includes(id)),
          );
        if (pickedSelectedWeightItem?.localIds?.length) {
          await toggleAndHighlight(pickedSelectedWeightItem.localIds, pickedSelectedWeightItem);
          return;
        }

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
            await toggleAndHighlight([...set], {
              key: `assembly:${assembly.id}`,
              weightKg: assembly.weightKg,
            });
            return;
          }
        }

        const part = analyzerData.parts.find((p) =>
          analyzerEntityMatchesPick(p, pickCtx.localIds, pickCtx.guids, guidIdx),
        );

        if (part) {
          const set = await engine.resolveIsolationLocalIds([{ id: part.id, expressId: part.expressId }]);
          await toggleAndHighlight([...set], {
            key: `${isAnalyzerBoltRow(part) ? "bolt" : "part"}:${part.id}`,
            weightKg: isAnalyzerBoltRow(part) ? null : part.weightKg,
          });
          return;
        }

        const fallback = [...new Set([...pickCtx.localIds, ...highlightIds])].filter(
          (n) => typeof n === "number" && Number.isFinite(n),
        );
        if (fallback.length) await toggleAndHighlight(fallback);
        else setSelectionStatus("בחירה מרובה: לא נמצאה התאמה לנקודת המגע");
        return;
      }

      setElementContextPanel(null);

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
    applyIsolationModeToLocalIds,
    loadingState,
    markupDrawingEnabled,
    profileGroupDetail,
    selectedAssembly,
    selectedPart,
    snapshotSessionOpen,
    viewerTool,
  ]);

  useEffect(() => {
    if (
      !engine ||
      !analyzerData ||
      loadingState !== "ready" ||
      viewerTool !== "flash" ||
      snapshotSessionOpen ||
      markupDrawingEnabled
    ) {
      queueMicrotask(() => setFlashTooltip(null));
      return;
    }

    let disposed = false;
    let timer: number | null = null;
    let requestSeq = 0;
    let latestEvent: PointerEvent | null = null;

    const clearTimer = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const clearTooltip = () => {
      clearTimer();
      latestEvent = null;
      requestSeq += 1;
      setFlashTooltip(null);
    };

    const resolveHover = async (event: PointerEvent, seq: number) => {
      const hit = await engine.pickAtClientPoint(event.clientX, event.clientY);
      if (disposed || seq !== requestSeq) return;
      if (!hit) {
        setFlashTooltip(null);
        return;
      }

      const pickCtx = await engine.resolvePickMatchContext(hit);
      if (disposed || seq !== requestSeq) return;
      const guidIdx = engine.getAnalyzerGuidIndex();
      const { x, y } = flashTooltipPosition(event.clientX, event.clientY);

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
          setFlashTooltip({
            x,
            y,
            kind: "assembly",
            title: displayAssemblyMark(assembly),
            rows: assemblyFlashRows(assembly, analyzerData.assemblies),
          });
          return;
        }
      }

      const part = analyzerData.parts.find(
        (p): p is AnalyzerPart =>
          !isAnalyzerBoltRow(p) &&
          analyzerEntityMatchesPick(p, pickCtx.localIds, pickCtx.guids, guidIdx),
      );
      if (part) {
        setFlashTooltip({
          x,
          y,
          kind: "part",
          title: displayPartMark(part),
          rows: partFlashRows(part, steelPartsAll),
        });
        return;
      }

      const bolt = analyzerData.parts.find(
        (p): p is AnalyzerBoltRow =>
          isAnalyzerBoltRow(p) &&
          analyzerEntityMatchesPick(p, pickCtx.localIds, pickCtx.guids, guidIdx),
      );
      if (!bolt) {
        setFlashTooltip(null);
        return;
      }

      setFlashTooltip({
        x,
        y,
        kind: "bolt",
        title: bolt.boltName || bolt.name || "בורג",
        rows: boltFlashRows(bolt),
      });
      return;
    };

    const scheduleHover = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== "mouse") {
        clearTooltip();
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest(VIEWER_CONTEXT_MENU_EXCLUDED_SELECTOR)) {
        clearTooltip();
        return;
      }

      latestEvent = event;
      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        const current = latestEvent;
        if (!current) return;
        const seq = ++requestSeq;
        void resolveHover(current, seq);
      }, 80);
    };

    window.addEventListener("pointermove", scheduleHover, { passive: true });
    window.addEventListener("pointerleave", clearTooltip);
    return () => {
      disposed = true;
      clearTimer();
      window.removeEventListener("pointermove", scheduleHover);
      window.removeEventListener("pointerleave", clearTooltip);
      setFlashTooltip(null);
    };
  }, [
    analyzerData,
    engine,
    hasRealIfcAssemblies,
    loadingState,
    markupDrawingEnabled,
    selectionMode,
    snapshotSessionOpen,
    steelPartsAll,
    viewerTool,
  ]);

  const handleMarkupDrawingToggle = useCallback(() => {
    setMarkupDrawingEnabled((prev) => {
      const next = !prev;
      if (next) {
        setElementContextPanel(null);
        if (viewerTool === "measurement") {
          setViewerTool("none");
        }
        if (viewerTool === "flash") {
          setViewerTool("none");
          setFlashTooltip(null);
        }
        if (useAppStore.getState().sketchModeEnabled) {
          useAppStore.setState({ sketchModeEnabled: false });
          engine?.setSketchModeFromUI(false);
        }
      }
      return next;
    });
  }, [engine, viewerTool, setViewerTool]);

  const handleMarkupDrawingClear = useCallback(() => {
    setDrawingClearSignal((n) => n + 1);
  }, []);

  const clearSnapshotTimers = useCallback(() => {
    if (snapshotCopyTimerRef.current) {
      clearTimeout(snapshotCopyTimerRef.current);
      snapshotCopyTimerRef.current = null;
    }
  }, []);

  const closeSnapshotSession = useCallback(() => {
    clearSnapshotTimers();
    setSnapshotCopyToast(false);
    snapshotBlobRef.current = null;
    setSnapshotSessionOpen(false);
    setSnapshotCapturePending(false);
    setMarkupDrawingEnabled(false);
  }, [clearSnapshotTimers]);

  useEffect(() => {
    return () => {
      clearSnapshotTimers();
    };
  }, [clearSnapshotTimers]);

  useEffect(() => {
    if (!snapshotSessionOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSnapshotSession();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snapshotSessionOpen, closeSnapshotSession]);

  const startSnapshotSession = useCallback(() => {
    if (!engine || loadingState !== "ready" || viewerTool === "measurement") return;
    if (snapshotSessionOpen || snapshotCapturePending) return;
    setElementContextPanel(null);
    clearSnapshotTimers();
    snapshotBlobRef.current = null;
    setSnapshotSessionOpen(true);
  }, [
    engine,
    loadingState,
    viewerTool,
    snapshotSessionOpen,
    snapshotCapturePending,
    clearSnapshotTimers,
  ]);

  const captureSnapshotBlob = useCallback(async () => {
    if (!engine || snapshotCapturePending) return null;
    const webgl = engine.getViewCanvas();
    if (!webgl) return null;

    setSnapshotCapturePending(true);
    try {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));

      const markupCanvas = markupLayerRef.current?.getMarkupCanvas() ?? null;
      const sidePanel = sidePanelSnapshotRef.current;
      const blob = await compositeViewerSnapshotPngBlob(
        webgl,
        markupCanvas,
        sidePanel ? [sidePanel] : [],
      );
      snapshotBlobRef.current = blob;
      return blob;
    } finally {
      setSnapshotCapturePending(false);
    }
  }, [engine, snapshotCapturePending]);

  const handleSnapshotCopyFromSession = useCallback(async () => {
    const blob = await captureSnapshotBlob();
    if (!blob) return;
    clearSnapshotTimers();
    const ok = await copyImageBlobToClipboard(blob);
    snapshotBlobRef.current = null;
    setSnapshotSessionOpen(false);
    setSnapshotCapturePending(false);
    setMarkupDrawingEnabled(false);
    setDrawingClearSignal((n) => n + 1);
    if (ok) {
      setSnapshotCopyToast(true);
      snapshotCopyTimerRef.current = setTimeout(() => {
        snapshotCopyTimerRef.current = null;
        setSnapshotCopyToast(false);
      }, 2500);
    }
  }, [captureSnapshotBlob, clearSnapshotTimers]);

  const handleSnapshotDownloadFromSession = useCallback(async () => {
    const blob = await captureSnapshotBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eyesteel-view-${Date.now()}.png`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closeSnapshotSession();
    setDrawingClearSignal((n) => n + 1);
  }, [captureSnapshotBlob, closeSnapshotSession]);

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
    <main
      className="relative h-screen w-screen overflow-hidden"
      onContextMenu={handleViewerContextMenu}
    >
      <div className="absolute inset-0 z-0">
        <ViewerCanvas onReady={onReady} />
      </div>
      {loadingState === "ready" && (
        <DrawingMarkupLayer
          ref={markupLayerRef}
          active={markupDrawingEnabled}
          clearSignal={drawingClearSignal}
          elevated={snapshotSessionOpen}
        />
      )}

      {snapshotSessionOpen ? (
        <div
          className="pointer-events-auto fixed inset-0 z-[45] bg-transparent"
          aria-modal="true"
          role="dialog"
          aria-label="מצב צילום מסך — בחר העתקה, הורדה או סגירה בתפריט התחתון"
        />
      ) : null}

      <ViewerSnapshotToasts copyToastVisible={snapshotCopyToast} />

      <ProductionModeOverlay
        visible={appMode === "production"}
        viewerOpen={productionViewerOpen}
        loading={loadingState !== "ready" || !analyzerData}
        tab={productionTab}
        search={productionSearch}
        assemblyRows={productionAssemblyRows}
        partRows={productionPartRows}
        selectedAssembly={selectedAssembly}
        partsDrawerOpen={productionPartsDrawerOpen}
        onTabChange={setProductionTab}
        onSearchChange={setProductionSearch}
        onPickAssembly={(row) => void openProductionAssembly(row)}
        onPickPart={(row) => void openProductionPart(row)}
        onPartsDrawerClose={() => setProductionPartsDrawerOpen(false)}
        onPickAssemblyPart={(part) => void handleProductionPickAssemblyPart(part)}
      />

      <div
        className="pointer-events-auto absolute inset-x-0 top-0 z-40 flex h-10 items-center justify-between border-b border-zinc-300/80 bg-[#e8ecef] px-3 pt-[env(safe-area-inset-top)] shadow-[0_8px_22px_rgba(39,39,42,0.07)]"
        dir="ltr"
      >
        <Button
          variant="ghost"
          className="h-8 gap-1 rounded-md px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-200/80 hover:text-zinc-950"
          onClick={() => router.push("/")}
          dir="ltr"
        >
          <MoveLeft className="size-3.5" aria-hidden />
          <span dir="rtl">חזרה</span>
        </Button>

        {multiSelectedCount > 0 ? (
          <div
            className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 text-xs font-medium text-zinc-700"
            dir="rtl"
            role="status"
            aria-live="polite"
            aria-label={`משקל כללי ${formatKgPlain(multiSelectTotalWeightKg)} קילוגרם`}
          >
            <span className="text-zinc-500">משקל כללי</span>
            <span className="h-1 w-1 rounded-full bg-zinc-400/80" aria-hidden />
            <span className="inline-flex flex-row items-center gap-1 font-semibold text-zinc-900" dir="ltr">
              <span>ק״ג</span>
              <span>{formatKgPlain(multiSelectTotalWeightKg)}</span>
            </span>
          </div>
        ) : null}

        <div className="min-w-0 max-w-[65vw] truncate text-right text-xs font-medium text-zinc-700" dir="ltr">
          {file?.name ?? ""}
        </div>
      </div>

      <div className="pointer-events-auto absolute left-3 top-[3.25rem] z-30 max-w-[70vw] text-xs text-red-400 safe-top">
        {loadingState === "error" ? "שגיאה בטעינת IFC" : ""}
      </div>

      {elementContextPanel &&
        appMode === "management" &&
        !snapshotSessionOpen &&
        viewerTool !== "measurement" &&
        viewerTool !== "flash" &&
        pickInteractionMode !== "multi" &&
        !markupDrawingEnabled && (
          <ElementPickContextPanel
            state={elementContextPanel}
            onIsolate={() => void handleElementPanelIsolate(elementContextPanel)}
            onContext={() => void handleElementPanelContext(elementContextPanel)}
            onHide={() => void handleElementPanelHide(elementContextPanel)}
          />
        )}

      {flashTooltip && appMode === "management" && viewerTool === "flash" && !snapshotSessionOpen && !markupDrawingEnabled ? (
        <div
          className="pointer-events-none fixed z-[55] w-[17.5rem] rounded-2xl border border-zinc-300/90 bg-white/95 p-3 text-zinc-800 shadow-[0_18px_45px_rgba(39,39,42,0.22)] ring-1 ring-white/70 backdrop-blur-md"
          style={{ left: flashTooltip.x, top: flashTooltip.y }}
          dir="rtl"
          role="tooltip"
        >
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-zinc-200 pb-2">
            <div>
              <p className="inline-flex items-center gap-1.5 text-[10px] font-bold text-[#003CFF]">
                {flashTooltip.kind === "assembly" ? (
                  <SquaresUnite className="size-3.5" aria-hidden />
                ) : flashTooltip.kind === "bolt" ? (
                  <Bolt className="size-3.5" aria-hidden />
                ) : (
                  <SquaresIntersect className="size-3.5" aria-hidden />
                )}
                {flashTooltip.kind === "assembly" ? "אסמבלי" : flashTooltip.kind === "bolt" ? "בורג" : "חלק"}
              </p>
              <p className="mt-0.5 truncate text-sm font-bold text-zinc-950">{flashTooltip.title}</p>
            </div>
          </div>
          <dl className="space-y-1.5 text-[11px]">
            {flashTooltip.rows.map((row) => (
              <div key={row.label} className="flex items-start justify-between gap-3">
                <dt className="shrink-0 font-semibold text-zinc-500">{row.label}</dt>
                <dd className="min-w-0 truncate text-left font-semibold text-zinc-900" dir="auto">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <ViewerBottomDock
        appMode={appMode}
        onAppModeChange={handleAppModeChange}
        modeSwitcherOnly={appMode === "production"}
        selectionMode={selectionMode}
        onSelectionModeChange={handleDockSelectionMode}
        onDashboard={toggleDashboardSheet}
        dashboardSheetOpen={activeSheet === "details"}
        onViewFilter={
          loadingState === "ready" && analyzerData ? toggleFilterSheet : undefined
        }
        filterSheetOpen={activeSheet === "filter"}
        hideFastenersKeepHoles={hideAllFastenersKeepHoles}
        onToggleHideFastenersKeepHoles={
          loadingState === "ready" ? toggleHideAllFastenersKeepHoles : undefined
        }
        onGlobalSearch={
          loadingState === "ready" && analyzerData ? () => setGlobalSearchOpen(true) : undefined
        }
        onSnapshot={
          loadingState === "ready" ? () => void startSnapshotSession() : undefined
        }
        snapshotSessionOpen={snapshotSessionOpen}
        snapshotCapturePending={snapshotCapturePending}
        onSnapshotCopy={
          loadingState === "ready" ? () => void handleSnapshotCopyFromSession() : undefined
        }
        onSnapshotDownload={
          loadingState === "ready" ? handleSnapshotDownloadFromSession : undefined
        }
        onSnapshotDismiss={
          loadingState === "ready" ? closeSnapshotSession : undefined
        }
        onResetView={loadingState === "ready" ? handleResetView : undefined}
        measurementActive={viewerTool === "measurement"}
        onMeasurementToggle={toggleMeasurementTool}
        onMeasurementClear={() => engine?.clearMeasurements()}
        onMeasurementFinish={finishMeasurementTool}
        flashActive={viewerTool === "flash"}
        flashDisabled={
          loadingState !== "ready" ||
          viewerTool === "measurement" ||
          markupDrawingEnabled ||
          !analyzerData
        }
        onFlashToggle={loadingState === "ready" && analyzerData ? toggleFlashTool : undefined}
        onApplyViewMode={handleApplyViewMode}
        activeViewMode={viewMode === "none" ? undefined : viewMode}
        appliedViewMode={viewMode === "none" ? undefined : viewMode}
        onExitAppliedView={handleExitViewMode}
        viewModeDisabled={
          viewerTool === "measurement" || loadingState !== "ready"
        }
        sketchModeActive={sketchModeEnabled}
        onSketchToggle={handleSketchToggle}
        sketchDisabled={loadingState !== "ready" || markupDrawingEnabled}
        clippingDisabled={loadingState !== "ready"}
        onPickClippingDirection={handlePickClippingDirection}
        appliedClippingDirection={
          loadingState === "ready" && clipSnap.active && clipSnap.direction
            ? clipSnap.direction
            : undefined
        }
        clippingHud={
          loadingState === "ready" &&
          clipSnap.active &&
          !!clipSnap.labelHe
            ? {
                snapshot: clipSnap,
                onDepthChange: handleClippingDepth,
                onFlip: handleClippingFlip,
                onSectionViewToggle: handleClippingSectionViewToggle,
                onCancel: handleClippingCancel,
              }
            : undefined
        }
        multiSelectActive={pickInteractionMode === "multi"}
        multiSelectEnterDisabled={
          loadingState !== "ready" ||
          viewerTool === "measurement" ||
          viewerTool === "flash" ||
          markupDrawingEnabled
        }
        multiSelectIsolationBlocksEnter={false}
        multiSelectHud={
          pickInteractionMode === "multi" &&
          loadingState === "ready"
            ? {
                selectedCount: multiSelectedCount,
                disabled: !engine || viewerTool === "measurement" || viewerTool === "flash",
                onIsolate: () => void handleMultiIsolate(),
                onContext: () => void handleMultiContext(),
                onHide: () => void handleMultiHide(),
                onClear: () => void handleMultiClear(),
                onDone: () => void handleMultiDone(),
              }
            : undefined
        }
        elementIsolationHud={
          pickInteractionMode !== "multi" &&
          isolationMode !== "none" &&
          loadingState === "ready" &&
          !snapshotSessionOpen &&
          !markupDrawingEnabled
            ? {
                isolationMode,
                disabled: !engine || viewerTool === "measurement" || viewerTool === "flash",
                onIsolate: () => void handleIsolationIsolate(),
                onContext: () => void handleIsolationContext(),
                onHide: () => void handleIsolationHide(),
                onShowAll: () => void handleIsolationShowAll(),
              }
            : undefined
        }
        onMultiSelectEnter={handleEnterMultiSelect}
        markupDrawingActive={markupDrawingEnabled}
        markupDrawingDisabled={loadingState !== "ready" || viewerTool === "measurement" || viewerTool === "flash"}
        onMarkupDrawingToggle={
          loadingState === "ready" ? handleMarkupDrawingToggle : undefined
        }
        onMarkupDrawingClear={
          loadingState === "ready" ? handleMarkupDrawingClear : undefined
        }
      />


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

      {appMode === "management" && showFilterPanel && (
        <div
          ref={sidePanelSnapshotRef}
          className={`pointer-events-none absolute right-0 z-30 flex ${VIEWER_TOP_STRIP_RESERVE} ${VIEWER_BOTTOM_STRIP_RESERVE}`}
        >
          <aside
            className={VIEWER_SIDE_PANEL_CHROME}
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

      {appMode === "management" && showDataPanel && (
        <div
          ref={sidePanelSnapshotRef}
          className={`pointer-events-none absolute right-0 z-30 flex ${VIEWER_TOP_STRIP_RESERVE} ${VIEWER_BOTTOM_STRIP_RESERVE}`}
        >
          <aside
            className={VIEWER_SIDE_PANEL_CHROME}
            dir="rtl"
          >
          <div className="relative mb-4 flex min-h-8 items-center justify-between gap-3 pb-1">
            <div className="flex min-w-0 items-center gap-2">
              {selectedAssembly ? (
                <SquaresUnite className="size-5 shrink-0 text-zinc-600" aria-hidden />
              ) : selectedPart ? (
                <SquaresIntersect className="size-5 shrink-0 text-zinc-600" aria-hidden />
              ) : (
                <LayoutList className="size-5 shrink-0 text-zinc-600" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-zinc-950">
                  {selectedAssembly
                    ? selectedAssembly.assemblyMark ||
                      selectedAssembly.name ||
                      selectedAssembly.tag ||
                      "הרכבה"
                    : selectedPart
                      ? isAnalyzerBoltRow(selectedPart)
                        ? selectedPart.boltName || selectedPart.name || "בורג"
                        : displayPartMark(selectedPart as AnalyzerPart)
                    : "דאשבורד"}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="absolute left-0 top-1/2 size-8 -translate-y-1/2 rounded-full text-zinc-500 hover:bg-zinc-200 hover:text-zinc-950"
              onClick={() => {
                if (selectedAssembly) {
                  void selectAssembly(null);
                  return;
                }
                if (selectedPart) {
                  void selectPart(null);
                  return;
                }
                setAssemblyStructureNotice(false);
                setActiveSheet("none");
              }}
              aria-label={
                selectedAssembly
                  ? "חזרה לרשימת אמסבלי"
                  : selectedPart
                    ? "חזרה לרשימה"
                    : "סגור דאשבורד"
              }
            >
              {selectedAssembly || selectedPart ? (
                <MoveLeft className="size-4" aria-hidden />
              ) : (
                <X className="size-4" aria-hidden />
              )}
            </Button>
          </div>

          <div
            className={`${VIEWER_SIDE_PANEL_SCROLL} min-h-0 flex-1 overflow-auto p-1.5`}
          >
            {assemblyStructureNotice ? (
              <p className="px-1 text-sm leading-relaxed text-zinc-700">{ASSEMBLY_STRUCTURE_NOTICE_HE}</p>
            ) : selectedAssembly ? (
              <AssemblyPickDetailPanel
                assembly={selectedAssembly}
                allAssemblies={analyzerData?.assemblies ?? []}
                onSelectPartInstances={(instances) => void selectPartInstances(instances)}
              />
            ) : selectedPart ? (
              <PartPickDetailPanel
                entity={selectedPart}
                allSteelParts={steelPartsAll}
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
                <div className="mb-2 flex gap-1 rounded-xl border border-zinc-300 bg-zinc-200/70 p-1">
                  <button
                    type="button"
                    className={`flex-1 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                      modelDataTab === "assemblies"
                        ? "bg-white text-zinc-950 shadow-sm"
                        : "text-zinc-600 hover:bg-white/70"
                    }`}
                    onClick={() => setModelDataTab("assemblies")}
                  >
                    אמסבלי
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                      modelDataTab === "parts"
                        ? "bg-white text-zinc-950 shadow-sm"
                        : "text-zinc-600 hover:bg-white/70"
                    }`}
                    onClick={() => setModelDataTab("parts")}
                  >
                    חלקים
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                      modelDataTab === "profiles"
                        ? "bg-white text-zinc-950 shadow-sm"
                        : "text-zinc-600 hover:bg-white/70"
                    }`}
                    onClick={() => setModelDataTab("profiles")}
                  >
                    פרופילים
                  </button>
                </div>

                {modelDataTab === "assemblies" && (
                  <table className="w-full text-xs">
                    <thead className="sticky -top-1.5 z-10 bg-[#eef1f3] text-[10px] text-zinc-500">
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
                          className="cursor-pointer border-t border-zinc-200 hover:bg-zinc-200/70"
                        >
                          <td className="p-2 font-medium text-zinc-900">{row.displayMark}</td>
                          <td className="p-2 text-zinc-700">{formatCount(row.qty)}</td>
                          <td className="whitespace-nowrap p-2 text-zinc-700">
                            <span dir="ltr">{formatKgPlain(row.totalWeightKg)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {modelDataTab === "parts" && (
                  <>
                    <table className="w-full text-xs">
                      <thead className="sticky -top-1.5 z-10 bg-[#eef1f3] text-[10px] text-zinc-500">
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
                            className="cursor-pointer border-t border-zinc-200 hover:bg-zinc-200/70"
                          >
                            <td className="p-2 font-medium text-zinc-900">{row.displayMark}</td>
                            <td className="p-2 text-zinc-700">
                              {row.displayProfile === "ללא שם" ? (
                                row.displayProfile
                              ) : (
                                <span dir="ltr" className="inline-block text-right">
                                  {row.displayProfile}
                                </span>
                              )}
                            </td>
                            <td className="p-2 text-zinc-700">{formatQuantityInt(row.effectiveQty)}</td>
                            <td className="whitespace-nowrap p-2 text-zinc-700">
                              <span dir="ltr">{formatKgPlain(row.totalWeightKg)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {modelDataTab === "profiles" && (
                  <>
                    <table className="w-full text-xs">
                      <thead className="sticky -top-1.5 z-10 bg-[#eef1f3] text-[10px] text-zinc-500">
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
                            className="cursor-pointer border-t border-zinc-200 hover:bg-zinc-200/70"
                          >
                            <td className="p-2 font-medium text-zinc-900">
                              {row.profileLabel === "ללא שם" ? (
                                row.profileLabel
                              ) : (
                                <span dir="ltr" className="inline-block text-right">
                                  {row.profileLabel}
                                </span>
                              )}
                            </td>
                            <td className="p-2 text-zinc-700">{formatCount(row.totalQty)}</td>
                            <td className="whitespace-nowrap p-2 text-zinc-700">
                              <span dir="ltr">{formatKgPlain(row.totalWeightKg)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
