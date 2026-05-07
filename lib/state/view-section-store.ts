"use client";

import { create } from "zustand";

export type ActiveViewMode =
  | "none"
  | "top"
  | "bottom"
  | "right"
  | "left"
  | "front"
  | "back"
  | "free";

export type FreeSectionPickStep = "idle" | "pick-first" | "pick-second" | "active";

interface ViewSectionState {
  activeViewMode: ActiveViewMode;
  sectionActive: boolean;
  sectionType: "fixed" | "free" | null;
  sectionLabel: string | null;
  depthOffset: number;
  depthExtent: number;
  flipped: boolean;
  freePickStep: FreeSectionPickStep;
  freePickMessage: string | null;
  freePickError: string | null;

  resetUi: () => void;
  setFreePick: (step: FreeSectionPickStep, message: string | null, error?: string | null) => void;
  setSectionUi: (patch: {
    activeViewMode?: ActiveViewMode;
    sectionActive?: boolean;
    sectionType?: "fixed" | "free" | null;
    sectionLabel?: string | null;
    depthOffset?: number;
    depthExtent?: number;
    flipped?: boolean;
  }) => void;
}

const initial = {
  activeViewMode: "none" as ActiveViewMode,
  sectionActive: false,
  sectionType: null as "fixed" | "free" | null,
  sectionLabel: null as string | null,
  depthOffset: 0,
  depthExtent: 10,
  flipped: false,
  freePickStep: "idle" as FreeSectionPickStep,
  freePickMessage: null as string | null,
  freePickError: null as string | null,
};

export const useViewSectionStore = create<ViewSectionState>((set) => ({
  ...initial,

  resetUi: () => set({ ...initial }),

  setFreePick: (freePickStep, freePickMessage, freePickError = null) =>
    set({ freePickStep, freePickMessage, freePickError }),

  setSectionUi: (patch) => set((s) => ({ ...s, ...patch })),
}));
