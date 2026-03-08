import AsyncStorage from "expo-sqlite/kv-store";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AccentTheme } from "@/lib/accent-theme";

interface AppState {
  hasHydrated: boolean;
  preferredAccent: AccentTheme;
  enableHaptics: boolean;
  useCompactCards: boolean;
  enableExperimentalUi: boolean;
  setHasHydrated: (value: boolean) => void;
  setPreferredAccent: (value: AccentTheme) => void;
  setEnableHaptics: (value: boolean) => void;
  setUseCompactCards: (value: boolean) => void;
  setEnableExperimentalUi: (value: boolean) => void;
  resetPreferences: () => void;
}

const defaultState = {
  preferredAccent: "blue" as AccentTheme,
  enableHaptics: true,
  useCompactCards: false,
  enableExperimentalUi: true,
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      hasHydrated: false,
      ...defaultState,
      setHasHydrated: (value) => set({ hasHydrated: value }),
      setPreferredAccent: (value) => set({ preferredAccent: value }),
      setEnableHaptics: (value) => set({ enableHaptics: value }),
      setUseCompactCards: (value) => set({ useCompactCards: value }),
      setEnableExperimentalUi: (value) => set({ enableExperimentalUi: value }),
      resetPreferences: () => set({ ...defaultState }),
    }),
    {
      name: "mobile-boilerplate-app-store",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        preferredAccent: state.preferredAccent,
        enableHaptics: state.enableHaptics,
        useCompactCards: state.useCompactCards,
        enableExperimentalUi: state.enableExperimentalUi,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);

export const useHasHydrated = () => useAppStore((state) => state.hasHydrated);
export const usePreferredAccent = () => useAppStore((state) => state.preferredAccent);
export const useEnableHaptics = () => useAppStore((state) => state.enableHaptics);
export const useUseCompactCards = () => useAppStore((state) => state.useCompactCards);
export const useEnableExperimentalUi = () => useAppStore((state) => state.enableExperimentalUi);
