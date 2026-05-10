"use client";

import { create } from "zustand";

export type IsolationMode = "none" | "isolated" | "context" | "hidden";

type IsolationStore = {
  isolationMode: IsolationMode;
  /** Fragment local ids last used for isolation (ThatOpen worker ids). */
  isolatedFragmentLocalIds: number[];
  setIsolation: (mode: Exclude<IsolationMode, "none">, ids: number[]) => void;
  clearIsolation: () => void;
  reset: () => void;
};

const initial = {
  isolationMode: "none" as IsolationMode,
  isolatedFragmentLocalIds: [] as number[],
};

export const useIsolationStore = create<IsolationStore>((set) => ({
  ...initial,
  setIsolation: (mode, ids) =>
    set({
      isolationMode: mode,
      isolatedFragmentLocalIds: [...new Set(ids)].sort((a, b) => a - b),
    }),
  clearIsolation: () => set(initial),
  reset: () => set(initial),
}));
