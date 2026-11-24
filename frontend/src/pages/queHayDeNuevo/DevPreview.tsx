import { ProveedorQueHayDeNuevo, QueHayDeNuevoRuta, ConfiguracionQueHayDeNuevoRuta, NovedadesRuta } from "./rutas";
/** Imported only inside an import.meta.env.DEV branch; never emitted in production. */
export default function DevPreview({ kind }: { kind: "internal" | "config" | "public" }) {
  return <ProveedorQueHayDeNuevo>{kind === "internal" ? <QueHayDeNuevoRuta /> : kind === "config" ? <ConfiguracionQueHayDeNuevoRuta /> : <NovedadesRuta />}</ProveedorQueHayDeNuevo>;
}
