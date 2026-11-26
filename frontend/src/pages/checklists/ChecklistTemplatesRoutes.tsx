import { useEffect, useMemo } from "react";
import { Route, Routes } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import ChecklistTemplatesPage from "./ChecklistTemplatesPage";
import ChecklistTemplatePage from "./ChecklistTemplatePage";
import ChecklistVersionPage from "./ChecklistVersionPage";
import { QueryScope } from "./components";
import "./checklists.css";
export default function ChecklistTemplatesRoutes() {
  const auth = useAuth(); const user = !auth.cargando ? auth.usuario : null; const qc = useQueryClient();
  const identity = user ? `${user.id}:${[...user.roles].sort().join(",")}` : "anonymous";
  const scope = useMemo(() => ["checklist-templates", identity], [identity]);
  useEffect(() => () => qc.removeQueries({ queryKey: scope }), [qc, scope]);
  if (!user) return <p role="alert">Debe iniciar sesión para continuar.</p>;
  return <QueryScope.Provider value={scope}><div className="checklists-page" key={identity}><Routes><Route index element={<ChecklistTemplatesPage />} /><Route path=":templateId" element={<ChecklistTemplatePage />} /><Route path=":templateId/versiones/:number" element={<ChecklistVersionPage />} /></Routes></div></QueryScope.Provider>;
}
