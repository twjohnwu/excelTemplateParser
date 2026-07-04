import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { PreviewResult } from "@/lib/previewHelpers";
import type { Config } from "@/lib/schemas";

export type PreviewRequest = {
  config: Config;
  targetFile: File;
  /** alias → uploaded File, matching the backend's `sources[<alias>]` fields. */
  sourceFiles: Record<string, File>;
  n?: number;
};

export function previewConfig({ config, targetFile, sourceFiles, n = 20 }: PreviewRequest): Promise<PreviewResult> {
  const form = new FormData();
  form.append("config_json", JSON.stringify(config));
  form.append("target_template", targetFile);
  for (const [alias, file] of Object.entries(sourceFiles)) {
    form.append(`sources[${alias}]`, file);
  }
  form.append("n", String(n));
  return api.postForm<PreviewResult>("/api/configs/preview", form);
}

export function usePreviewConfig() {
  return useMutation({ mutationFn: previewConfig });
}
