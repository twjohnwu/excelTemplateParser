/** fetch wrapper + SSE helper with exponential-backoff auto-reconnect. */

export class ApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  detail?: unknown;

  constructor(status: number, message: string, opts?: { code?: string; requestId?: string; detail?: unknown }) {
    super(message);
    this.status = status;
    this.code = opts?.code;
    this.requestId = opts?.requestId;
    this.detail = opts?.detail;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const requestId = resp.headers.get("x-request-id") ?? undefined;

  if (resp.status === 204) return undefined as T;

  const ct = resp.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await resp.json() : await resp.text();

  if (!resp.ok) {
    const detail = typeof body === "object" && body !== null ? body : { error: body };
    const message = (detail.error as string) || (detail.detail?.error as string) || (typeof detail.detail === "string" ? detail.detail : resp.statusText);
    throw new ApiError(resp.status, message, {
      code: detail.code || detail.detail?.code,
      requestId,
      detail,
    });
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  postForm: <T>(path: string, form: FormData) =>
    request<T>(path, { method: "POST", body: form }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ---------- SSE ----------

export type SSEHandlers = {
  onSnapshot?: (data: unknown) => void;
  onUpdate?: (data: unknown) => void;
  onError?: (err: Event) => void;
  onOpen?: () => void;
};

/** Subscribe to SSE with auto-reconnect (exponential backoff starting at 3s).
 * Returns an unsubscribe function.
 */
export function subscribeJobEvents(jobId: string, h: SSEHandlers): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let retry = 0;

  const open = () => {
    if (closed) return;
    es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    es.onopen = () => {
      retry = 0;
      h.onOpen?.();
    };
    es.addEventListener("snapshot", (ev) => {
      try {
        h.onSnapshot?.(JSON.parse((ev as MessageEvent).data));
      } catch (e) {
        console.error("[sse] bad snapshot json", e);
      }
    });
    es.addEventListener("update", (ev) => {
      try {
        h.onUpdate?.(JSON.parse((ev as MessageEvent).data));
      } catch (e) {
        console.error("[sse] bad update json", e);
      }
    });
    es.onerror = (ev) => {
      h.onError?.(ev);
      es?.close();
      if (closed) return;
      const delay = Math.min(30000, 3000 * Math.pow(2, retry));
      retry++;
      setTimeout(open, delay);
    };
  };

  open();
  return () => {
    closed = true;
    es?.close();
  };
}
