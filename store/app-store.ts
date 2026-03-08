import AsyncStorage from "expo-sqlite/kv-store";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { TransferHistoryEntry } from "@/lib/file-transfer";

interface AppState {
  hasHydrated: boolean;
  deviceName: string;
  autoAcceptKnownDevices: boolean;
  recentTransfers: TransferHistoryEntry[];
  setHasHydrated: (value: boolean) => void;
  setDeviceName: (value: string) => void;
  setAutoAcceptKnownDevices: (value: boolean) => void;
  upsertRecentTransfer: (value: TransferHistoryEntry) => void;
  clearRecentTransfers: () => void;
}

const defaultState = {
  deviceName: "This device",
  autoAcceptKnownDevices: false,
  recentTransfers: [] as TransferHistoryEntry[],
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      hasHydrated: false,
      ...defaultState,
      setHasHydrated: (value) => set({ hasHydrated: value }),
      setDeviceName: (value) =>
        set({
          deviceName: value.trim().length > 0 ? value.trim().slice(0, 40) : defaultState.deviceName,
        }),
      setAutoAcceptKnownDevices: (value) =>
        set({
          autoAcceptKnownDevices: value,
        }),
      upsertRecentTransfer: (value) =>
        set((state) => {
          const existingIndex = state.recentTransfers.findIndex((entry) => entry.id === value.id);
          const nextTransfers = [...state.recentTransfers];

          if (existingIndex >= 0) {
            nextTransfers.splice(existingIndex, 1, value);
          } else {
            nextTransfers.unshift(value);
          }

          nextTransfers.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

          return {
            recentTransfers: nextTransfers.slice(0, 40),
          };
        }),
      clearRecentTransfers: () =>
        set({
          recentTransfers: [],
        }),
    }),
    {
      name: "file-transfers-app-store",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        deviceName: state.deviceName,
        autoAcceptKnownDevices: state.autoAcceptKnownDevices,
        recentTransfers: state.recentTransfers,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);

export const useHasHydrated = () => useAppStore((state) => state.hasHydrated);
export const useDeviceName = () => useAppStore((state) => state.deviceName);
export const useAutoAcceptKnownDevices = () => useAppStore((state) => state.autoAcceptKnownDevices);
export const useRecentTransfers = () => useAppStore((state) => state.recentTransfers);
