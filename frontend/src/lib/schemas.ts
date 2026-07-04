/** Zod schemas mirroring the backend Pydantic ConfigSchema. */

import { z } from "zod";

/** Normalise JSON null → undefined so .optional() fields don't receive null from the backend. */
const nullishToUndef = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => v ?? undefined, schema);

export const OPERATORS = [">=", "<=", "==", "!=", "contains", "regex", "in"] as const;
export const operatorSchema = z.enum(OPERATORS);
export type Operator = z.infer<typeof operatorSchema>;

export const SOURCE_ROLES = ["primary", "lookup"] as const;
export const sourceRoleSchema = z.enum(SOURCE_ROLES);
export type SourceRole = z.infer<typeof sourceRoleSchema>;

export const JOIN_TYPES = ["left", "inner"] as const;
export const joinTypeSchema = z.enum(JOIN_TYPES);
export type JoinType = z.infer<typeof joinTypeSchema>;

/** A scalar Excel cell value. Conditions may also compare against a list (for `in`). */
export const cellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type CellValue = z.infer<typeof cellValueSchema>;

const qualified = (v: string) =>
  v.includes(".") && !v.startsWith(".") && !v.endsWith(".");

export const targetTemplateSchema = z.object({
  sheet: z.string().min(1),
  header_row: z.number().int().min(1),
  preserve_styles: z.boolean().default(true),
  columns: z.array(z.string()).min(1),
  sample_filename: nullishToUndef(z.string().optional()),
});

export const sourceSpecSchema = z.object({
  alias: z.string().min(1),
  role: sourceRoleSchema,
  sheet: z.string().min(1),
  header_row: z.number().int().min(1),
  sample_filename: nullishToUndef(z.string().optional()),
});

export const joinRuleSchema = z.object({
  left: z.string().refine(qualified, "err.qualified"),
  right: z.string().refine(qualified, "err.qualified"),
  type: joinTypeSchema.default("left"),
});

export const conditionSchema = z.object({
  field: z.string().refine(qualified, "err.qualified"),
  op: operatorSchema,
  value: z.union([cellValueSchema, z.array(cellValueSchema)]),
});

export const cellAddressPattern = /^[A-Z]+[1-9]\d*$/;

export const sourceCellSchema = z.object({
  alias: z.string().min(1),
  address: z.string().regex(cellAddressPattern, "err.cellAddress"),
});

export const mappingSchema = z
  .object({
    target: z.string().min(1),
    source: nullishToUndef(z.string().refine(qualified, "err.qualified").optional()),
    literal: cellValueSchema.optional(),
    source_cell: sourceCellSchema.nullable().optional(),
    conditions: z.array(conditionSchema).default([]),
    default: cellValueSchema.default(""),
  })
  .superRefine((m, ctx) => {
    const hasSource = m.source !== undefined && m.source !== "";
    const hasLiteral = m.literal !== undefined && m.literal !== null && m.literal !== "";
    const hasCell = m.source_cell !== undefined && m.source_cell !== null;
    const setCount = [hasSource, hasLiteral, hasCell].filter(Boolean).length;
    if (setCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "err.xorMode",
        path: ["source"],
      });
    }
    if (setCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "err.requireOneMode",
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
      .refine((v) => NAME_PATTERN.test(v), "err.invalidName"),
    target_template: targetTemplateSchema,
    sources: z.array(sourceSpecSchema).min(1),
    joins: z.array(joinRuleSchema).default([]),
    mappings: z.array(mappingSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const aliases = new Set(cfg.sources.map((s) => s.alias));
    if (aliases.size !== cfg.sources.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "err.duplicateAlias", path: ["sources"] });
    }
    if (!cfg.sources.some((s) => s.role === "primary")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "err.noPrimary", path: ["sources"] });
    }
    cfg.joins.forEach((j, i) => {
      for (const side of [j.left, j.right]) {
        const a = side.split(".", 1)[0];
        if (!aliases.has(a)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "err.joinUnknownAlias", params: { alias: a }, path: ["joins", i] });
        }
      }
    });
    cfg.mappings.forEach((m, i) => {
      if (m.source) {
        const a = m.source.split(".", 1)[0];
        if (!aliases.has(a)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "err.mappingSourceUnknownAlias", params: { alias: a }, path: ["mappings", i, "source"] });
        }
      }
      if (m.source_cell && !aliases.has(m.source_cell.alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "err.mappingCellUnknownAlias",
          params: { alias: m.source_cell.alias },
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
  /** ISO 8601 expiry time for re-download; absent before first download or after job dir is purged. */
  download_expires_at?: string | null;
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
