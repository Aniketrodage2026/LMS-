import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, pick } from './client';
import { toUser, type User } from './models';

type Status = 'loading' | 'authenticated' | 'guest';
type Auth = { user: User | null; status: Status; refresh: () => Promise<User | null>; setUser: (u: User | null) => void; login: (email: string, password: string) => Promise<User>; logout: () => Promise<void> };
const Ctx = createContext<Auth | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const loadProfile = useCallback(async () => {
    try {
      const j = await api('/auth/getprofile');
      const profile = toUser(pick(j, 'user', 'profile'));
      const u = profile?.id ? profile : null;
      setUser(u); setStatus(u ? 'authenticated' : 'guest'); return u;
    } catch (error) { setUser(null); setStatus('guest'); throw error; }
  }, []);
  const refresh = useCallback(async () => {
    try { return await loadProfile(); } catch { return null; }
  }, [loadProfile]);
  useEffect(() => { void refresh(); }, [refresh]);
  const login = async (email: string, password: string) => {
    const j = await api('/auth/login', { body: { email, password } });
    let u = toUser(pick(j, 'user'));
    if (!u || !u.id) u = await loadProfile();
    if (!u) throw new ApiError(401, '', undefined, { code: 'AUTH_REQUIRED' });
    setUser(u); setStatus('authenticated'); return u;
  };
  const logout = async () => { try { await api('/auth/logout'); } finally { setUser(null); setStatus('guest'); } };
  return <Ctx.Provider value={{ user, status, refresh, setUser: u => { setUser(u); setStatus(u ? 'authenticated' : 'guest'); }, login, logout }}>{children}</Ctx.Provider>;
}
export function useAuth() { const c = useContext(Ctx); if (!c) throw new Error('AuthProvider is required'); return c; }
