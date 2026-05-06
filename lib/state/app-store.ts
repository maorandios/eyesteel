"use client";

import { create } from "zustand";
import type { AnalyzerOutput, Element, ViewerMode } from "@/types/domain";

interface AppState {
  file: File | null;
  fileName: string;
  loadingState: "idle" | "loading" | "parsing" | "ready" | "error";
  mode: ViewerMode;
  selectedElement: Element | null;
  search: string;
  activeSheet: "none" | "search" | "layers" | "details" | "parts";
  categoryVisibility: Record<string, boolean>;
  transparencyEnabled: boolean;
  analyzerData: AnalyzerOutput | null;
  setFile: (file: File | null) => void;
  setAnalyzerData: (data: AnalyzerOutput | null) => void;
  setLoadingState: (state: AppState["loadingState"]) => void;
  setMode: (mode: ViewerMode) => void;
  setSelectedElement: (element: Element | null) => void;
  setSearch: (value: string) => void;
  setActiveSheet: (sheet: AppState["activeSheet"]) => void;
  toggleCategory: (category: string) => void;
  setTransparencyEnabled: (enabled: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  file: null,
  fileName: "",
  loadingState: "idle",
  mode: "management",
  selectedElement: null,
  search: "",
  activeSheet: "none",
  categoryVisibility: {
    assemblies: true,
    beams: true,
    columns: true,
    plates: true,
    bolts: true,
    other: true,
  },
  transparencyEnabled: false,
  analyzerData: null,
  setFile: (file) =>
    set({
      file,
      fileName: file?.name ?? "",
      loadingState: file ? "loading" : "idle",
    }),
  setAnalyzerData: (analyzerData) => set({ analyzerData }),
  setLoadingState: (loadingState) => set({ loadingState }),
  setMode: (mode) => set({ mode }),
  setSelectedElement: (selectedElement) => set({ selectedElement }),
  setSearch: (search) => set({ search }),
  setActiveSheet: (activeSheet) => set({ activeSheet }),
  toggleCategory: (category) =>
    set((state) => ({
      categoryVisibility: {
        ...state.categoryVisibility,
        [category]: !state.categoryVisibility[category],
      },
    })),
  setTransparencyEnabled: (transparencyEnabled) => set({ transparencyEnabled }),
}));
