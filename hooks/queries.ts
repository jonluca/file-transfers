import { trpc } from "@/lib/trpc";

export function useServerHealth() {
  return trpc.health.ping.useQuery();
}

export function useEntitlements() {
  return trpc.entitlements.me.useQuery();
}

export function useSyncPurchase() {
  const utils = trpc.useUtils();

  return trpc.entitlements.syncPurchase.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.entitlements.me.invalidate(), utils.hostedFiles.listMine.invalidate()]);
    },
  });
}

export function useHostedFiles(enabled: boolean) {
  return trpc.hostedFiles.listMine.useQuery(undefined, {
    enabled,
  });
}

export function useCreateHostedUpload() {
  const utils = trpc.useUtils();

  return trpc.hostedFiles.createUpload.useMutation({
    onSuccess: async () => {
      await utils.hostedFiles.listMine.invalidate();
    },
  });
}

export function useCompleteHostedUpload() {
  const utils = trpc.useUtils();

  return trpc.hostedFiles.completeUpload.useMutation({
    onSuccess: async () => {
      await utils.hostedFiles.listMine.invalidate();
    },
  });
}

export function useDeleteHostedFile() {
  const utils = trpc.useUtils();

  return trpc.hostedFiles.delete.useMutation({
    onSuccess: async () => {
      await utils.hostedFiles.listMine.invalidate();
    },
  });
}

export function useCreateHostedShareLink() {
  const utils = trpc.useUtils();

  return trpc.hostedFiles.createShareLink.useMutation({
    onSuccess: async () => {
      await utils.hostedFiles.listMine.invalidate();
    },
  });
}
