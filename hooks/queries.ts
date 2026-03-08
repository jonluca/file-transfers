import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getTrpcClient, type RouterOutputs } from "@/lib/trpc";

const trpcClient = getTrpcClient();

export const cloudQueryKeys = {
  health: ["cloud", "health"] as const,
  viewer: ["cloud", "viewer"] as const,
};

export function useServerHealth() {
  return useQuery({
    queryKey: cloudQueryKeys.health,
    queryFn: () => trpcClient.health.ping.query(),
  });
}

export function useViewer(enabled: boolean) {
  return useQuery({
    queryKey: cloudQueryKeys.viewer,
    queryFn: () => trpcClient.viewer.me.query(),
    enabled,
  });
}

interface ViewerProfileInput {
  displayName: string | null;
  bio: string | null;
  accentTheme: RouterOutputs["viewer"]["me"]["profile"]["accentTheme"];
  emailUpdatesEnabled: boolean;
}

export function useUpdateViewerProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ViewerProfileInput) => trpcClient.viewer.updateProfile.mutate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cloudQueryKeys.viewer });
    },
  });
}
