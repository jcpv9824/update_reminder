import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api, restoreSession, setToken } from "../api/client";
import type { Usuario } from "../types";

type EstadoAuth =
  | { cargando: true }
  | { cargando: false; usuario: null; mensaje?: string }
  | { cargando: false; usuario: Usuario };

type Contexto = EstadoAuth & {
  entrar: (email: string, password: string) => Promise<void>;
  cerrarSesion: () => Promise<void>;
  recargar: () => Promise<void>;
};

const Ctx = createContext<Contexto | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<EstadoAuth>({ cargando: true });

  async function cargar() {
    if (!await restoreSession()) {
      setEstado({ cargando: false, usuario: null });
      return;
    }
    setEstado({ cargando: true });
    try {
      const r = await api.get<{ authenticated: boolean; registered: boolean; active?: boolean; user?: Usuario; message?: string }>("/me");
      if (r.authenticated && r.registered && r.active !== false && r.user) {
        setEstado({ cargando: false, usuario: r.user });
      } else if (r.active === false) {
        setToken(null);
        setEstado({ cargando: false, usuario: null, mensaje: r.message ?? "Tu usuario está inactivo. Contacta al administrador." });
      } else {
        setToken(null);
        setEstado({ cargando: false, usuario: null, mensaje: r.message });
      }
    } catch {
      setToken(null);
      setEstado({ cargando: false, usuario: null });
    }
  }

  useEffect(() => { cargar(); }, []);

  async function entrar(email: string, password: string) {
    const r = await api.post<{ token: string; user: Usuario }>("/auth/login", { email, password });
    setToken(r.token);
    setEstado({ cargando: false, usuario: r.user });
  }

  async function cerrarSesion() {
    await api.post<void>("/auth/logout");
    setToken(null);
    setEstado({ cargando: false, usuario: null });
  }

  return (
    <Ctx.Provider value={{ ...estado, entrar, cerrarSesion, recargar: cargar }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("AuthProvider no inicializado.");
  return ctx;
}
