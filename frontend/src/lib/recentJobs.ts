/** localStorage tracker of "jobs I started in this browser". */

const KEY = "etp.recentJobs.v1";
const MAX = 50;

export type RecentJob = {
  id: string;
  configName?: string;
  createdAt: string;
};

export function listRecent(): RecentJob[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecent(job: RecentJob): void {
  const existing = listRecent().filter((j) => j.id !== job.id);
  const next = [job, ...existing].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function removeRecent(id: string): void {
  const next = listRecent().filter((j) => j.id !== id);
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function clearRecent(): void {
  localStorage.removeItem(KEY);
}
