import { useMemo } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Dialogo } from "./componentes/Comunes";
import { VisorEnriquecido } from "./componentes/EditorEnriquecido";
import { safeDisplayDoc, whatsNewApi } from "./contrato";
import "./queHayDeNuevo.css";
import "./PublicNewsLive.css";

const categories = [["todo", "Todo"], ["nuevas", "Opciones nuevas"], ["mejoras", "Mejoras"]] as const;
const periods = [["todo", "Todo"], ["mes_actual", "Mes actual"], ["ultimos_3_meses", "Últimos 3 meses"],
  ["ultimo_ano", "Último año"], ["rango", "Rango de fechas"]] as const;
const publicRefreshMs = 60_000;
const validPublicDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

function releaseLabel(value: string) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) return value;
  return new Intl.DateTimeFormat("es-CO", { month: "long", year: "numeric", timeZone: "America/Bogota" })
    .format(new Date(`${value}-15T12:00:00Z`));
}

export default function PublicNewsLive() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const category = categories.find(([value]) => value === params.get("categoria"))?.[0] ?? "todo";
  const period = periods.find(([value]) => value === params.get("periodo"))?.[0] ?? "todo";
  const from = params.get("desde") ?? "";
  const to = params.get("hasta") ?? "";
  const candidatePage = Number(params.get("page"));
  const page = Number.isSafeInteger(candidatePage) && candidatePage > 0 && candidatePage <= 100_000 ? candidatePage : 1;
  const detailId = params.get("detalle");
  const validRange = period !== "rango" || (validPublicDate(from) && validPublicDate(to) && from <= to);
  const filters = { categoria: category, periodo: period, ...(period === "rango" ? { desde: from, hasta: to } : {}), page };
  const list = useQuery({
    queryKey: ["whats-new", "public", filters], queryFn: () => whatsNewApi.publicList(filters),
    enabled: validRange, refetchOnWindowFocus: true, refetchInterval: publicRefreshMs,
  });
  const available = validRange && !list.isError && list.data?.enabled === true;
  const detail = useQuery({
    queryKey: ["whats-new", "public-detail", detailId], queryFn: () => whatsNewApi.publicDetail(detailId!),
    enabled: !!detailId && available, refetchOnWindowFocus: true, refetchInterval: publicRefreshMs, retry: false, gcTime: 0,
  });
  const publicDoc = useMemo(() => safeDisplayDoc(detail.isError ? null : (detail.data?.body ?? null), true), [detail.isError, detail.data?.body]);

  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.delete("page");
    if (key === "periodo" && value !== "rango") { next.delete("desde"); next.delete("hasta"); }
    next.delete("detalle");
    setParams(next, { preventScrollReset: true });
  }
  const fromList = (location.state as { publicList?: boolean } | null)?.publicList === true;
  function closeDetail() {
    if (fromList) navigate(-1);
    else {
      const next = new URLSearchParams(params);
      next.delete("detalle");
      setParams(next, { replace: true, preventScrollReset: true });
    }
  }
  const data = list.data;
  return (
    <main className="qhdn-public">
      <header className="qhdn-public-header">
        <img src="/brand/sag-two-tone-icon.png" alt="" />
        <h1>Novedades de SAG Web</h1>
        <p>Conoce las opciones nuevas y las mejoras de SAG Web.</p>
      </header>
      <div className="qhdn-public-shell">
        <section className="qhdn-public-filters" aria-label="Filtros de novedades">
          <div className="qhdn-public-categories" role="group" aria-label="Tipo de novedad">
            {categories.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={category === value} onClick={() => change("categoria", value)}>{label}</button>
            ))}
          </div>
          <div className="qhdn-public-dates">
            <label>Fecha de liberación<select value={period} onChange={e => change("periodo", e.target.value)}>
              {periods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            {period === "rango" && <>
              <label>Desde<input type="date" value={from} max={to || undefined} onChange={e => change("desde", e.target.value)} /></label>
              <label>Hasta<input type="date" value={to} min={from || undefined} onChange={e => change("hasta", e.target.value)} /></label>
            </>}
          </div>
        </section>
        {!validRange ? <p role="alert">Selecciona un rango válido de fechas.</p> : list.isPending ? <p role="status">Cargando novedades…</p> : list.isError ? (
          <div><p role="alert">No pudimos cargar las novedades. Inténtalo de nuevo.</p><button type="button" onClick={() => void list.refetch()}>Reintentar</button></div>
        ) : !data?.enabled ? <p role="status">Las novedades no están disponibles por ahora.</p> : data.items.length === 0 ? (
          <div role="status"><p>No hay novedades para estos filtros.</p>{page > 1 && <button type="button" onClick={() => change("page", "1")}>Volver a la primera página</button>}</div>
        ) : <>
          <ul className="qhdn-public-list" aria-label="Novedades">
            {data.items.map(item => {
              const href = new URLSearchParams(params);
              href.set("detalle", item.publicId);
              return (
                <li key={item.publicId}><article className="qhdn-public-card">
                  <div className="qhdn-public-meta">
                    <span className="qhdn-public-badge">{item.category === "nuevo" || item.category === "nueva" ? "Opción nueva" : "Mejora"}</span>
                    <time dateTime={item.releaseMonth}>{releaseLabel(item.releaseMonth)}</time>
                  </div>
                  <h2>{item.title}</h2>
                  <p>{item.summary}</p>
                  <div className="qhdn-public-card-bottom">
                    <div><span>Dónde lo encuentras</span><p>{item.whereToFind}</p></div>
                    <Link className="qhdn-public-detail-link" to={{ search: href.toString() }} state={{ publicList: true }} preventScrollReset aria-label={`Ver detalle de ${item.title}`}>
                      Ver detalle <span aria-hidden="true">→</span>
                    </Link>
                  </div>
                </article></li>
              );
            })}
          </ul>
          {(page > 1 || data.total > data.pageSize) && <div className="qhdn-public-paging" role="group" aria-label="Paginación de novedades">
            <button type="button" disabled={page <= 1} onClick={() => change("page", String(page - 1))}>Anterior</button>
            <span>Página {page} de {Math.max(1, Math.ceil(data.total / data.pageSize))}</span>
            <button type="button" disabled={page * data.pageSize >= data.total} onClick={() => change("page", String(page + 1))}>Siguiente</button>
          </div>}
        </>}
      </div>
      <Dialogo titulo={!detail.isError && detail.data ? detail.data.title : "Detalle de la novedad"} abierto={!!detailId && available} onCerrar={closeDetail}>
        {detail.isPending ? <p role="status">Cargando novedad…</p> : detail.isError ? (
          <p role="alert">No pudimos cargar esta novedad. Es posible que ya no esté disponible.</p>
        ) : detail.data && <>
          <p><time dateTime={detail.data.releaseMonth}>{releaseLabel(detail.data.releaseMonth)}</time></p>
          <VisorEnriquecido valor={publicDoc} archivosPrivados={false} />
          <h4>Dónde lo encuentras</h4><p>{detail.data.whereToFind}</p>
        </>}
      </Dialogo>
    </main>
  );
}
