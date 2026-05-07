"use client";

import { create } from "zustand";

export type ViewerToolId = "none" | "measurement" | "free_section_pick";

interface ViewerToolState {
  activeTool: ViewerToolId;
  setActiveTool: (tool: ViewerToolId) => void;
}

export const useViewerToolStore = create<ViewerToolState>((set) => ({
  activeTool: "none",
  setActiveTool: (activeTool) => set({ activeTool }),
}));
