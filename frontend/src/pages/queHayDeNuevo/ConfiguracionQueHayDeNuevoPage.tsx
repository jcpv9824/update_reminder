import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { BotonCopiar } from "../../components/Comunes";
import { useQueHayDeNuevo } from "./almacen";
import { AvisoPrototipo } from "./componentes/Comunes";
import { nuevoId } from "./logica";
import type { AccionPredefinida } from "./tipos";
import "./queHayDeNuevo.css";

/*
 * Configuración › Qué hay de nuevo. Decisión del propietario (3.ª ronda): solo la lista de acciones requeridas
 * predefinidas y el enlace para clientes. No hay menú de referencia.
 */

export default function ConfiguracionQueHayDeNuevoPage() {
  return (
    <div className="qhdn-pagina">
      <AvisoPrototipo />
      <div className="encabezado-pagina"><h2>Configuración · Qué hay de nuevo</h2></div>
      <AccionesPredefinidas />
      <EnlaceClientes />
    </div>
  );
}

function AccionesPredefinidas() {
  const { estado, guardarAccionesPredefinidas } = useQueHayDeNuevo();
  const [lista, setLista] = useState<AccionPredefinida[]>(() => [...estado.configuracion.accionesPredefinidas].sort((a, b) => a.orden - b.orden));
  const [mensaje, setMensaje] = useState<{ tipo: "error" | "exito"; texto: string } | null>(null);
  const base = useId();
  useEffect(() => setMensaje(null), [lista]);

  function mover(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= lista.length) return;
    const copia = [...lista];
    [copia[i], copia[j]] = [copia[j], copia[i]];
    setLista(copia);
  }

  return (
    <section className="tarjeta" aria-labelledby="titulo-acciones-pre">
      <h3 id="titulo-acciones-pre">Acciones requeridas predefinidas</h3>
      <p className="texto-ayuda">Aparecen como casillas en «Acción requerida». Las entradas guardan una copia del nombre, así que renombrar no cambia lo ya publicado.</p>
      <table>
        <caption className="sr-only">Acciones requeridas predefinidas</caption>
        <thead><tr><th scope="col">Orden</th><th scope="col">Nombre</th><th scope="col">Activa</th><th scope="col">Mover</th></tr></thead>
        <tbody>
          {lista.map((a, i) => (
            <tr key={a.id}>
              <td>{i + 1}</td>
              <td>
                <label htmlFor={`${base}-${a.id}`} className="sr-only">Nombre de la acción {i + 1}</label>
                <input id={`${base}-${a.id}`} value={a.nombre} maxLength={80} onChange={(e) => setLista(lista.map((x) => (x.id === a.id ? { ...x, nombre: e.target.value } : x)))} />
              </td>
              <td>
                <input type="checkbox" checked={a.activa} aria-label={`Activa: ${a.nombre || `acción ${i + 1}`}`} onChange={(e) => setLista(lista.map((x) => (x.id === a.id ? { ...x, activa: e.target.checked } : x)))} />
              </td>
              <td>
                <div className="acciones-tabla">
                  <button type="button" aria-label={`Subir ${a.nombre}`} disabled={i === 0} onClick={() => mover(i, -1)}><ChevronUp size={14} aria-hidden="true" /></button>
                  <button type="button" aria-label={`Bajar ${a.nombre}`} disabled={i === lista.length - 1} onClick={() => mover(i, 1)}><ChevronDown size={14} aria-hidden="true" /></button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {mensaje && <div className={`alerta alerta-${mensaje.tipo}`} role={mensaje.tipo === "error" ? "alert" : "status"}>{mensaje.texto}</div>}
      <div className="acciones-formulario">
        <button type="button" onClick={() => setLista([...lista, { id: nuevoId("accion"), nombre: "", orden: lista.length + 1, activa: true }])}>
          <Plus size={14} aria-hidden="true" /> Agregar acción
        </button>
        <button type="button" className="primario" onClick={() => {
          const error = guardarAccionesPredefinidas(lista);
          setMensaje(error ? { tipo: "error", texto: error } : { tipo: "exito", texto: "Acciones guardadas." });
        }}>Guardar acciones</button>
      </div>
    </section>
  );
}

function EnlaceClientes() {
  const { estado, cambiarPublicacionActiva } = useQueHayDeNuevo();
  const idSwitch = useId();
  const url = `${window.location.origin}/novedades`;
  return (
    <section className="tarjeta" aria-labelledby="titulo-enlace-clientes">
      <h3 id="titulo-enlace-clientes">Enlace para clientes</h3>
      <div className="endpoint-publico qhdn-fila">
        <code>{url}</code>
        <BotonCopiar valor={url} etiqueta="Copiar enlace" />
        <Link to="/novedades">Abrir página del cliente</Link>
      </div>
      <p className="texto-ayuda">En el prototipo, abre la página con el enlace de arriba (misma pestaña) para ver los cambios de esta sesión.</p>
      <div className="qhdn-switch-fila">
        <input id={idSwitch} type="checkbox" role="switch" checked={estado.configuracion.publicacionActiva} onChange={(e) => cambiarPublicacionActiva(e.target.checked)} aria-describedby={`${idSwitch}-ayuda`} />
        <label htmlFor={idSwitch}>Publicación activa</label>
      </div>
      <p id={`${idSwitch}-ayuda`} className="texto-ayuda" aria-live="polite">
        {estado.configuracion.publicacionActiva ? "Los clientes ven las novedades probadas y marcadas para mostrar." : "Apagada: el enlace muestra «Sin novedades por ahora»."}
      </p>
    </section>
  );
}
