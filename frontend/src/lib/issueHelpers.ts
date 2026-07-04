/** Pure helpers for bucketing and humanizing Zod issues from configSchema. */

import { z } from "zod";
import type { Mapping } from "./schemas";

// ── Types ──────────────────────────────────────────────────────────────────

export type IssueBuckets = {
  name: z.ZodIssue[];
  sources: z.ZodIssue[];
  sourcesByIndex: Map<number, z.ZodIssue[]>;
  joinsByIndex: Map<number, z.ZodIssue[]>;
  mappingsByIndex: Map<number, z.ZodIssue[]>;
};

export type HumanizedIssue = {
  /** i18n key for the label (e.g. "issue.label.mappingRow", "issue.label.join", …) */
  labelKey: string;
  /** i18n params for the label key */
  labelParams: Record<string, unknown>;
  /** The original Zod issue message key (e.g. "err.requireOneMode") */
  messageKey: string;
  /** i18n params for the message key */
  messageParams: Record<string, unknown>;
};

// ── bucketIssues ───────────────────────────────────────────────────────────

/**
 * Splits a flat ZodIssue[] (from configSchema.safeParse) into typed buckets
 * keyed by section and, where applicable, by 0-based row index.
 *
 * Path shapes handled:
 *   ["name"]                          → name
 *   ["sources"]                       → sources
 *   ["sources", N, ...]               → sourcesByIndex[N]
 *   ["joins", N, ...]                 → joinsByIndex[N]
 *   ["mappings", N, ...]              → mappingsByIndex[N]
 *   anything else                     → sources (safe fallback)
 */
export function bucketIssues(issues: z.ZodIssue[]): IssueBuckets {
  const buckets: IssueBuckets = {
    name: [],
    sources: [],
    sourcesByIndex: new Map(),
    joinsByIndex: new Map(),
    mappingsByIndex: new Map(),
  };

  for (const issue of issues) {
    const [seg0, seg1] = issue.path;

    if (seg0 === "name") {
      buckets.name.push(issue);
    } else if (seg0 === "sources") {
      if (typeof seg1 === "number") {
        addToMap(buckets.sourcesByIndex, seg1, issue);
      } else {
        buckets.sources.push(issue);
      }
    } else if (seg0 === "joins" && typeof seg1 === "number") {
      addToMap(buckets.joinsByIndex, seg1, issue);
    } else if (seg0 === "mappings" && typeof seg1 === "number") {
      addToMap(buckets.mappingsByIndex, seg1, issue);
    } else {
      // Fallback: treat as sources-level
      buckets.sources.push(issue);
    }
  }

  return buckets;
}

function addToMap(map: Map<number, z.ZodIssue[]>, idx: number, issue: z.ZodIssue) {
  const arr = map.get(idx) ?? [];
  arr.push(issue);
  map.set(idx, arr);
}

// ── humanizeIssue ──────────────────────────────────────────────────────────

/**
 * Converts a single ZodIssue into human-readable i18n keys+params.
 *
 * - mappings.N.* → issue.label.mappingRow (with the row's target column name)
 *                  or issue.label.mappingRowN with a 1-based row number
 * - joins.N.*    → issue.label.join with a 1-based group number
 * - sources.*    → issue.label.sources
 * - name         → issue.label.name
 * - other        → label "" (no label)
 *
 * The caller is responsible for translating the returned keys.
 */
export function humanizeIssue(
  issue: z.ZodIssue,
  mappings: Pick<Mapping, "target">[]
): HumanizedIssue {
  const [seg0, seg1] = issue.path;
  const params = (issue as z.ZodIssue & { params?: Record<string, unknown> }).params ?? {};

  let labelKey = "";
  let labelParams: Record<string, unknown> = {};

  if (seg0 === "mappings" && typeof seg1 === "number") {
    const target = mappings[seg1]?.target?.trim();
    if (target) {
      labelKey = "issue.label.mappingRow";
      labelParams = { target };
    } else {
      labelKey = "issue.label.mappingRowN";
      labelParams = { n: seg1 + 1 };
    }
  } else if (seg0 === "joins" && typeof seg1 === "number") {
    labelKey = "issue.label.join";
    labelParams = { n: seg1 + 1 };
  } else if (seg0 === "sources") {
    labelKey = "issue.label.sources";
    labelParams = {};
  } else if (seg0 === "name") {
    labelKey = "issue.label.name";
    labelParams = {};
  }

  return {
    labelKey,
    labelParams,
    messageKey: issue.message,
    messageParams: params,
  };
}
