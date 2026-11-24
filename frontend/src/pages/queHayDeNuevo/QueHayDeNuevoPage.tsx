import { useId } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { useQueHayDeNuevo } from "./almacen";
import { AvisoPrototipo } from "./componentes/Comunes";
import { esDesarrollador, esProbador } from "./logica";
import { DetalleDesarrollador, MisEntradas } from "./VistaDesarrollador";
import { FormularioEntrada } from "./FormularioEntrada";
import { BandejaPruebas } from "./VistaAsesor";
import { ReporteGuardado } from "./componentes/Reportes";
import "./queHayDeNuevo.css";

/*
 * Actualizaciones › Qué hay de nuevo. Una sola opción con dos visiones (H-01):
 * Desarrollador («Mis entradas») y Asesor («Bandeja de pruebas»).
 * En el prototipo, el usuario y la visión se simulan arriba de la página.
 */
export default function QueHayDeNuevoPage() {
  const { estado, usuarioActual, cambiarUsuario, cambiarVision } = useQueHayDeNuevo();
  const idUsuario = useId();
  const location = useLocation();
  const dev = esDesarrollador(usuarioActual);
  const soporte = esProbador(usuarioActual);
  const vision = dev && soporte ? estado.vision : dev ? "desarrollador" : soporte ? "asesor" : null;

  return (
    <div className="qhdn-pagina">
      <AvisoPrototipo />
      <div className="qhdn-simulacion" aria-label="Simulación de usuario y visión" role="group">
        <div className="qhdn-simulacion-usuario">
          <label htmlFor={idUsuario}>Usuario simulado</label>
          <select id={idUsuario} value={estado.usuarioActualId} onChange={(e) => cambiarUsuario(e.target.value)}>
            {estado.usuarios.filter((u) => u.activo).map((u) => (
              <option key={u.id} value={u.id}>{u.nombre} · {u.areas.join(" y ")}</option>
            ))}
          </select>
        </div>
        {dev && soporte && (
          <div className="qhdn-selector-vision" role="group" aria-label="Visión">
            <span className="qhdn-selector-vision-etiqueta" aria-hidden="true">Visión</span>
            <button type="button" aria-pressed={vision === "desarrollador"} className={vision === "desarrollador" ? "activo" : ""} onClick={() => cambiarVision("desarrollador")}>
              Desarrollador
            </button>
            <button type="button" aria-pressed={vision === "asesor"} className={vision === "asesor" ? "activo" : ""} onClick={() => cambiarVision("asesor")}>
              Asesor
            </button>
          </div>
        )}
      </div>

      <Routes>
        {/* Destino del enlace del correo del reporte: lo abre cualquiera de las dos visiones. */}
        <Route path="reportes/:id" element={vision ? <ReporteGuardado /> : null} />
        <Route path="*" element={null} />
      </Routes>
      {location.pathname.includes("/reportes/") && vision !== null ? null : vision === null ? (
        <div className="tarjeta qhdn-sin-acceso" role="alert">
          <h2>No tienes un área habilitada para esta opción</h2>
          <p>
            Crear entradas exige el área <strong>Desarrollo</strong> y probarlas exige el área <strong>Soporte</strong>.
            Pídele a un administrador que la asigne en Configuración › Usuarios y Roles.
          </p>
        </div>
      ) : vision === "asesor" ? (
        <BandejaPruebas />
      ) : (
        <Routes>
          <Route index element={<MisEntradas />} />
          <Route path="nueva" element={<FormularioEntrada modo="nueva" />} />
          <Route path=":id/editar" element={<FormularioEntrada modo="editar" />} />
          <Route path=":id/corregir" element={<FormularioEntrada modo="corregir" />} />
          <Route path=":id" element={<DetalleDesarrollador />} />
        </Routes>
      )}
    </div>
  );
}
