"use client";

import { create } from "zustand";

export type SmartMeasurePhase = "pickFirst" | "pickSecond";

interface SmartMeasureStoreState {
  phase: SmartMeasurePhase;
  showBreakdown: boolean;
  setShowBreakdown: (v: boolean) => void;
  /** Metrics card visible; breakdown geometry follows when open via toggle. */
  measurementDetailsOpen: boolean;
  setMeasurementDetailsOpen: (v: boolean) => void;
  toggleMeasurementDetailsPanel: () => void;
  /** Last finished two‑point measurement (millimetres). */
  directMm: number | null;
  heightMm: number | null;
  horizontalMm: number | null;
  hintHe: string;
  setPhase: (p: SmartMeasurePhase) => void;
  setHint: (s: string) => void;
  applyCompleted: (directMm: number, heightMm: number, horizontalMm: number) => void;
  resetSession: () => void;
}

export const useSmartMeasureStore = create<SmartMeasureStoreState>((set) => ({
  phase: "pickFirst",
  showBreakdown: false,
  setShowBreakdown: (showBreakdown) => set({ showBreakdown }),
  measurementDetailsOpen: false,
  setMeasurementDetailsOpen: (measurementDetailsOpen) => set({ measurementDetailsOpen }),
  toggleMeasurementDetailsPanel: () =>
    set((s) => {
      const open = !s.measurementDetailsOpen;
      return { measurementDetailsOpen: open, showBreakdown: open };
    }),
  directMm: null,
  heightMm: null,
  horizontalMm: null,
  hintHe: "לחץ על נקודה ראשונה על המודל",
  setPhase: (phase) => set({ phase }),
  setHint: (hintHe) => set({ hintHe }),
  applyCompleted: (directMm, heightMm, horizontalMm) =>
    set({ directMm, heightMm, horizontalMm, phase: "pickFirst", hintHe: "לחץ על נקודה ראשונה על המודל" }),
  resetSession: () =>
    set({
      phase: "pickFirst",
      directMm: null,
      heightMm: null,
      horizontalMm: null,
      hintHe: "לחץ על נקודה ראשונה על המודל",
      showBreakdown: false,
      measurementDetailsOpen: false,
    }),
}));
