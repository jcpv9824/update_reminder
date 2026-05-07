import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api } from "../api/client";
import type { Usuario } from "../types";

type RespuestaMe = {
  authenticated: boolean;
  registered: boolean;
  active?: boolean;
  user?: Usuario;
  message?: string;
};

type EstadoAuth =
  | { cargando: true }
  | { cargando: false; usuario: null; mensaje?: string }
  | { cargando: false; usuario: Usuario };

type Contexto = EstadoAuth & {
  iniciarSesionDev: (u: Usuario) => void;
  cerrarSesion: () => void;
  recargar: () => Promise<void>;
};

const Ctx = createContext<Contexto | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<EstadoAuth>({ cargando: true });

  async function cargar() {
    setEstado({ cargando: true });
    try {
      const r = await api.get<RespuestaMe>("/me");
      if (r.authenticated && r.registered && r.active !== false && r.user) {
        setEstado({ cargando: false, usuario: r.user });
      } else if (r.authenticated && r.registered && r.active === false) {
        setEstado({ cargando: false, usuario: null, mensaje: r.message ?? "Tu usuario está inactivo. Contacta al administrador." });
      } else if (r.authenticated && !r.registered) {
        setEstado({ cargando: false, usuario: null, mensaje: r.message ?? "No tienes acceso a esta aplicación. Solicita a un administrador que registre tu usuario." });
      } else {
        setEstado({ cargando: false, usuario: null });
      }
    } catch {
      setEstado({ cargando: false, usuario: null });
    }
  }

  useEffect(() => { cargar(); }, []);

  const iniciarSesionDev = (u: Usuario) => {
    localStorage.setItem("devUser", JSON.stringify(u));
    cargar();
  };
  const cerrarSesion = () => {
    localStorage.removeItem("devUser");
    setEstado({ cargando: false, usuario: null });
    // Si está autenticado por Static Web Apps, redirigir al endpoint de logout.
    if ((window as any).location && document.cookie.includes("StaticWebAppsAuthCookie")) {
      window.location.href = "/.auth/logout";
    }
  };

  return (
    <Ctx.Provider value={{ ...estado, iniciarSesionDev, cerrarSesion, recargar: cargar }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("AuthProvider no inicializado.");
  return ctx;
}
