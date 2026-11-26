import { useEffect, useMemo } from "react";
import { Route, Routes } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { QueryScope } from "./components";
import ChecklistsPage from "./ChecklistsPage";
import NewChecklistPage from "./NewChecklistPage";
import ChecklistPage from "./ChecklistPage";
import "./checklists.css";
import "../queHayDeNuevo/queHayDeNuevo.css";
export const implementationPath = "/implementacion/checklists";
export default function ImplementationChecklistsRoutes() {
  const auth = useAuth(); const user = !auth.cargando ? auth.usuario : null; const qc = useQueryClient();
  const identity = user ? `${user.id}:${[...user.roles].sort().join(",")}` : "anonymous"; const scope = useMemo(() => ["implementation-checklists", identity], [identity]);
  useEffect(() => () => qc.removeQueries({ queryKey: scope }), [qc, scope]);
  if (!user) return <p role="alert">Debe iniciar sesión para continuar.</p>;
  return <QueryScope.Provider value={scope}><div className="checklists-page" key={identity}><Routes><Route index element={<ChecklistsPage />} /><Route path="nuevo" element={<NewChecklistPage />} /><Route path=":id" element={<ChecklistPage />} /></Routes></div></QueryScope.Provider>;
}
