import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getTrpcClient } from "@/lib/trpc";

const trpcClient = getTrpcClient();

export const cloudQueryKeys = {
  health: ["cloud", "health"] as const,
  entitlements: ["cloud", "entitlements"] as const,
  hostedFiles: ["cloud", "hosted-files"] as const,
};

export function useServerHealth() {
  return useQuery({
    queryKey: cloudQueryKeys.health,
    queryFn: () => trpcClient.health.ping.query(),
  });
}

export function useEntitlements() {
  return useQuery({
    queryKey: cloudQueryKeys.entitlements,
    queryFn: () => trpcClient.entitlements.me.query(),
  });
}

export function useSyncPurchase() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      appUserId: string;
      isPremium: boolean;
      source: "preview" | "client_sync" | "anonymous" | "webhook";
      managementUrl: string | null;
      expiresAt: string | null;
    }) =>
      trpcClient.entitlements.syncPurchase.mutate({
        appUserId: input.appUserId,
        isPremium: input.isPremium,
        source: input.source === "preview" ? "preview" : "client_sync",
        managementUrl: input.managementUrl,
        expiresAt: input.expiresAt,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cloudQueryKeys.entitlements });
      await queryClient.invalidateQueries({ queryKey: cloudQueryKeys.hostedFiles });
    },
  });
}

export function useHostedFiles(enabled: boolean) {
  return useQuery({
    queryKey: cloudQueryKeys.hostedFiles,
    queryFn: () => trpcClient.hostedFiles.listMine.query(),
    enabled,
  });
}

export function useCreateHostedUpload() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { fileName: string; mimeType: string; sizeBytes: number; passcode: string | null }) =>
      trpcClient.hostedFiles.createUpload.mutate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cloudQueryKeys.hostedFiles });
    },
  });
}

export function useCompleteHostedUpload() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { hostedFileId: string }) => trpcClient.hostedFiles.completeUpload.mutate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cloudQueryKeys.hostedFiles });
    },
  });
}

export function useDeleteHostedFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { hostedFileId: string }) => trpcClient.hostedFiles.delete.mutate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cloudQueryKeys.hostedFiles });
    },
  });
}

export function useCreateHostedShareLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { hostedFileId: string; passcode: string | null }) =>
      trpcClient.hostedFiles.createShareLink.mutate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cloudQueryKeys.hostedFiles });
    },
  });
}
