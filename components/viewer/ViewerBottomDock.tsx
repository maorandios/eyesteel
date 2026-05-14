"use client";

import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  VIEW_MODE_LABELS_HE,
  VIEW_MODE_ORDER,
  type ViewModeId,
} from "@/lib/viewer/view-mode-presets";
import {
  DockSubmenuBar,
  DockSubmenuPill,
} from "@/components/viewer/dock-submenu";
import { ClippingHudRow } from "@/components/viewer/ClippingHudRow";
import { MultiSelectActionBar, type MultiSelectHudProps } from "@/components/viewer/MultiSelectActionBar";
import {
  CLIPPING_DIRECTION_ORDER,
  CLIPPING_LABELS_HE,
  type ClippingDirectionId,
  type ViewerClippingUiSnapshot,
} from "@/lib/viewer/clipping-presets";
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Binoculars,
  Blend,
  Bolt,
  Camera,
  CircleX,
  EyeOff,
  ImageDown,
  Images,
  FoldHorizontal,
  Frame,
  Funnel,
  Fullscreen,
  LayoutList,
  Layers2,
  Hammer,
  Pencil,
  RotateCcw,
  RulerDimensionLine,
  Scan,
  Search,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { IsolationMode } from "@/lib/state/isolation-store";

type SelectionMode = "part" | "assembly";
type AppMode = "management" | "production";

export type ElementIsolationHudProps = {
  isolationMode: IsolationMode;
  disabled?: boolean;
  onIsolate: () => void;
  onContext: () => void;
  onHide: () => void;
  onShowAll: () => void;
};

const dockLabelClass =
  "max-w-[3.625rem] text-center text-[9px] font-medium leading-tight tracking-tight text-zinc-600 sm:max-w-[4.375rem] sm:text-[11px]";

const dockMainIconActive = "[&_svg]:!text-[#003CFF]";

/** Ghost tile: icon + Hebrew label, no outline (outer menu pill provides chrome). */
function DockPillButton({
  label,
  children,
  className,
  labelClassName,
  submenuOpen,
  ...props
}: {
  label: string;
  children: ReactNode;
  submenuOpen?: boolean;
  labelClassName?: string;
} & ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="default"
      className={cn(
        "h-auto min-h-0 w-[3.875rem] shrink-0 flex-col gap-1 rounded-full border-0 bg-transparent px-0.5 py-1.5 font-normal tracking-normal text-zinc-700 shadow-none ring-0 outline-none outline-offset-0 sm:w-[4.5rem] sm:gap-1 sm:px-1 sm:py-2",
        "hover:bg-zinc-200/80 hover:text-zinc-950 hover:outline-none active:scale-[0.99] disabled:pointer-events-none disabled:opacity-40 [&_svg]:shrink-0 [&_svg]:text-zinc-700",
        "focus-visible:ring-2 focus-visible:ring-zinc-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#e8ecef]",
        className,
      )}
      {...props}
    >
      <span
        data-slot="icon-row"
        className={cn(
          "flex min-h-[1.35rem] items-center justify-center gap-0.5 [&_svg]:size-[1.25rem] sm:[&_svg]:size-[1.35rem]",
          submenuOpen && dockMainIconActive,
        )}
      >
        {children}
      </span>
      <span className={cn(dockLabelClass, labelClassName)}>{label}</span>
    </Button>
  );
}

function ViewPresetIcon({
  mode,
  iconClassName,
}: {
  mode: ViewModeId;
  /** Merged onto each lucide glyph (e.g. active color). */
  iconClassName?: string;
}) {
  const sz = cn("size-[1.05rem] shrink-0 sm:size-[1.15rem]", iconClassName);
  switch (mode) {
    case "left":
      return <ArrowLeftToLine className={sz} aria-hidden />;
    case "right":
      return <ArrowRightToLine className={sz} aria-hidden />;
    case "top":
      return <ArrowUpToLine className={sz} aria-hidden />;
    case "bottom":
      return <ArrowDownToLine className={sz} aria-hidden />;
    case "front":
      return <ArrowLeftToLine className={cn(sz, "rotate-90")} aria-hidden />;
    case "back":
      return <ArrowLeftToLine className={cn(sz, "-rotate-90")} aria-hidden />;
  }
}

interface Props {
  appMode?: AppMode;
  onAppModeChange?: (mode: AppMode) => void;
  modeSwitcherOnly?: boolean;
  selectionMode: SelectionMode;
  onSelectionModeChange: (mode: SelectionMode) => void;
  onDashboard: () => void;
  /** When the details side panel is open (blue dock icon). */
  dashboardSheetOpen?: boolean;
  onViewFilter?: () => void;
  /** When the filter side panel is open (blue dock icon). */
  filterSheetOpen?: boolean;
  /** הבורג: hide mechanical fasteners globally; openings/voids stay visible */
  hideFastenersKeepHoles?: boolean;
  onToggleHideFastenersKeepHoles?: () => void;
  onGlobalSearch?: () => void;
  measurementActive: boolean;
  onMeasurementToggle: () => void;
  onMeasurementClear: () => void;
  onMeasurementFinish: () => void;
  flashActive?: boolean;
  flashDisabled?: boolean;
  onFlashToggle?: () => void;
  onApplyViewMode: (mode: ViewModeId) => void;
  /** Current orthographic preset (for sub-menu highlight); omit when not in a preset. */
  activeViewMode?: ViewModeId;
  /** Applied orthographic view: shows cancel banner in same sub-menu column as picker. */
  appliedViewMode?: ViewModeId;
  onExitAppliedView?: () => void;
  /** Active clipping plane: main dock shows `חתך: …`. Cancel lives in clipping HUD pill. */
  appliedClippingDirection?: ClippingDirectionId;
  /** When clipping is on, anchored in this dock column (same gap-5 as other submenus). */
  clippingHud?: {
    snapshot: ViewerClippingUiSnapshot;
    onDepthChange: (value: number) => void;
    onFlip: () => void;
    onSectionViewToggle: () => void;
    onCancel: () => void;
  };
  viewModeDisabled?: boolean;
  sketchModeActive: boolean;
  onSketchToggle: () => void;
  sketchDisabled?: boolean;
  clippingDisabled?: boolean;
  onPickClippingDirection: (direction: ClippingDirectionId) => void;
  multiSelectActive?: boolean;
  /** Guards starting בחירה מרובה (loading/measure/markup); does not include isolation. */
  multiSelectEnterDisabled?: boolean;
  /**
   * When true and בחירה מרובה not active yet, disables the dock tile — allows staying in session after isolation.
   */
  multiSelectIsolationBlocksEnter?: boolean;
  onMultiSelectEnter?: () => void;
  /** When בחירה מרובה session is active, pill HUD above main dock (same chrome as clipping). */
  multiSelectHud?: MultiSelectHudProps;
  /** Active picked-element isolation/context controls, shown above the main dock. */
  elementIsolationHud?: ElementIsolationHudProps;
  markupDrawingActive?: boolean;
  markupDrawingDisabled?: boolean;
  onMarkupDrawingToggle?: () => void;
  onMarkupDrawingClear?: () => void;
  /** Starts capture; when {@link snapshotSessionOpen} the main tile is inactive until the session ends. */
  onSnapshot?: () => void;
  snapshotSessionOpen?: boolean;
  snapshotCapturePending?: boolean;
  onSnapshotCopy?: () => void;
  onSnapshotDownload?: () => void;
  onSnapshotDismiss?: () => void;
  /** איזומטריה ראשונית כמו בטעינת הקובץ */
  onResetView?: () => void;
}

/**
 * Primary viewer chrome: dashboard, element mode drop‑up, measurement (+ breakdown panel).
 */
export function ViewerBottomDock({
  appMode = "management",
  onAppModeChange,
  modeSwitcherOnly = false,
  selectionMode,
  onSelectionModeChange,
  onDashboard,
  dashboardSheetOpen = false,
  onViewFilter,
  filterSheetOpen = false,
  hideFastenersKeepHoles = false,
  onToggleHideFastenersKeepHoles,
  onGlobalSearch,
  measurementActive,
  onMeasurementToggle,
  onMeasurementClear,
  onMeasurementFinish,
  flashActive = false,
  flashDisabled = false,
  onFlashToggle,
  onApplyViewMode,
  activeViewMode,
  appliedViewMode,
  onExitAppliedView,
  appliedClippingDirection,
  clippingHud,
  viewModeDisabled = false,
  sketchModeActive,
  onSketchToggle,
  sketchDisabled = false,
  clippingDisabled = false,
  onPickClippingDirection,
  multiSelectActive = false,
  multiSelectEnterDisabled = false,
  multiSelectIsolationBlocksEnter = false,
  multiSelectHud,
  elementIsolationHud,
  onMultiSelectEnter,
  markupDrawingActive = false,
  markupDrawingDisabled = false,
  onMarkupDrawingToggle,
  onMarkupDrawingClear,
  onSnapshot,
  snapshotSessionOpen = false,
  snapshotCapturePending = false,
  onSnapshotCopy,
  onSnapshotDownload,
  onSnapshotDismiss,
  onResetView,
}: Props) {
  const [elementOpen, setElementOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [appModeOpen, setAppModeOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setElementOpen(false);
        setViewOpen(false);
        setClipOpen(false);
        setAppModeOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, []);

  const pickElementMode = useCallback(
    (m: SelectionMode) => {
      onSelectionModeChange(m);
      setElementOpen(false);
    },
    [onSelectionModeChange],
  );

  const pickAppMode = useCallback(
    (m: AppMode) => {
      onAppModeChange?.(m);
      setAppModeOpen(false);
    },
    [onAppModeChange],
  );

  const pickViewMode = useCallback(
    (m: ViewModeId) => {
      onApplyViewMode(m);
      setViewOpen(false);
    },
    [onApplyViewMode],
  );

  const pickClippingDirection = useCallback(
    (dir: ClippingDirectionId) => {
      onPickClippingDirection(dir);
      setClipOpen(false);
    },
    [onPickClippingDirection],
  );

  return (
    <div
      ref={wrapRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-50 flex flex-col items-center gap-5 pb-[env(safe-area-inset-bottom)]"
    >
      {appliedViewMode && onExitAppliedView && !viewOpen && (
        <div className="pointer-events-auto shrink-0">
          <DockSubmenuBar className="w-fit justify-center px-1.5 sm:px-2">
            <Button
              type="button"
              variant="ghost"
              aria-label="בטל מבט"
              title="בטל מבט"
              onClick={onExitAppliedView}
              className={cn(
                "flex h-auto min-h-0 shrink-0 items-center justify-center rounded-full border-0 px-2.5 py-1 font-normal shadow-none ring-0 sm:px-3 sm:py-1.5",
                "text-zinc-700 hover:bg-zinc-200/80 hover:text-zinc-950 active:scale-[0.99]",
                "focus-visible:ring-2 focus-visible:ring-zinc-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-[#e8ecef]",
              )}
            >
              <span className="flex min-h-[1.1rem] items-center justify-center [&_svg]:size-[1.05rem] sm:[&_svg]:size-[1.15rem]">
                <CircleX className="size-[1.05rem] shrink-0 sm:size-[1.15rem]" aria-hidden />
              </span>
            </Button>
          </DockSubmenuBar>
        </div>
      )}
      {viewOpen && !viewModeDisabled && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="בחירת מבט"
          className="pointer-events-auto shrink-0"
        >
          <DockSubmenuBar className="w-fit px-2 sm:px-2.5">
            {VIEW_MODE_ORDER.map((id) => (
              <DockSubmenuPill
                key={id}
                label={VIEW_MODE_LABELS_HE[id]}
                title={VIEW_MODE_LABELS_HE[id]}
                selected={activeViewMode === id}
                aria-label={VIEW_MODE_LABELS_HE[id]}
                className="min-w-[3.5rem] w-auto shrink-0 sm:min-w-[3.85rem]"
                onClick={() => pickViewMode(id)}
              >
                <ViewPresetIcon mode={id} />
              </DockSubmenuPill>
            ))}
          </DockSubmenuBar>
        </div>
      )}
      {clipOpen && !clippingDisabled && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="בחירת כיוון חתך"
          className="pointer-events-auto shrink-0"
        >
          <DockSubmenuBar className="w-fit px-2 sm:px-2.5">
            {CLIPPING_DIRECTION_ORDER.map((id) => (
              <DockSubmenuPill
                key={id}
                label={CLIPPING_LABELS_HE[id]}
                title={CLIPPING_LABELS_HE[id]}
                selected={appliedClippingDirection === id}
                aria-label={CLIPPING_LABELS_HE[id]}
                className="min-w-[3.5rem] w-auto shrink-0 sm:min-w-[3.85rem]"
                onClick={() => pickClippingDirection(id)}
              >
                <ViewPresetIcon mode={id} />
              </DockSubmenuPill>
            ))}
          </DockSubmenuBar>
        </div>
      )}
      {elementOpen && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="בחירת פריט או אסמבלי"
          className="pointer-events-auto shrink-0"
        >
          <DockSubmenuBar>
            <DockSubmenuPill
              label="חלק"
              title="חלק (ברירת מחדל)"
              selected={selectionMode === "part"}
              aria-label="חלק"
              onClick={() => pickElementMode("part")}
            >
              <SquaresIntersect aria-hidden />
            </DockSubmenuPill>
            <DockSubmenuPill
              label="אסמבלי"
              title="אסמבלי"
              selected={selectionMode === "assembly"}
              aria-label="אסמבלי"
              onClick={() => pickElementMode("assembly")}
            >
              <SquaresUnite aria-hidden />
            </DockSubmenuPill>
          </DockSubmenuBar>
        </div>
      )}
      {appModeOpen && onAppModeChange && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="בחירת מצב עבודה"
          className="pointer-events-auto shrink-0"
        >
          <DockSubmenuBar>
            <DockSubmenuPill
              label="ניהול"
              title="מצב ניהול"
              selected={appMode === "management"}
              aria-label="ניהול"
              onClick={() => pickAppMode("management")}
            >
              <Layers2 aria-hidden />
            </DockSubmenuPill>
            <DockSubmenuPill
              label="ייצור"
              title="מצב ייצור"
              selected={appMode === "production"}
              aria-label="ייצור"
              onClick={() => pickAppMode("production")}
            >
              <Hammer aria-hidden />
            </DockSubmenuPill>
          </DockSubmenuBar>
        </div>
      )}
      {clippingHud?.snapshot.active && clippingHud.snapshot.labelHe ? (
        <div
          className="pointer-events-auto flex w-full shrink-0 justify-center"
          role="region"
          aria-label="כלי קליפינג פעיל"
        >
          <ClippingHudRow {...clippingHud} />
        </div>
      ) : null}
      {multiSelectHud ? (
        <div className="pointer-events-auto flex w-full shrink-0 justify-center">
          <MultiSelectActionBar {...multiSelectHud} />
        </div>
      ) : null}
      {elementIsolationHud ? (
        <div
          className="pointer-events-auto flex w-full shrink-0 justify-center"
          role="region"
          aria-label="מצב אלמנט נבחר"
        >
          <DockSubmenuBar className="w-fit justify-center px-1.5 sm:px-2">
            <DockSubmenuPill
              label="בידוד חלק"
              labelClassName="max-w-[4.75rem] text-zinc-700 sm:max-w-[5.85rem]"
              title="בודד את האלמנט הנבחר"
              aria-label="בידוד חלק"
              selected={elementIsolationHud.isolationMode === "isolated"}
              className="min-w-[3.5rem] shrink-0 sm:min-w-[3.85rem]"
              disabled={elementIsolationHud.disabled}
              onClick={elementIsolationHud.onIsolate}
            >
              <Scan aria-hidden />
            </DockSubmenuPill>
            <DockSubmenuPill
              label="הצג בשקיפות"
              labelClassName="max-w-[4.75rem] text-zinc-700 sm:max-w-[5.85rem]"
              title="הצג את האלמנט בהקשר שקוף"
              aria-label="הצג בשקיפות"
              selected={elementIsolationHud.isolationMode === "context"}
              className="min-w-[3.5rem] shrink-0 sm:min-w-[3.85rem]"
              disabled={elementIsolationHud.disabled}
              onClick={elementIsolationHud.onContext}
            >
              <SquaresSubtract aria-hidden />
            </DockSubmenuPill>
            <DockSubmenuPill
              label="הסתרה"
              labelClassName="max-w-[4.75rem] text-zinc-700 sm:max-w-[5.85rem]"
              title="הסתר את האלמנט הנבחר"
              aria-label="הסתרה"
              selected={elementIsolationHud.isolationMode === "hidden"}
              className="min-w-[3.25rem] shrink-0 sm:min-w-[3.65rem]"
              disabled={elementIsolationHud.disabled}
              onClick={elementIsolationHud.onHide}
            >
              <EyeOff aria-hidden />
            </DockSubmenuPill>
            <DockSubmenuPill
              label="הצג הכל"
              labelClassName="max-w-[4.75rem] text-zinc-700 sm:max-w-[5.85rem]"
              title="הצג את כל המודל"
              aria-label="הצג הכל"
              className="min-w-[3.25rem] shrink-0 sm:min-w-[3.65rem]"
              disabled={elementIsolationHud.disabled || elementIsolationHud.isolationMode === "none"}
              onClick={elementIsolationHud.onShowAll}
            >
              <RotateCcw aria-hidden />
            </DockSubmenuPill>
          </DockSubmenuBar>
        </div>
      ) : null}
      {measurementActive ? (
        <div
          className="pointer-events-auto flex w-full shrink-0 justify-center"
          role="region"
          aria-label="כלי מדידה"
        >
          <DockSubmenuBar className="w-fit justify-center px-1.5 sm:px-2">
            <DockSubmenuPill
              label="איפוס"
              labelClassName="max-w-[3.5rem] text-zinc-700 sm:max-w-[3.75rem]"
              title="נקה את כל המדידות"
              aria-label="איפוס מדידות"
              className="min-w-[3.25rem] shrink-0 sm:min-w-[3.5rem]"
              onClick={onMeasurementClear}
            >
              <RotateCcw aria-hidden />
            </DockSubmenuPill>
            <Button
              type="button"
              variant="ghost"
              aria-label="סיים מדידה"
              title="יציאה ממדידה"
              onClick={onMeasurementFinish}
              className={cn(
                "flex h-auto min-h-0 shrink-0 items-center justify-center rounded-full border-0 px-2.5 py-1 font-normal shadow-none ring-0 sm:px-3 sm:py-1.5",
                "text-zinc-700 hover:bg-zinc-200/80 hover:text-zinc-950 active:scale-[0.99]",
                "focus-visible:ring-2 focus-visible:ring-zinc-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-[#e8ecef]",
              )}
            >
              <span className="flex min-h-[1.1rem] items-center justify-center [&_svg]:size-[1.05rem] sm:[&_svg]:size-[1.15rem]">
                <CircleX className="size-[1.05rem] shrink-0 sm:size-[1.15rem]" aria-hidden />
              </span>
            </Button>
          </DockSubmenuBar>
        </div>
      ) : null}
      {markupDrawingActive && !snapshotSessionOpen && onMarkupDrawingToggle ? (
        <div
          className="pointer-events-auto flex w-full shrink-0 justify-center"
          role="region"
          aria-label="כלי סימון"
        >
          <DockSubmenuBar className="w-fit justify-center px-1.5 sm:px-2">
            {onMarkupDrawingClear ? (
              <DockSubmenuPill
                label="איפוס"
                labelClassName="max-w-[3.5rem] text-zinc-700 sm:max-w-[3.75rem]"
                title="נקה ציור מהמסך"
                aria-label="איפוס סימון"
                className="min-w-[3.25rem] shrink-0 sm:min-w-[3.5rem]"
                onClick={onMarkupDrawingClear}
              >
                <RotateCcw aria-hidden />
              </DockSubmenuPill>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              aria-label="סגור מצב סימון"
              title="יציאה מסימון"
              onClick={onMarkupDrawingToggle}
              className={cn(
                "flex h-auto min-h-0 shrink-0 items-center justify-center rounded-full border-0 px-2.5 py-1 font-normal shadow-none ring-0 sm:px-3 sm:py-1.5",
                "text-zinc-700 hover:bg-zinc-200/80 hover:text-zinc-950 active:scale-[0.99]",
                "focus-visible:ring-2 focus-visible:ring-zinc-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-[#e8ecef]",
              )}
            >
              <span className="flex min-h-[1.1rem] items-center justify-center [&_svg]:size-[1.05rem] sm:[&_svg]:size-[1.15rem]">
                <CircleX className="size-[1.05rem] shrink-0 sm:size-[1.15rem]" aria-hidden />
              </span>
            </Button>
          </DockSubmenuBar>
        </div>
      ) : null}
      {snapshotSessionOpen &&
      onSnapshotCopy &&
      onSnapshotDownload &&
      onSnapshotDismiss ? (
        <div
          className="pointer-events-auto flex w-full shrink-0 justify-center"
          role="region"
          aria-label="צילום מסך"
        >
          <DockSubmenuBar className="w-fit justify-center px-1.5 sm:px-2">
            {onMarkupDrawingToggle ? (
              <DockSubmenuPill
                label="ציור"
                labelClassName="max-w-[3.5rem] text-zinc-700 sm:max-w-[3.75rem]"
                title="ציור על צילום המסך לפני העתקה או הורדה"
                aria-label="ציור"
                className="min-w-[3.25rem] shrink-0 sm:min-w-[3.5rem]"
                selected={markupDrawingActive}
                disabled={markupDrawingDisabled}
                onClick={() => {
                  if (markupDrawingActive) onMarkupDrawingClear?.();
                  onMarkupDrawingToggle();
                }}
              >
                <Pencil aria-hidden />
              </DockSubmenuPill>
            ) : null}
            <DockSubmenuPill
              label="העתקה"
              labelClassName="max-w-[3.5rem] text-zinc-700 sm:max-w-[3.75rem]"
              title="העתקת התמונה ללוח"
              aria-label="העתקה"
              className="min-w-[3.25rem] shrink-0 sm:min-w-[3.5rem]"
              disabled={snapshotCapturePending}
              onClick={() => onSnapshotCopy()}
            >
              <Images aria-hidden />
            </DockSubmenuPill>
            <DockSubmenuPill
              label="הורדה"
              labelClassName="max-w-[3.5rem] text-zinc-700 sm:max-w-[3.75rem]"
              title="הורדת קובץ PNG"
              aria-label="הורדה"
              className="min-w-[3.25rem] shrink-0 sm:min-w-[3.5rem]"
              disabled={snapshotCapturePending}
              onClick={() => onSnapshotDownload()}
            >
              <ImageDown aria-hidden />
            </DockSubmenuPill>
            <Button
              type="button"
              variant="ghost"
              aria-label="סגור צילום מסך"
              title="סגור בלי שמירה"
              onClick={() => onSnapshotDismiss()}
              className={cn(
                "flex h-auto min-h-0 shrink-0 items-center justify-center rounded-full border-0 px-2.5 py-1 font-normal shadow-none ring-0 sm:px-3 sm:py-1.5",
                "text-zinc-700 hover:bg-zinc-200/80 hover:text-zinc-950 active:scale-[0.99]",
                "focus-visible:ring-2 focus-visible:ring-zinc-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-[#e8ecef]",
              )}
            >
              <span className="flex min-h-[1.1rem] items-center justify-center [&_svg]:size-[1.05rem] sm:[&_svg]:size-[1.15rem]">
                <CircleX className="size-[1.05rem] shrink-0 sm:size-[1.15rem]" aria-hidden />
              </span>
            </Button>
          </DockSubmenuBar>
        </div>
      ) : null}
      <div
        className={cn(
          "pointer-events-auto flex w-full flex-nowrap items-center justify-center gap-x-0 overflow-visible border-t border-zinc-300/80 bg-[#e8ecef] px-1 py-1.5 shadow-[0_-10px_28px_rgba(39,39,42,0.08)] sm:gap-x-px sm:px-2 sm:py-2",
        )}
        dir="rtl"
      >
        {onAppModeChange && (
          <DockPillButton
            label={appMode === "production" ? "ייצור" : "ניהול"}
            aria-expanded={appModeOpen}
            submenuOpen={appModeOpen}
            className="[&_svg]:!text-[#003CFF]"
            labelClassName={appModeOpen || appMode === "production" ? "text-zinc-900" : undefined}
            title="בחירת מצב עבודה"
            aria-label={appMode === "production" ? "מצב: ייצור" : "מצב: ניהול"}
            onClick={() => {
              setElementOpen(false);
              setViewOpen(false);
              setClipOpen(false);
              setAppModeOpen((open) => !open);
            }}
          >
            {appMode === "production" ? <Hammer aria-hidden /> : <Layers2 aria-hidden />}
          </DockPillButton>
        )}

        {!modeSwitcherOnly ? (
          <>
        {onGlobalSearch && (
          <DockPillButton label="חיפוש" title="חיפוש במודל" aria-label="חיפוש" onClick={onGlobalSearch}>
            <Search aria-hidden />
          </DockPillButton>
        )}

        {onFlashToggle && (
          <DockPillButton
            label="הבזק"
            aria-pressed={flashActive}
            disabled={flashDisabled}
            submenuOpen={flashActive && !flashDisabled}
            labelClassName={flashActive && !flashDisabled ? "text-zinc-900" : undefined}
            title={
              flashDisabled
                ? "אינו זמין לפני טעינת המודל או בזמן מדידה/סימון"
                : "הבזק — הצגת נתונים כלליים בריחוף על אלמנטים"
            }
            aria-label="הבזק"
            onClick={onFlashToggle}
          >
            <Zap aria-hidden />
          </DockPillButton>
        )}

        <DockPillButton
          label="דאשבורד"
          aria-pressed={dashboardSheetOpen}
          submenuOpen={dashboardSheetOpen}
          labelClassName={dashboardSheetOpen ? "text-zinc-900" : undefined}
          title="דאשבורד — לחיצה נוספת סוגרת את הפאנל"
          aria-label="דאשבורד"
          onClick={onDashboard}
        >
          <LayoutList aria-hidden />
        </DockPillButton>

        {onViewFilter && (
          <DockPillButton
            label="סינון"
            aria-pressed={filterSheetOpen}
            submenuOpen={filterSheetOpen}
            labelClassName={filterSheetOpen ? "text-zinc-900" : undefined}
            title="סינון תצוגה — לחיצה נוספת סוגרת את הפאנל"
            aria-label="סינון"
            onClick={onViewFilter}
          >
            <Funnel aria-hidden />
          </DockPillButton>
        )}

        {onResetView && (
          <DockPillButton
            label="איפוס"
            title="איפוס מבט לאיזומטריה הראשונית של המודל"
            aria-label="איפוס מבט"
            onClick={onResetView}
          >
            <Fullscreen aria-hidden />
          </DockPillButton>
        )}

        <DockPillButton
          label={selectionMode === "part" ? "חלק" : "אסמבלי"}
          aria-expanded={elementOpen}
          submenuOpen={elementOpen}
          title={
            selectionMode === "part"
              ? "בחירת אלמנט — חלק (ברירת מחדל). לחץ לפתיחת תפריט לבחירת אסמבלי"
              : "בחירת אלמנט — אסמבלי. לחץ לפתיחת תפריט לבחירת חלק"
          }
          aria-label={selectionMode === "part" ? "אלמנט: חלק" : "אלמנט: אסמבלי"}
          onClick={() => {
            setViewOpen(false);
            setClipOpen(false);
            setAppModeOpen(false);
            setElementOpen((o) => !o);
          }}
        >
          {selectionMode === "part" ? (
            <SquaresIntersect aria-hidden />
          ) : (
            <SquaresUnite aria-hidden />
          )}
        </DockPillButton>

        <DockPillButton
          label={
            activeViewMode && !viewModeDisabled
              ? `מבט: ${VIEW_MODE_LABELS_HE[activeViewMode]}`
              : "מבט"
          }
          aria-expanded={viewOpen}
          disabled={viewModeDisabled}
          submenuOpen={!viewModeDisabled && (viewOpen || Boolean(activeViewMode))}
          title={
            activeViewMode && !viewModeDisabled
              ? `מבט — ${VIEW_MODE_LABELS_HE[activeViewMode]}. לחץ לפתיחת בחירת מבט`
              : "מבטים מוכנים"
          }
          aria-label={
            activeViewMode && !viewModeDisabled
              ? `מבט: ${VIEW_MODE_LABELS_HE[activeViewMode]}`
              : "מבט"
          }
          labelClassName={
            activeViewMode && !viewModeDisabled ? "max-w-[5.85rem] text-zinc-900 sm:max-w-[7rem]" : undefined
          }
          className={
            activeViewMode && !viewModeDisabled ? "min-w-[4.125rem] w-[5rem] px-1 sm:w-[6rem] sm:min-w-[4.75rem]" : undefined
          }
          onClick={() => {
            if (viewModeDisabled) return;
            setElementOpen(false);
            setClipOpen(false);
            setAppModeOpen(false);
            setViewOpen((o) => !o);
          }}
        >
          <Binoculars aria-hidden />
        </DockPillButton>

        <DockPillButton
          label={
            appliedClippingDirection && !clippingDisabled
              ? `חתך: ${CLIPPING_LABELS_HE[appliedClippingDirection]}`
              : "חתך"
          }
          aria-expanded={clipOpen}
          disabled={clippingDisabled}
          submenuOpen={
            !clippingDisabled && (clipOpen || Boolean(appliedClippingDirection))
          }
          title={
            appliedClippingDirection && !clippingDisabled
              ? `חתך — ${CLIPPING_LABELS_HE[appliedClippingDirection]}. לחץ לפתיחת בחירת כיוון`
              : "חתך / קליפינג"
          }
          aria-label={
            appliedClippingDirection && !clippingDisabled
              ? `חתך: ${CLIPPING_LABELS_HE[appliedClippingDirection]}`
              : "חתך"
          }
          labelClassName={
            appliedClippingDirection && !clippingDisabled
              ? "max-w-[5.85rem] text-zinc-900 sm:max-w-[7rem]"
              : undefined
          }
          className={
            appliedClippingDirection && !clippingDisabled
              ? "min-w-[4.125rem] w-[5rem] px-1 sm:w-[6rem] sm:min-w-[4.75rem]"
              : undefined
          }
          onClick={() => {
            if (clippingDisabled) return;
            setElementOpen(false);
            setViewOpen(false);
            setAppModeOpen(false);
            setClipOpen((o) => !o);
          }}
        >
          <FoldHorizontal aria-hidden />
        </DockPillButton>

        {onToggleHideFastenersKeepHoles && (
          <DockPillButton
            label="ברגים"
            submenuOpen={hideFastenersKeepHoles}
            labelClassName={hideFastenersKeepHoles ? "text-zinc-900" : undefined}
            aria-pressed={hideFastenersKeepHoles}
            title="כבוי: הצג מהדקים ובורגים. מופעל: הסתר רכיבי הידוק מהתצוגה ושמור על מיקום חריצים ופתחים"
            aria-label="ברגים"
            onClick={onToggleHideFastenersKeepHoles}
          >
            <Bolt aria-hidden />
          </DockPillButton>
        )}

        <DockPillButton
          label="שרטוט"
          submenuOpen={sketchModeActive && !sketchDisabled}
          labelClassName={sketchModeActive && !sketchDisabled ? "text-zinc-900" : undefined}
          aria-pressed={sketchModeActive}
          disabled={sketchDisabled}
          title="מצב סקיצה ושרטוט"
          aria-label="שרטוט"
          onClick={onSketchToggle}
        >
          <Frame aria-hidden />
        </DockPillButton>

        <DockPillButton
          label="בחירה מרובה"
          aria-pressed={multiSelectActive}
          disabled={
            multiSelectEnterDisabled ||
            measurementActive ||
            markupDrawingActive ||
            (!multiSelectActive && multiSelectIsolationBlocksEnter)
          }
          submenuOpen={
            multiSelectActive &&
            !multiSelectEnterDisabled &&
            !measurementActive &&
            !markupDrawingActive
          }
          labelClassName={
            multiSelectActive &&
            !multiSelectEnterDisabled &&
            !measurementActive &&
            !markupDrawingActive
              ? "text-zinc-900"
              : undefined
          }
          title={
            measurementActive
              ? "צא ממדידה כדי להפעיל בחירה מרובה"
              : markupDrawingActive
                ? "צא ממצב ציור כדי להפעיל בחירה מרובה"
                : multiSelectActive
                  ? "בחירה מרובה — לחיצה נוספת יוצאת מהמצב"
                  : "בחירה מרובה"
          }
          aria-label="בחירה מרובה"
          onClick={() => onMultiSelectEnter?.()}
        >
          <Blend aria-hidden />
        </DockPillButton>

        {onMarkupDrawingToggle && (
          <DockPillButton
            label="סימון"
            aria-pressed={markupDrawingActive}
            disabled={markupDrawingDisabled}
            submenuOpen={markupDrawingActive && !markupDrawingDisabled}
            labelClassName={
              markupDrawingActive && !markupDrawingDisabled ? "text-zinc-900" : undefined
            }
            title={
              markupDrawingDisabled
                ? "אינו זמין במדידה או לפני טעינת המודל"
                : "סימון וציור על המסך — איפוס ויציאה בתפריט למעלה"
            }
            aria-label="סימון"
            onClick={onMarkupDrawingToggle}
          >
            <Pencil aria-hidden />
          </DockPillButton>
        )}

        <DockPillButton
          label="מדידה"
          aria-pressed={measurementActive}
          submenuOpen={measurementActive}
          labelClassName={measurementActive ? "text-zinc-900" : undefined}
          title="מדידה — לחיצה על תווית המרחק מציגה גובה ומרחק אופקי במודל. איפוס ויציאה בתפריט למעלה."
          aria-label="מדידה"
          onClick={onMeasurementToggle}
        >
          <RulerDimensionLine aria-hidden />
        </DockPillButton>

        {onSnapshot && (
          <DockPillButton
            label="צילום מסך"
            aria-pressed={snapshotSessionOpen}
            submenuOpen={snapshotSessionOpen}
            labelClassName={snapshotSessionOpen ? "text-zinc-900" : undefined}
            title={
              snapshotSessionOpen
                ? "בחר העתקה, הורדה או סגירה בתפריט למעלה"
                : "צילום התצוגה (ללא תפריטים)"
            }
            aria-label="צילום מסך"
            disabled={snapshotSessionOpen || snapshotCapturePending}
            onClick={() => onSnapshot()}
          >
            <Camera aria-hidden />
          </DockPillButton>
        )}
          </>
        ) : null}
      </div>
    </div>
  );
}
