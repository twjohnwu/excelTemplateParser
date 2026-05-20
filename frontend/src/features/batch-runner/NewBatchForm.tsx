/** Left pane of BatchRunner: pick config → dynamic slots per source alias. */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FileDropzone } from "@/components/FileDropzone";
import { api, ApiError } from "@/lib/api";
import { useConfig, useConfigList } from "@/hooks/useConfigs";
import { addRecent } from "@/lib/recentJobs";
import { configSchema, type Config } from "@/lib/schemas";

type Props = {
  onJobCreated: () => void;
};

type SlotState = {
  alias: string;
  role: "primary" | "lookup";
  files: File[];
  sample_filename?: string;
};

export function NewBatchForm({ onJobCreated }: Props) {
  const { t } = useTranslation();
  const { data: list } = useConfigList();

  const [configName, setConfigName] = useState<string>("");
  const [inlineConfig, setInlineConfig] = useState<File | null>(null);
  const [resolvedConfig, setResolvedConfig] = useState<Config | null>(null);

  const { data: existing } = useConfig(configName || undefined);
  useEffect(() => {
    if (existing) setResolvedConfig(existing);
  }, [existing]);
  useEffect(() => {
    if (!inlineConfig) return;
    inlineConfig.text().then((text) => {
      try {
        setResolvedConfig(configSchema.parse(JSON.parse(text)));
      } catch (e) {
        setError(`config_json 解析失敗：${(e as Error).message}`);
      }
    });
  }, [inlineConfig]);

  const [target, setTarget] = useState<File | null>(null);
  const [slots, setSlots] = useState<SlotState[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!resolvedConfig) return;
    setSlots(
      resolvedConfig.sources.map((s) => ({
        alias: s.alias,
        role: s.role,
        files: [],
        sample_filename: s.sample_filename,
      }))
    );
  }, [resolvedConfig]);

  const updateSlot = (idx: number, files: File[]) =>
    setSlots(slots.map((s, i) => (i === idx ? { ...s, files } : s)));

  const primaryCount = slots
    .filter((s) => s.role === "primary")
    .reduce((sum, s) => sum + s.files.length, 0);

  const canSubmit = resolvedConfig && target && primaryCount >= 1 &&
    slots.filter((s) => s.role === "lookup").every((s) => s.files.length === 1);

  const submit = async () => {
    if (!resolvedConfig || !target) return;
    setSubmitting(true);
    setError(null);
    const form = new FormData();
    form.append("target_template", target);
    if (configName) form.append("config_name", configName);
    else if (inlineConfig) form.append("config_json", inlineConfig);
    for (const slot of slots) {
      for (const f of slot.files) {
        form.append(`sources[${slot.alias}]`, f);
      }
    }
    try {
      const { job_id } = await api.postForm<{ job_id: string }>("/api/jobs", form);
      addRecent({
        id: job_id,
        configName: resolvedConfig.name,
        createdAt: new Date().toISOString(),
      });
      // Reset for next batch.
      setTarget(null);
      setSlots(slots.map((s) => ({ ...s, files: [] })));
      onJobCreated();
    } catch (e) {
      if (e instanceof ApiError) setError(`${e.message}${e.requestId ? ` (id: ${e.requestId})` : ""}`);
      else setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 overflow-auto rounded-lg border p-4">
      <h3 className="text-sm font-semibold">{t("batch.newBatch")}</h3>

      <div>
        <Label>{t("batch.selectConfig")}</Label>
        <Select
          value={configName}
          onChange={(e) => {
            setConfigName(e.target.value);
            setInlineConfig(null);
          }}
        >
          <option value="">{t("batch.orUploadJson")}</option>
          {(list?.configs ?? []).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        {!configName && (
          <div className="mt-2">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => setInlineConfig(e.target.files?.[0] ?? null)}
              className="text-xs"
            />
          </div>
        )}
      </div>

      {resolvedConfig && (
        <>
          <div>
            <Label className="text-emerald-600">🎯 {t("batch.targetTemplate")}</Label>
            {resolvedConfig.target_template.sample_filename && (
              <p className="text-xs text-muted-foreground">
                {t("batch.lastFilename", { name: resolvedConfig.target_template.sample_filename })}
              </p>
            )}
            <FileDropzone
              accent="target"
              files={target ? [target] : []}
              onChange={(f) => setTarget(f[0] ?? null)}
              hint={t("config.uploadDropHint")}
            />
          </div>

          {slots.map((slot, idx) => {
            // Earlier slot using the same xlsx file? Offer to share its upload.
            const twinIdx = slot.sample_filename
              ? slots.findIndex(
                  (s, j) => j < idx && s.sample_filename === slot.sample_filename
                )
              : -1;
            const twin = twinIdx >= 0 ? slots[twinIdx] : null;
            const sharing = !!twin && slot.files.length > 0 && slot.files === twin.files;

            return (
              <div key={slot.alias}>
                <Label className={slot.role === "primary" ? "text-blue-600" : "text-muted-foreground"}>
                  {slot.role === "primary" ? "📥" : "📎"} {slot.alias} ({slot.role})
                </Label>
                <p className="text-xs text-muted-foreground">
                  {slot.role === "primary" ? t("batch.primarySlotHint") : t("batch.lookupSlotHint")}
                  {slot.sample_filename && (
                    <> · {t("batch.lastFilename", { name: slot.sample_filename })}</>
                  )}
                </p>

                {twin && twin.files.length > 0 && (
                  <label className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={sharing}
                      onChange={(e) => updateSlot(idx, e.target.checked ? twin.files : [])}
                    />
                    使用與 <code className="mx-1">{twin.alias}</code> 相同的檔案
                  </label>
                )}

                {!sharing && (
                  <FileDropzone
                    accent={slot.role}
                    multiple={slot.role === "primary"}
                    files={slot.files}
                    onChange={(f) => updateSlot(idx, f)}
                    hint={t("config.uploadDropHint")}
                  />
                )}
              </div>
            );
          })}

          <p className="text-xs text-muted-foreground">
            {t("batch.outputCount", { n: primaryCount })}
          </p>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button onClick={submit} disabled={!canSubmit || submitting} className="w-full">
            {t("batch.start")}
          </Button>
        </>
      )}
    </div>
  );
}
