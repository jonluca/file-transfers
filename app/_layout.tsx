import "@/globals.css";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import type { QueryCacheNotifyEvent } from "@tanstack/query-core";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { AppState, Platform } from "react-native";
import type { AppStateStatus } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FullScreenLoader } from "@/components/ui";
import { createBoilerplateQueryClient, getTrpcClient, TRPCProvider } from "@/lib/trpc";
import { useHasHydrated } from "@/store";

function onAppStateChange(status: AppStateStatus) {
  if (Platform.OS !== "web") {
    focusManager.setFocused(status === "active");
  }
}

export const queryClient = createBoilerplateQueryClient();
const trpcClient = getTrpcClient();

function RootLayoutContent() {
  const hasHydrated = useHasHydrated();

  if (!hasHydrated) {
    return <FullScreenLoader label={"Loading Mobile Boilerplate..."} />;
  }

  return <Slot />;
}

export default function RootLayout() {
  useEffect(() => {
    const subscription = AppState.addEventListener("change", onAppStateChange);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!__DEV__) {
      return;
    }

    const queryCache = queryClient.getQueryCache();
    const fetchStartTimes = new Map<string, number>();
    const lastFetchStatus = new Map<string, string>();

    const unsubscribe = queryCache.subscribe((event?: QueryCacheNotifyEvent) => {
      const query = event?.query;
      if (!query) {
        return;
      }

      const queryHash = query.queryHash;
      const fetchStatus = query.state.fetchStatus;
      const previousFetchStatus = lastFetchStatus.get(queryHash);

      if (fetchStatus === "fetching" && previousFetchStatus !== "fetching") {
        fetchStartTimes.set(queryHash, Date.now());
      }

      if (fetchStatus !== "fetching" && previousFetchStatus === "fetching") {
        const startedAt = fetchStartTimes.get(queryHash);
        if (startedAt !== undefined) {
          const durationMs = Date.now() - startedAt;
          console.info(`[ReactQuery] ${JSON.stringify(query.queryKey)} ${query.state.status} in ${durationMs}ms`);
          fetchStartTimes.delete(queryHash);
        }
      }

      lastFetchStatus.set(queryHash, fetchStatus);
    });

    return () => unsubscribe();
  }, []);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <RootLayoutContent />
          </GestureHandlerRootView>
        </TRPCProvider>
        <StatusBar style={"dark"} />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
