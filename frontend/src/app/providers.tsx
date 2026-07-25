import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : undefined;
        return status === 401 || status === 400 || failureCount >= 2 ? false : true;
      },
      staleTime: 10_000,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
