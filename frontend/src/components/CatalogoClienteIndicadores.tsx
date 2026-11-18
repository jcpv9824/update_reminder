import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

type Ambiente = "production" | "test" | "demo" | "unknown";
type Indicador<T> = Readonly<{
  state: "verified" | "stale" | "unavailable";
  verifiedAt: string | null;
  partial: boolean;
  items: readonly T[];
}>;
type DominioObservado = Readonly<{
  host: string;
  observations: readonly Readonly<{ environment: Ambiente; startedOn: string | null }>[];
}>;
type LicenciaObservada = Readonly<{ code: string; environments: readonly Ambiente[] }>;
type CargarIndicador<T> = (id: string, signal: AbortSignal) => Promise<Indicador<T>>;
export type IndicadorDominiosCliente = Indicador<DominioObservado>;
export type IndicadorLicenciasCliente = Indicador<LicenciaObservada>;
export type CargarDominiosCliente = CargarIndicador<DominioObservado>;
export type CargarLicenciasCliente = CargarIndicador<LicenciaObservada>;
export type CargadoresIndicadores = Readonly<{ dominios?: CargarDominiosCliente; licencias?: CargarLicenciasCliente }>;

const AMBIENTES: Record<Ambiente, string> = {
  production: "Producción", test: "Pruebas", demo: "Demostración", unknown: "Ambiente no verificado",
};
const ESTADOS = { verified: "Verificada", stale: "Desactualizada", unavailable: "No disponible" };
const fechaBogota = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium", timeStyle: "short", timeZone: "America/Bogota",
});
const fechaCalendario = new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeZone: "UTC" });

function InicioObservado({ fecha }: { fecha: string | null }) {
  const dia = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? new Date(`${fecha}T00:00:00Z`) : null;
  return fecha && dia && Number.isFinite(dia.getTime()) && dia.toISOString().slice(0, 10) === fecha
    ? <time dateTime={fecha}>{fechaCalendario.format(dia)}</time> : <>Inicio no verificado</>;
}

export default function CatalogoClienteIndicadores({ scopeKey, customerId, indicadores }: {
  scopeKey: string;
  customerId: string;
  indicadores: CargadoresIndicadores;
}) {
  return (
    <>
      {indicadores.dominios && (
        <IndicadorColapsable scopeKey={scopeKey} customerId={customerId} tipo="dominios" titulo="Dominios observados"
          load={indicadores.dominios} renderItem={(dominio) => (
            <li key={dominio.host}>
              <strong>{dominio.host}</strong>
              {dominio.observations.length > 0 && <ul>{dominio.observations.map(observacion => (
                <li key={`${observacion.environment}:${observacion.startedOn ?? ""}`}>
                  {AMBIENTES[observacion.environment]} · <InicioObservado fecha={observacion.startedOn} />
                </li>
              ))}</ul>}
            </li>
          )} />
      )}
      {indicadores.licencias && (
        <IndicadorColapsable scopeKey={scopeKey} customerId={customerId} tipo="licencias" titulo="Licencias observadas"
          load={indicadores.licencias} renderItem={(licencia) => (
            <li key={licencia.code}>
              <strong>{licencia.code}</strong>
              {licencia.environments.length > 0 && <> · {licencia.environments.map(ambiente => AMBIENTES[ambiente]).join(", ")}</>}
            </li>
          )} />
      )}
    </>
  );
}

function IndicadorColapsable<T>(props: {
  scopeKey: string;
  customerId: string;
  tipo: "dominios" | "licencias";
  titulo: string;
  load: CargarIndicador<T>;
  renderItem: (item: T) => ReactNode;
}) {
  const id = useId();
  const [abierto, setAbierto] = useState(false);
  return (
    <div>
      <button type="button" className="secundario" onClick={() => setAbierto(!abierto)}
        aria-expanded={abierto} aria-controls={id}>
        {abierto ? "Ocultar" : "Ver"} {props.titulo.toLowerCase()}
      </button>
      <section id={id} aria-label={props.titulo} hidden={!abierto}>
        {abierto && <EvidenciaIndicador {...props} />}
      </section>
    </div>
  );
}

function EvidenciaIndicador<T>({ scopeKey, customerId, tipo, load, renderItem }: {
  scopeKey: string;
  customerId: string;
  tipo: "dominios" | "licencias";
  load: CargarIndicador<T>;
  renderItem: (item: T) => ReactNode;
}) {
  const consulta = useQuery({
    queryKey: ["catalogo-clientes", scopeKey, "indicadores", customerId, tipo],
    queryFn: ({ signal }) => load(customerId, signal),
    retry: false, gcTime: 0,
  });
  if (consulta.isError) return (
    <div role="alert">
      No se pudieron consultar {tipo === "dominios" ? "los dominios observados" : "las licencias observadas"} para el cliente.{" "}
      <button type="button" className="secundario" onClick={() => void consulta.refetch()}>Reintentar</button>
    </div>
  );
  if (consulta.isPending) return <p role="status">Consultando {tipo === "dominios" ? "dominios observados" : "licencias observadas"}…</p>;
  const { state, verifiedAt, partial, items } = consulta.data;
  return (
    <>
      <p role="status">Evidencia: {ESTADOS[state]}. Última verificación:{" "}
        {verifiedAt && Number.isFinite(Date.parse(verifiedAt))
          ? <time dateTime={verifiedAt}>{fechaBogota.format(new Date(verifiedAt))}</time>
          : "Sin fecha verificada"}.
      </p>
      {partial && <p>Información parcial: solo se muestran observaciones disponibles.</p>}
      {state === "unavailable" ? <p>No hay evidencia disponible sobre {tipo} para este cliente.</p>
        : items.length ? <ul>{items.map(renderItem)}</ul>
          : <p>No se observaron {tipo} en la información disponible.</p>}
    </>
  );
}
