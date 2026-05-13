"use client";

import { create } from "zustand";

export type PickInteractionMode = "inactive" | "multi";

export type MultiSelectWeightItem = {
  key: string;
  weightKg: number | null;
  localIds?: number[];
};

function sortUnique(ids: Iterable<number>): number[] {
  return [...new Set(ids)].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

type MultiSelectState = {
  pickInteractionMode: PickInteractionMode;
  selectedLocalIds: number[];
  selectedWeightItems: MultiSelectWeightItem[];
  enterMultiSelect: () => void;
  exitMultiSelect: () => void;
  /** End session, clear ids (caller clears viewer highlight if needed). */
  exitMultiSelectSession: () => void;
  clearSelected: () => void;
  toggleLocalIds: (ids: number[], weightItem?: MultiSelectWeightItem) => void;
  reset: () => void;
};

const initial = {
  pickInteractionMode: "inactive" as PickInteractionMode,
  selectedLocalIds: [] as number[],
  selectedWeightItems: [] as MultiSelectWeightItem[],
};

export const useMultiSelectStore = create<MultiSelectState>((set, get) => ({
  ...initial,
  enterMultiSelect: () => set({ pickInteractionMode: "multi" }),
  exitMultiSelect: () => set({ pickInteractionMode: "inactive" }),
  exitMultiSelectSession: () =>
    set({ pickInteractionMode: "inactive", selectedLocalIds: [], selectedWeightItems: [] }),
  clearSelected: () => set({ selectedLocalIds: [], selectedWeightItems: [] }),
  toggleLocalIds: (ids, weightItem) => {
    const raw = [...new Set(ids)].filter((n) => Number.isFinite(n));
    if (raw.length === 0) return;
    const cur = get().selectedLocalIds;
    const curSet = new Set(cur);
    const nextSet = new Set(cur);
    let selectedWeightItems = get().selectedWeightItems;
    const existingWeightItem = weightItem
      ? selectedWeightItems.find((item) => item.key === weightItem.key)
      : undefined;
    const shouldRemove = Boolean(existingWeightItem) || raw.every((id) => curSet.has(id));
    if (shouldRemove) {
      const idsToRemove = new Set([...raw, ...(existingWeightItem?.localIds ?? [])]);
      for (const id of idsToRemove) nextSet.delete(id);
      if (weightItem) {
        selectedWeightItems = selectedWeightItems.filter((item) => item.key !== weightItem.key);
      }
    } else {
      for (const id of raw) nextSet.add(id);
      if (weightItem) {
        const nextWeightItem = {
          key: weightItem.key,
          weightKg:
            weightItem.weightKg == null || Number.isNaN(weightItem.weightKg)
              ? null
              : weightItem.weightKg,
          localIds: sortUnique(raw),
        };
        selectedWeightItems = [
          ...selectedWeightItems.filter((item) => item.key !== nextWeightItem.key),
          nextWeightItem,
        ];
      }
    }
    set({ selectedLocalIds: sortUnique(nextSet), selectedWeightItems });
  },
  reset: () => set(initial),
}));
