// ============================================================================
// Typed fetch helpers for the Hindsight HTTP API (PROTOCOL.md §6).
// All helpers throw an Error carrying the server's `{ error }` message on
// non-2xx responses.
// ============================================================================

import type {
  ActivateBody,
  AgentHealth,
  AppSettings,
  BenchmarkResponse,
  CreateSessionBody,
  RefineBody,
  RerunBody,
  Session,
  ShareInfo,
  SignalCheckResponse,
  SignalsOverview,
  UpdateSettingsBody,
} from '@/lib/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // A FormData body must NOT get an explicit Content-Type — only the browser
  // can write the multipart boundary parameter, and setting the header by hand
  // produces a body the server can't parse.
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const headers: HeadersInit | undefined =
    init?.body && !isFormData
      ? { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) }
      : (init?.headers as Record<string, string> | undefined);

  const res = await fetch(path, { ...init, headers, cache: 'no-store' });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data: unknown = await res.json();
      if (
        data !== null &&
        typeof data === 'object' &&
        'error' in data &&
        typeof (data as { error: unknown }).error === 'string'
      ) {
        message = (data as { error: string }).error;
      }
    } catch {
      // Non-JSON error body; keep the status-based message.
    }
    throw new Error(message);
  }

  return (await res.json()) as T;
}

/** GET /api/sessions — all sessions, newest first. */
export function listSessions(): Promise<Session[]> {
  return request<Session[]>('/api/sessions');
}

/** GET /api/sessions/[id] */
export function getSession(id: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}`);
}

/**
 * POST /api/sessions — create a strategy and kick off run #1.
 * With images it sends multipart instead of JSON (see PROTOCOL.md §6).
 */
export function createSession(body: CreateSessionBody, images?: File[]): Promise<Session> {
  if (images?.length) {
    const form = new FormData();
    form.set('prompt', body.prompt);
    if (body.period?.start) form.set('start', body.period.start);
    if (body.period?.end) form.set('end', body.period.end);
    if (body.startingCapital != null) form.set('startingCapital', String(body.startingCapital));
    for (const file of images) form.append('image', file);
    return request<Session>('/api/sessions', { method: 'POST', body: form });
  }
  return request<Session>('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * POST /api/sessions/[id]/messages — chat refinement (edits code + re-runs).
 * With images it sends multipart instead of JSON; `text` may then be empty.
 */
export function refine(id: string, text: string, images?: File[]): Promise<Session> {
  const path = `/api/sessions/${encodeURIComponent(id)}/messages`;
  if (images?.length) {
    const form = new FormData();
    form.set('text', text);
    for (const file of images) form.append('image', file);
    // No Content-Type header: the browser must set the multipart boundary.
    return request<Session>(path, { method: 'POST', body: form });
  }
  const body: RefineBody = { text };
  return request<Session>(path, { method: 'POST', body: JSON.stringify(body) });
}

/** URL serving an image the user attached to a chat message. */
export function attachmentUrl(sessionId: string, name: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(name)}`;
}

/** POST /api/sessions/[id]/rerun — re-run reusing saved code. */
export function rerun(id: string, body: RerunBody): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/rerun`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** GET /api/sessions/[id]/benchmark — validated curve for one strategy version. */
export function getBenchmark(
  id: string,
  options: { ticker?: string; backtestId?: string } = {},
): Promise<BenchmarkResponse> {
  const query = new URLSearchParams();
  if (options.ticker) query.set('ticker', options.ticker);
  if (options.backtestId) query.set('backtestId', options.backtestId);
  const suffix = query.size ? `?${query.toString()}` : '';
  return request<BenchmarkResponse>(`/api/sessions/${encodeURIComponent(id)}/benchmark${suffix}`);
}

/** POST /api/sessions/[id]/interrupt — hard-kill the active run. */
export function interrupt(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/interrupt`, {
    method: 'POST',
  });
}

/** DELETE /api/sessions/[id] */
export function deleteSession(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** POST /api/sessions/[id]/share — mint (or fetch) the share token. Idempotent. */
export function shareSession(id: string): Promise<ShareInfo> {
  return request<ShareInfo>(`/api/sessions/${encodeURIComponent(id)}/share`, { method: 'POST' });
}

/** DELETE /api/sessions/[id]/share — revoke the share link. */
export function unshareSession(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/share`, {
    method: 'DELETE',
  });
}

/** POST /api/sessions/[id]/activate — start scheduled signal checks. */
export function activateSession(id: string, phone?: string): Promise<Session> {
  const body: ActivateBody = phone ? { phone } : {};
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/activate`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** DELETE /api/sessions/[id]/activate — stop scheduled signal checks. */
export function deactivateSession(id: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/activate`, {
    method: 'DELETE',
  });
}

/** POST /api/sessions/[id]/activate/check — run one signal check right now. */
export function runSignalCheck(id: string): Promise<SignalCheckResponse> {
  return request<SignalCheckResponse>(`/api/sessions/${encodeURIComponent(id)}/activate/check`, {
    method: 'POST',
  });
}

/** GET /api/signals — activation defaults + every activated strategy. */
export function getSignalsOverview(): Promise<SignalsOverview> {
  return request<SignalsOverview>('/api/signals');
}

/** GET /api/settings — model + effort used for LLM-backed runs. */
export function getSettings(): Promise<AppSettings> {
  return request<AppSettings>('/api/settings');
}

/** PUT /api/settings — partial update; returns the merged settings. */
export function updateSettings(patch: UpdateSettingsBody): Promise<AppSettings> {
  return request<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
}

/** GET /api/health — can the selected agent run a backtest right now? */
export function getAgentHealth(): Promise<AgentHealth> {
  return request<AgentHealth>('/api/health');
}
