import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { Config } from "@/lib/schemas";

export function useConfigList() {
  return useQuery({
    queryKey: ["configs"],
    queryFn: () => api.get<{ configs: string[] }>("/api/configs"),
  });
}

export function useConfig(name: string | undefined) {
  return useQuery({
    queryKey: ["config", name],
    queryFn: () => api.get<Config>(`/api/configs/${encodeURIComponent(name!)}`),
    enabled: !!name,
  });
}

export function useSaveConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ config, overwrite }: { config: Config; overwrite?: boolean }) =>
      api.post<{ name: string; request_id?: string }>(
        `/api/configs${overwrite ? "?overwrite=true" : ""}`,
        config
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["configs"] }),
  });
}

export function useDeleteConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.delete<void>(`/api/configs/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["configs"] }),
  });
}
