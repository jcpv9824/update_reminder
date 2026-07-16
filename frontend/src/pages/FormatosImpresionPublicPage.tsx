import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, apiUrl } from "../api/client";
import type { FormatoImpresion, FuenteFormato } from "../types";

const LOGO_SAG_WEB = "https://pya.com.co/wp-content/uploads/2025/12/H_LOGO.png";

export default function FormatosImpresionPublicPage() {
  const [fuenteId, setFuenteId] = useState("todas");
  const [busqueda, setBusqueda] = useState("");
  const [seleccionadoId, setSeleccionadoId] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState(false);
  const [total, setTotal] = useState(0);

  const { data: fuentes = [], isLoading: cargandoFuentes } = useQuery({
    queryKey: ["fuentes-formatos-public"],
    queryFn: () => api.get<FuenteFormato[]>("/public/fuentes-formatos"),
  });

  const { data: formatos = [], isLoading: cargandoFormatos } = useQuery({
    queryKey: ["formatos-impresion-public", fuenteId, busqueda],
    queryFn: () => {
      const params = new URLSearchParams();
      if (fuenteId !== "todas") params.set("fuente_id", fuenteId);
      if (busqueda.trim()) params.set("q", busqueda.trim());
      const qs = params.toString();
      return api.get<FormatoImpresion[]>(`/public/formatos-impresion${qs ? `?${qs}` : ""}`);
    },
  });

  const seleccionado = useMemo(
    () => formatos.find((formato) => formato.id === seleccionadoId) ?? formatos[0] ?? null,
    [formatos, seleccionadoId]
  );

  useEffect(() => {
    setPdfError(false);
    if (!formatos.some((formato) => formato.id === seleccionadoId)) {
      setSeleccionadoId(formatos[0]?.id ?? null);
    }
  }, [formatos, seleccionadoId]);

  useEffect(() => {
    if (fuenteId === "todas" && !busqueda.trim() && !cargandoFormatos) setTotal(formatos.length);
  }, [busqueda, cargandoFormatos, formatos.length, fuenteId]);

  return (
    <main className="catalogo-formatos-publico">
      <section className="catalogo-shell">
        <div className="catalogo-encabezado">
          <div>
            <h1>Catálogo de Formatos de Impresión</h1>
            <p>Catálogo de formatos de impresión disponibles en SAG Web.</p>
          </div>
          <img className="catalogo-logo" src={LOGO_SAG_WEB} alt="SAG Web" />
        </div>

        <div className="catalogo-grid">
          <aside className="catalogo-panel catalogo-fuentes">
            <h2>Filtrar por tipo de fuente</h2>
            <button
              className={fuenteId === "todas" ? "activo" : ""}
              onClick={() => setFuenteId("todas")}
            >
              <span>Todos los tipos</span><strong>{total}</strong>
            </button>
            {cargandoFuentes ? <div className="catalogo-vacio">Cargando...</div> : fuentes.map((fuente) => (
              <button
                key={fuente.id}
                className={fuenteId === fuente.id ? "activo" : ""}
                onClick={() => setFuenteId(fuente.id)}
                aria-label={`Filtrar por ${fuente.nombre}`}
              >
                <span>{fuente.nombre}</span><strong>{fuente.formatosActivos ?? 0}</strong>
              </button>
            ))}
          </aside>

          <section className="catalogo-panel catalogo-listado">
            <div className="buscador-limpiable buscador-formatos-publico">
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por nombre o descripción del formato..."
                aria-label="Buscar formato"
              />
              {busqueda && (
                <button type="button" onClick={() => setBusqueda("")} aria-label="Limpiar busqueda" title="Limpiar busqueda">
                  x
                </button>
              )}
            </div>
            {cargandoFormatos ? (
              <div className="catalogo-vacio">Cargando formatos...</div>
            ) : formatos.length === 0 ? (
              <div className="catalogo-vacio">No se encontraron formatos con los filtros seleccionados.</div>
            ) : (
              <div className="catalogo-resultados">
                {formatos.map((formato) => (
                  <button
                    key={formato.id}
                    className={seleccionado?.id === formato.id ? "activo" : ""}
                    onClick={() => { setSeleccionadoId(formato.id); setPdfError(false); }}
                  >
                    <strong>{formato.nombre}</strong>
                    <span>{(formato.fuenteNombres?.length ? formato.fuenteNombres : [formato.fuenteNombre]).join(" · ")}</span>
                    <small>{formato.descripcion}</small>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="catalogo-panel catalogo-preview">
            <div className="catalogo-preview-barra">
              <div>
                <h2>Vista previa del formato</h2>
                {seleccionado && <p>{seleccionado.nombre}</p>}
              </div>
            </div>
            {!seleccionado ? (
              <div className="catalogo-vacio catalogo-vacio-preview">Seleccione un formato de la lista para ver su vista previa.</div>
            ) : pdfError ? (
              <div className="catalogo-vacio catalogo-vacio-preview">No fue posible cargar la vista previa del formato. Intente nuevamente.</div>
            ) : (
              <iframe
                key={seleccionado.id}
                title={`Vista previa ${seleccionado.nombre}`}
                src={apiUrl(`/public/formatos-impresion/${seleccionado.id}/pdf`)}
                onError={() => setPdfError(true)}
              />
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
