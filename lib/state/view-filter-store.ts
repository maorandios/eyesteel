"use client";

import { create } from "zustand";

export type ViewFilterState = {
  /** Keys from {@link assemblyGroupKey} / {@link AggregatedAssemblyRow.key} */
  hiddenAssemblyKeys: Record<string, boolean>;
  hiddenPartIds: Record<string, boolean>;
  /** סינון חלקים — מפתח שורת איחוד (מספר חלק | פרופיל | …). */
  hiddenPartTabGroupKeys: Record<string, boolean>;
  /** סינון פרופילים — מפתח שורת פרופיל (תווית פרופיל). */
  hiddenProfileTabGroupKeys: Record<string, boolean>;
  /**
   * When true (√ בורג), mechanical fasteners disappear but opening/void items stay visible (hole locations).
   */
  hideAllFastenersKeepHoles: boolean;
  toggleAssemblyKey: (key: string) => void;
  togglePartId: (partId: string) => void;
  togglePartTabGroupKey: (key: string) => void;
  toggleProfileTabGroupKey: (key: string) => void;
  isAssemblyHidden: (key: string) => boolean;
  isPartHidden: (partId: string) => boolean;
  isPartTabGroupHidden: (key: string) => boolean;
  isProfileTabGroupHidden: (key: string) => boolean;
  toggleHideAllFastenersKeepHoles: () => void;
  reset: () => void;
};

const initial = {
  hiddenAssemblyKeys: {} as Record<string, boolean>,
  hiddenPartIds: {} as Record<string, boolean>,
  hiddenPartTabGroupKeys: {} as Record<string, boolean>,
  hiddenProfileTabGroupKeys: {} as Record<string, boolean>,
  hideAllFastenersKeepHoles: false,
};

export const useViewFilterStore = create<ViewFilterState>((set, get) => ({
  ...initial,
  toggleAssemblyKey: (key) =>
    set((s) => {
      const hiddenAssemblyKeys = { ...s.hiddenAssemblyKeys };
      if (hiddenAssemblyKeys[key]) delete hiddenAssemblyKeys[key];
      else hiddenAssemblyKeys[key] = true;
      return { hiddenAssemblyKeys };
    }),
  togglePartId: (partId) =>
    set((s) => {
      const hiddenPartIds = { ...s.hiddenPartIds };
      if (hiddenPartIds[partId]) delete hiddenPartIds[partId];
      else hiddenPartIds[partId] = true;
      return { hiddenPartIds };
    }),
  togglePartTabGroupKey: (key) =>
    set((s) => {
      const hiddenPartTabGroupKeys = { ...s.hiddenPartTabGroupKeys };
      if (hiddenPartTabGroupKeys[key]) delete hiddenPartTabGroupKeys[key];
      else hiddenPartTabGroupKeys[key] = true;
      return { hiddenPartTabGroupKeys };
    }),
  toggleProfileTabGroupKey: (key) =>
    set((s) => {
      const hiddenProfileTabGroupKeys = { ...s.hiddenProfileTabGroupKeys };
      if (hiddenProfileTabGroupKeys[key]) delete hiddenProfileTabGroupKeys[key];
      else hiddenProfileTabGroupKeys[key] = true;
      return { hiddenProfileTabGroupKeys };
    }),
  isAssemblyHidden: (key) => Boolean(get().hiddenAssemblyKeys[key]),
  isPartHidden: (partId) => Boolean(get().hiddenPartIds[partId]),
  isPartTabGroupHidden: (key) => Boolean(get().hiddenPartTabGroupKeys[key]),
  isProfileTabGroupHidden: (key) => Boolean(get().hiddenProfileTabGroupKeys[key]),
  toggleHideAllFastenersKeepHoles: () =>
    set((s) => ({ hideAllFastenersKeepHoles: !s.hideAllFastenersKeepHoles })),
  reset: () => set(initial),
}));
