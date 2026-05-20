/** Zod schemas mirroring the backend Pydantic ConfigSchema. */

import { z } from "zod";

export const operatorSchema = z.enum([">=", "<=", "==", "!=", "contains", "regex", "in"]);
export type Operator = z.infer<typeof operatorSchema>;

export const sourceRoleSchema = z.enum(["primary", "lookup"]);
export type SourceRole = z.infer<typeof sourceRoleSchema>;

export const joinTypeSchema = z.enum(["left", "inner"]);
export type JoinType = z.infer<typeof joinTypeSchema>;

const qualified = (v: string) =>
  v.includes(".") && !v.startsWith(".") && !v.endsWith(".");

export const targetTemplateSchema = z.object({
  sheet: z.string().min(1),
  header_row: z.number().int().min(1),
  preserve_styles: z.boolean().default(true),
  columns: z.array(z.string()).min(1),
  sample_filename: z.string().optional(),
});

export const sourceSpecSchema = z.object({
  alias: z.string().min(1),
  role: sourceRoleSchema,
  sheet: z.string().min(1),
  header_row: z.number().int().min(1),
  sample_filename: z.string().optional(),
});

export const joinRuleSchema = z.object({
  left: z.string().refine(qualified, "必須為 alias.column"),
  right: z.string().refine(qualified, "必須為 alias.column"),
  type: joinTypeSchema.default("left"),
});

export const conditionSchema = z.object({
  field: z.string().refine(qualified, "必須為 alias.column"),
  op: operatorSchema,
  value: z.unknown(),
});

export const cellAddressPattern = /^[A-Z]+[1-9]\d*$/;

export const sourceCellSchema = z.object({
  alias: z.string().min(1),
  address: z.string().regex(cellAddressPattern, "需為 Excel 位址，例如 A3"),
});

export const mappingSchema = z
  .object({
    target: z.string().min(1),
    source: z.string().refine(qualified, "必須為 alias.column").optional(),
    literal: z.unknown().optional(),
    source_cell: sourceCellSchema.nullable().optional(),
    conditions: z.array(conditionSchema).default([]),
    default: z.unknown().default(""),
  })
  .superRefine((m, ctx) => {
    const hasSource = m.source !== undefined && m.source !== "";
    const hasLiteral = m.literal !== undefined && m.literal !== null && m.literal !== "";
    const hasCell = m.source_cell !== undefined && m.source_cell !== null;
    const setCount = [hasSource, hasLiteral, hasCell].filter(Boolean).length;
    if (setCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source / source_cell / literal 只能擇一",
        path: ["source"],
      });
    }
    if (setCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "需指定 source、source_cell 或 literal 其中一個",
        path: ["source"],
      });
    }
  });

export const NAME_PATTERN = /^[\p{L}\p{N}_\- ]{1,80}$/u;

export const configSchema = z
  .object({
    version: z.string().default("1.0"),
    name: z
      .string()
      .transform((v) => v.trim())
      .refine((v) => NAME_PATTERN.test(v), "專案名稱僅可含中英文/數字/底線/連字號/空格，長度 1–80"),
    target_template: targetTemplateSchema,
    sources: z.array(sourceSpecSchema).min(1),
    joins: z.array(joinRuleSchema).default([]),
    mappings: z.array(mappingSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const aliases = new Set(cfg.sources.map((s) => s.alias));
    if (aliases.size !== cfg.sources.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sources alias 不可重複", path: ["sources"] });
    }
    if (!cfg.sources.some((s) => s.role === "primary")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "至少需要一個 role=primary 的 source", path: ["sources"] });
    }
    cfg.joins.forEach((j, i) => {
      for (const side of [j.left, j.right]) {
        const a = side.split(".", 1)[0];
        if (!aliases.has(a)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `join 引用了不存在的 alias: ${a}`, path: ["joins", i] });
        }
      }
    });
    cfg.mappings.forEach((m, i) => {
      if (m.source) {
        const a = m.source.split(".", 1)[0];
        if (!aliases.has(a)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `mapping.source 引用了不存在的 alias: ${a}`, path: ["mappings", i, "source"] });
        }
      }
      if (m.source_cell && !aliases.has(m.source_cell.alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `mapping.source_cell 引用了不存在的 alias: ${m.source_cell.alias}`,
          path: ["mappings", i, "source_cell", "alias"],
        });
      }
    });
  });

export type Condition = z.infer<typeof conditionSchema>;
export type Mapping = z.infer<typeof mappingSchema>;
export type SourceSpec = z.infer<typeof sourceSpecSchema>;
export type JoinRule = z.infer<typeof joinRuleSchema>;
export type TargetTemplate = z.infer<typeof targetTemplateSchema>;
export type Config = z.infer<typeof configSchema>;

// ---------- Runtime DTOs ----------

export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export type SubtaskStatus = "pending" | "running" | "done" | "failed";

export type JobSnapshot = {
  job_id: string;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  eta_seconds?: number | null;
  error?: string | null;
  config_name?: string | null;
};

export type SubtaskState = {
  source_file: string;
  status: SubtaskStatus;
  duration_ms?: number | null;
  user_message?: string | null;
  tech_detail?: string | null;
};

export type JobState = {
  job_id: string;
  config_name?: string | null;
  status: JobStatus;
  created_at: string;
  download_started_at?: string | null;
  subtasks: Record<string, SubtaskState>;
  cancel_requested: boolean;
};
