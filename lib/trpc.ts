import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { authClient } from "@/lib/auth-client";
import { getApiBaseUrl } from "@/lib/api-config";
import type { AppRouter } from "@/server/trpc/router";
import type { inferRouterOutputs } from "@trpc/server";

export const trpc = createTRPCReact<AppRouter>();
export type RouterOutputs = inferRouterOutputs<AppRouter>;

let trpcClientSingleton: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;

export function createBoilerplateQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 30,
        retry: false,
      },
      mutations: {
        retry: 1,
      },
    },
  });
}

export function getTrpcClient() {
  if (trpcClientSingleton) {
    return trpcClientSingleton;
  }

  trpcClientSingleton = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${getApiBaseUrl()}/trpc`,
        headers() {
          const cookie = authClient.getCookie();
          return cookie ? { cookie } : {};
        },
      }),
    ],
  });

  return trpcClientSingleton;
}
