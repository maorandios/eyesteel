"use client";

import { create } from "zustand";
import type { ViewerCameraRevertSnapshot } from "@/lib/viewer/engine";
import type { ViewModeId } from "@/lib/viewer/view-mode-presets";
import type { IsolationMode } from "@/lib/state/isolation-store";
import type { ViewerClippingUiSnapshot } from "@/lib/viewer/clipping-presets";

/** Everything restored when exiting מצב בדיקה (camera is engine-owned; rest is UI + worker state cues). */
export type InspectionRevertBundle = {
  camera: ViewerCameraRevertSnapshot;
  sketchModeEnabled: boolean;
  viewModeUi: ViewModeId | "none";
  clipping: ViewerClippingUiSnapshot;
  /** Always `none` today — blocked entering inspection otherwise; retained for forwards compatibility. */
  isolationModeBefore: IsolationMode;
};

type InspectionStore = {
  active: boolean;
  selectedPartId: string | null;
  /** Active orthographic preset while inspecting — drives מבטים in the inspection toolbar. */
  inspectionViewMode: ViewModeId | null;
  revert: InspectionRevertBundle | null;
  setInspectionViewMode: (mode: ViewModeId | null) => void;
  enter: (partId: string, bundle: InspectionRevertBundle, initialOrtho: ViewModeId) => void;
  exit: () => void;
};

const initialRevert = (): InspectionRevertBundle | null => null;

export const useInspectionStore = create<InspectionStore>((set) => ({
  active: false,
  selectedPartId: null,
  inspectionViewMode: null,
  revert: initialRevert(),
  setInspectionViewMode: (mode) => set({ inspectionViewMode: mode }),
  enter: (partId, bundle, initialOrtho) =>
    set({
      active: true,
      selectedPartId: partId,
      revert: bundle,
      inspectionViewMode: initialOrtho,
    }),
  exit: () =>
    set({
      active: false,
      selectedPartId: null,
      inspectionViewMode: null,
      revert: null,
    }),
}));
