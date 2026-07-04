/**
 * CJK guard: asserts no CJK character literals appear in TypeScript source files.
 * All user-facing strings must live in src/i18n/*.json and be accessed via t().
 *
 * To exempt a file add its path (relative to src/) to EXEMPTIONS.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

const EXEMPTIONS: string[] = [];

// CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF)
const CJK_RE = /[一-鿿㐀-䶿]/;

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Skip i18n directory — it is the allowed home for CJK strings.
      if (entry === "i18n") continue;
      results.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.|\.spec\./.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

describe("i18n CJK guard", () => {
  it("no CJK character literals in TypeScript source files", () => {
    const srcDir = join(__dirname, "..");
    const files = collectSourceFiles(srcDir);
    const violations: string[] = [];

    for (const file of files) {
      const relPath = relative(srcDir, file);
      if (EXEMPTIONS.includes(relPath)) continue;

      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (CJK_RE.test(lines[i])) {
          violations.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    expect(violations, `CJK literals found in source files:\n${violations.join("\n")}`).toEqual([]);
  });
});
