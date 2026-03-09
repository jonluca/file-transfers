import * as Crypto from "expo-crypto";
import AsyncStorage from "expo-sqlite/kv-store";
import { Platform } from "react-native";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { TransferHistoryEntry } from "@/lib/file-transfer";
import {
  DEFAULT_DIRECT_TRANSFER_CHUNK_BYTES,
  DEFAULT_FREE_TRANSFER_CHUNK_BYTES,
  MAX_TRANSFER_CHUNK_BYTES,
  MIN_TRANSFER_CHUNK_BYTES,
  TRANSFER_CHUNK_SIZE_STEP_BYTES,
} from "@/lib/file-transfer/constants";

const DEVICE_NAME_MAX_LENGTH = 40;
const LEGACY_DEFAULT_DEVICE_NAME = "This device";

function createServiceInstanceId() {
  return Crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function getDefaultDeviceLabel() {
  if (Platform.OS === "android") {
    const model = Platform.constants.Model?.trim();
    if (model) {
      return model;
    }

    return "Android device";
  }

  if (Platform.OS === "ios") {
    if (Platform.isVision) {
      return "Vision Pro";
    }

    if (Platform.isPad) {
      return "iPad";
    }

    if (Platform.isTV) {
      return "Apple TV";
    }

    return "iPhone";
  }

  if (Platform.OS === "macos") {
    return "Mac";
  }

  if (Platform.OS === "windows") {
    return "PC";
  }

  if (Platform.OS === "web") {
    return "Browser";
  }

  return "Device";
}

function createDefaultDeviceName(serviceInstanceId: string) {
  const suffix = serviceInstanceId.toUpperCase();
  const maxLabelLength = Math.max(1, DEVICE_NAME_MAX_LENGTH - suffix.length - 1);
  const label = getDefaultDeviceLabel().slice(0, maxLabelLength).trim() || "Device";
  return `${label} ${suffix}`;
}

function normalizeDeviceName(value: string, serviceInstanceId: string) {
  const trimmedValue = value.trim();
  if (!trimmedValue || trimmedValue === LEGACY_DEFAULT_DEVICE_NAME) {
    return createDefaultDeviceName(serviceInstanceId);
  }

  return trimmedValue.slice(0, DEVICE_NAME_MAX_LENGTH);
}

function normalizeTransferChunkBytes(value: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const roundedValue =
    Math.round(value / TRANSFER_CHUNK_SIZE_STEP_BYTES) * TRANSFER_CHUNK_SIZE_STEP_BYTES;

  return Math.min(MAX_TRANSFER_CHUNK_BYTES, Math.max(MIN_TRANSFER_CHUNK_BYTES, roundedValue));
}

interface AppState {
  hasHydrated: boolean;
  deviceName: string;
  serviceInstanceId: string;
  autoAcceptKnownDevices: boolean;
  devPremiumOverrideEnabled: boolean;
  directTransferChunkBytes: number;
  freeTransferChunkBytes: number;
  recentTransfers: TransferHistoryEntry[];
  setHasHydrated: (value: boolean) => void;
  setDeviceName: (value: string) => void;
  setAutoAcceptKnownDevices: (value: boolean) => void;
  setDevPremiumOverrideEnabled: (value: boolean) => void;
  setDirectTransferChunkBytes: (value: number) => void;
  setFreeTransferChunkBytes: (value: number) => void;
  resetTransferChunkBytes: () => void;
  upsertRecentTransfer: (value: TransferHistoryEntry) => void;
  clearRecentTransfers: () => void;
}

interface PersistedAppState {
  deviceName: string;
  serviceInstanceId: string;
  autoAcceptKnownDevices: boolean;
  devPremiumOverrideEnabled: boolean;
  directTransferChunkBytes: number;
  freeTransferChunkBytes: number;
  recentTransfers: TransferHistoryEntry[];
}

function createDefaultPersistedState(): PersistedAppState {
  const serviceInstanceId = createServiceInstanceId();

  return {
    deviceName: createDefaultDeviceName(serviceInstanceId),
    serviceInstanceId,
    autoAcceptKnownDevices: false,
    devPremiumOverrideEnabled: false,
    directTransferChunkBytes: DEFAULT_DIRECT_TRANSFER_CHUNK_BYTES,
    freeTransferChunkBytes: DEFAULT_FREE_TRANSFER_CHUNK_BYTES,
    recentTransfers: [],
  };
}

const defaultState = createDefaultPersistedState();

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      hasHydrated: false,
      ...defaultState,
      setHasHydrated: (value) => set({ hasHydrated: value }),
      setDeviceName: (value) =>
        set((state) => ({
          deviceName: normalizeDeviceName(value, state.serviceInstanceId),
        })),
      setAutoAcceptKnownDevices: (value) =>
        set({
          autoAcceptKnownDevices: value,
        }),
      setDevPremiumOverrideEnabled: (value) =>
        set({
          devPremiumOverrideEnabled: value,
        }),
      setDirectTransferChunkBytes: (value) =>
        set({
          directTransferChunkBytes: normalizeTransferChunkBytes(value, DEFAULT_DIRECT_TRANSFER_CHUNK_BYTES),
        }),
      setFreeTransferChunkBytes: (value) =>
        set({
          freeTransferChunkBytes: normalizeTransferChunkBytes(value, DEFAULT_FREE_TRANSFER_CHUNK_BYTES),
        }),
      resetTransferChunkBytes: () =>
        set({
          directTransferChunkBytes: DEFAULT_DIRECT_TRANSFER_CHUNK_BYTES,
          freeTransferChunkBytes: DEFAULT_FREE_TRANSFER_CHUNK_BYTES,
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
      version: 2,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        deviceName: state.deviceName,
        serviceInstanceId: state.serviceInstanceId,
        autoAcceptKnownDevices: state.autoAcceptKnownDevices,
        devPremiumOverrideEnabled: state.devPremiumOverrideEnabled,
        directTransferChunkBytes: state.directTransferChunkBytes,
        freeTransferChunkBytes: state.freeTransferChunkBytes,
        recentTransfers: state.recentTransfers,
      }),
      migrate: (persistedState) => {
        const state = (persistedState as Partial<PersistedAppState> | undefined) ?? {};
        const serviceInstanceId =
          typeof state.serviceInstanceId === "string" && state.serviceInstanceId.trim()
            ? state.serviceInstanceId
            : createServiceInstanceId();

        return {
          ...defaultState,
          ...state,
          serviceInstanceId,
          deviceName: normalizeDeviceName(
            typeof state.deviceName === "string" ? state.deviceName : "",
            serviceInstanceId,
          ),
          directTransferChunkBytes: normalizeTransferChunkBytes(
            state.directTransferChunkBytes ?? Number.NaN,
            DEFAULT_DIRECT_TRANSFER_CHUNK_BYTES,
          ),
          freeTransferChunkBytes: normalizeTransferChunkBytes(
            state.freeTransferChunkBytes ?? Number.NaN,
            DEFAULT_FREE_TRANSFER_CHUNK_BYTES,
          ),
        };
      },
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);

export const useHasHydrated = () => useAppStore((state) => state.hasHydrated);
export const useDeviceName = () => useAppStore((state) => state.deviceName);
export const useServiceInstanceId = () => useAppStore((state) => state.serviceInstanceId);
export const useAutoAcceptKnownDevices = () => useAppStore((state) => state.autoAcceptKnownDevices);
export const useDevPremiumOverrideEnabled = () => useAppStore((state) => state.devPremiumOverrideEnabled);
export const useDirectTransferChunkBytes = () => useAppStore((state) => state.directTransferChunkBytes);
export const useFreeTransferChunkBytes = () => useAppStore((state) => state.freeTransferChunkBytes);
export const useRecentTransfers = () => useAppStore((state) => state.recentTransfers);

export function getTransferChunkSettings() {
  const state = useAppStore.getState();

  return {
    directTransferChunkBytes: state.directTransferChunkBytes,
    freeTransferChunkBytes: state.freeTransferChunkBytes,
  };
}
