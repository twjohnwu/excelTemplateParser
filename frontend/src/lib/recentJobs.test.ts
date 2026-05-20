import { afterEach, describe, expect, it } from "vitest";

import { addRecent, clearRecent, listRecent, removeRecent } from "./recentJobs";

afterEach(() => {
  localStorage.clear();
});

const mk = (id: string, name: string) => ({
  id,
  configName: name,
  createdAt: new Date().toISOString(),
});

describe("recentJobs", () => {
  it("starts empty", () => {
    expect(listRecent()).toEqual([]);
  });

  it("adds in newest-first order", () => {
    addRecent(mk("a", "first"));
    addRecent(mk("b", "second"));
    expect(listRecent().map((j) => j.id)).toEqual(["b", "a"]);
  });

  it("deduplicates when re-adding the same id", () => {
    addRecent(mk("a", "v1"));
    addRecent(mk("a", "v2"));
    const list = listRecent();
    expect(list).toHaveLength(1);
    expect(list[0].configName).toBe("v2");
  });

  it("removes by id", () => {
    addRecent(mk("a", "x"));
    addRecent(mk("b", "y"));
    removeRecent("a");
    expect(listRecent().map((j) => j.id)).toEqual(["b"]);
  });

  it("clearRecent wipes everything", () => {
    addRecent(mk("a", "x"));
    clearRecent();
    expect(listRecent()).toEqual([]);
  });

  it("survives corrupted localStorage", () => {
    localStorage.setItem("etp.recentJobs.v1", "not json");
    expect(listRecent()).toEqual([]);
  });

  it("caps the list at MAX entries (50)", () => {
    for (let i = 0; i < 60; i++) addRecent(mk(`id-${i}`, `n${i}`));
    expect(listRecent()).toHaveLength(50);
    // newest stays at front
    expect(listRecent()[0].id).toBe("id-59");
  });
});
