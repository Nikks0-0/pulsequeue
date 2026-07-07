const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export function getAccessToken(): string | null {
  return localStorage.getItem("pq_access_token");
}

export function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem("pq_access_token", accessToken);
  localStorage.setItem("pq_refresh_token", refreshToken);
}

export function clearTokens() {
  localStorage.removeItem("pq_access_token");
  localStorage.removeItem("pq_refresh_token");
}

export function getRefreshToken(): string | null {
  return localStorage.getItem("pq_refresh_token");
}

class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * A single fetch wrapper for every API call. On a 401 it attempts exactly
 * one silent refresh-and-retry before giving up and forcing re-login --
 * this mirrors the server's refresh-rotation design (Day 2) so the SPA
 * never surfaces "please log in again" for a routine expired access token.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
  isRetry = false
): Promise<T> {
  const token = getAccessToken();

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (response.status === 401 && !isRetry) {
    const refreshed = await tryRefresh();
    if (refreshed) return apiFetch<T>(path, options, true);
    clearTokens();
    window.location.href = "/login";
    throw new ApiError(401, null);
  }

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export { ApiError };
