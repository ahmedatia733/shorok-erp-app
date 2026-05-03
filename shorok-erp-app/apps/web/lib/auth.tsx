"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Role } from "@shorok/shared";
import { apiCall, loginWithPhone, logout, setAccessToken } from "./api-client";
import type { AppLocale } from "../i18n";

export interface CurrentUser {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: Role;
  status: "ACTIVE" | "DISABLED";
  allowedBranches: string[];
}

interface AuthContextValue {
  user: CurrentUser | null;
  isLoading: boolean;
  login: (phone: string, password: string, locale: AppLocale) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await apiCall<CurrentUser>("/auth/me");
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // On mount, try /me — if the refresh cookie is valid the api-client will
  // auto-refresh and we'll land logged in.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (phone: string, password: string, locale: AppLocale) => {
      await loginWithPhone(phone, password, locale);
      await refresh();
    },
    [refresh],
  );

  const doLogout = useCallback(async () => {
    await logout();
    setAccessToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, isLoading, login, logout: doLogout, refresh }),
    [user, isLoading, login, doLogout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export function useCurrentUser(): CurrentUser | null {
  return useAuth().user;
}

export function useHasRole(...roles: Role[]): boolean {
  const user = useCurrentUser();
  if (!user) return false;
  if (user.role === "OWNER") return true;
  return roles.includes(user.role);
}
