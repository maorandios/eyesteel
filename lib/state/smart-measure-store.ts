"use client";

import { create } from "zustand";

export type SmartMeasurePhase = "pickFirst" | "pickSecond";

interface SmartMeasureStoreState {
  phase: SmartMeasurePhase;
  setPhase: (p: SmartMeasurePhase) => void;
  hintHe: string;
  setHint: (s: string) => void;

  /** millimetres per completed segment — same order as MeasurementController segments */
  segmentsMm: Array<{ directMm: number; heightMm: number; horizontalMm: number }>;
  appendSegmentMetrics: (directMm: number, heightMm: number, horizontalMm: number) => void;

  /** Non-null ⇒ show גובה / אופקי breakdown lines + badges for this segment only. לחיצה חוזרת על אותה תווית סוגרת. */
  detailsSegmentIndex: number | null;
  toggleBreakdownForSegment: (segmentIndex: number) => void;
  clearBreakdown: () => void;

  resetSession: () => void;
}

export const useSmartMeasureStore = create<SmartMeasureStoreState>((set, get) => ({
  phase: "pickFirst",
  segmentsMm: [],
  hintHe: "לחץ על נקודה ראשונה על המודל",
  setPhase: (phase) => set({ phase }),
  setHint: (hintHe) => set({ hintHe }),
  appendSegmentMetrics: (directMm, heightMm, horizontalMm) =>
    set((s) => ({
      segmentsMm: [...s.segmentsMm, { directMm, heightMm, horizontalMm }],
      phase: "pickFirst",
      hintHe: "לחץ על נקודה ראשונה על המודל",
    })),
  detailsSegmentIndex: null,
  toggleBreakdownForSegment: (segmentIndex) => {
    const { segmentsMm, detailsSegmentIndex } = get();
    if (segmentIndex < 0 || segmentIndex >= segmentsMm.length) return;
    set({
      detailsSegmentIndex: detailsSegmentIndex === segmentIndex ? null : segmentIndex,
    });
  },
  clearBreakdown: () => set({ detailsSegmentIndex: null }),
  resetSession: () =>
    set({
      phase: "pickFirst",
      segmentsMm: [],
      hintHe: "לחץ על נקודה ראשונה על המודל",
      detailsSegmentIndex: null,
    }),
}));
