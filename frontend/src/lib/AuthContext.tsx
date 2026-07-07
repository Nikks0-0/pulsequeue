import { createContext, useContext, useState, useCallback, ReactNode, useEffect } from "react";
import { apiFetch, setTokens, clearTokens, getAccessToken } from "./api";
import { User } from "./types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (tenantName: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMe = useCallback(async () => {
    if (!getAccessToken()) {
      setLoading(false);
      return;
    }
    try {
      const me = await apiFetch<User>("/api/v1/auth/me");
      setUser(me);
    } catch {
      clearTokens();
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiFetch<{ accessToken: string; refreshToken: string; user: User }>(
      "/api/v1/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) }
    );
    setTokens(data.accessToken, data.refreshToken);
    setUser(data.user);
  }, []);

  const register = useCallback(async (tenantName: string, email: string, password: string) => {
    const data = await apiFetch<{ accessToken: string; refreshToken: string; user: User }>(
      "/api/v1/auth/register",
      { method: "POST", body: JSON.stringify({ tenantName, email, password }) }
    );
    setTokens(data.accessToken, data.refreshToken);
    setUser(data.user);
  }, []);

  const logout = useCallback(() => {
    clearTokens();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
