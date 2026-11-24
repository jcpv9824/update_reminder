import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { Selection } from "@tiptap/pm/state";
import {
  AtSign,
  Bold,
  Code,
  ImagePlus,
  Italic,
  Link as IconoEnlace,
  List,
  ListOrdered,
  Palette,
  Paperclip,
  Quote,
  SquareCode,
  Strikethrough,
  Underline,
  type LucideIcon,
} from "lucide-react";
import type { DocEnriquecido, UsuarioPortal } from "../tipos";
import { extensionesEditor, formatoTamano } from "./extensiones";
import { useSubidaSimulada } from "./subidaSimulada";
import { aceptaDocumentoPrivado, tiposImagenPrivada, type ArchivoPrivado } from "./archivosPrivados";

// Build-time selection keeps the demo upload implementation out of release bundles.
const useSubidaEditor = import.meta.env.DEV ? useSubidaSimulada : () => null;

/*
 * Editor enriquecido compacto, inspirado en el editor pequeño de Azure DevOps.
 * El valor es SIEMPRE el JSON de TipTap; nunca se guarda ni se recibe HTML.
 * Tamaños: «mediano» (~5 filas) y «compacto» (~2 filas). Ambos crecen con el contenido.
 */

export type TamanoEditor = "mediano" | "compacto";
type CargarArchivo = (archivo: File, tipo: "imagen" | "documento") => Promise<ArchivoPrivado>;

type Props = {
  valor: DocEnriquecido | null;
  onChange?: (doc: DocEnriquecido) => void;
  onBlur?: () => void;
  tamano?: TamanoEditor;
  /** id del elemento visible que nombra el editor (p. ej. el <label> o <legend>). */
  etiquetaId?: string;
  ariaLabel?: string;
  descripcionId?: string;
  invalido?: boolean;
  placeholder?: string;
  soloLectura?: boolean;
  usuariosMencion?: UsuarioPortal[];
  /** Nombre corto para la barra: «Formato de Qué cambió». */
  nombreBarra?: string;
  /** Producción: no se simulan cargas; perfil alineado al contrato del servidor. */
  perfil?: "medio" | "compacto" | "cliente";
  archivosPrivados?: boolean;
  cargarArchivo?: CargarArchivo;
};

const COLORES = [
  { nombre: "Automático", valor: null },
  { nombre: "Azul", valor: "#1C3664" },
  { nombre: "Rojo", valor: "#b91c1c" },
  { nombre: "Verde", valor: "#047857" },
  { nombre: "Dorado", valor: "#8a6d1f" },
  { nombre: "Gris", valor: "#6b7280" },
];

const MAX_IMAGEN = 5 * 1024 * 1024;
const MAX_ARCHIVO = 20 * 1024 * 1024;
const TIPOS_IMAGEN = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function atributos(obj: Record<string, string | undefined | false>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

export function EditorEnriquecido({
  valor,
  onChange,
  onBlur,
  tamano = "mediano",
  etiquetaId,
  ariaLabel,
  descripcionId,
  invalido,
  placeholder,
  soloLectura = false,
  usuariosMencion = [],
  nombreBarra,
  perfil,
  archivosPrivados = false,
  cargarArchivo,
}: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  const cargarArchivoRef = useRef(cargarArchivo);
  cargarArchivoRef.current = cargarArchivo;
  const cursorPegado = useRef<number | null>(null);
  const [pegandoImagen, setPegandoImagen] = useState(false);
  const [errorPegado, setErrorPegado] = useState("");

  const extensiones = useMemo(() => extensionesEditor({ placeholder, soloLectura, perfil, archivosPrivados }), [placeholder, soloLectura, perfil, archivosPrivados]);

  const editor = useEditor({
    extensions: extensiones,
    content: valor ?? "",
    editable: !soloLectura,
    shouldRerenderOnTransaction: false,
    editorProps: {
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        if (!perfil || !data) return false;
        const archivos = Array.from(data.files);
        if (!archivos.length && data.items) for (const item of Array.from(data.items)) {
          if (item.kind === "file") { const file = item.getAsFile(); if (file) archivos.push(file); }
        }
        if (!archivos.length) return false;
        event.preventDefault();
        const subir = cargarArchivoRef.current;
        if (perfil !== "medio" || !archivosPrivados || !subir || soloLectura) {
          setErrorPegado("No se pueden pegar imágenes en este editor.");
          return true;
        }
        const imagen = archivos.find(file => tiposImagenPrivada.includes(file.type));
        if (!imagen) { setErrorPegado("Pega una imagen PNG, JPG, GIF o WebP."); return true; }
        if (cursorPegado.current !== null) return true;
        cursorPegado.current = view.state.selection.from;
        setErrorPegado(""); setPegandoImagen(true);
        void subir(imagen, "imagen").then(file => {
          if (view.isDestroyed || cursorPegado.current === null) return;
          const pos = Math.min(cursorPegado.current, view.state.doc.content.size);
          // Insert at the mapped paste point without overwriting any text typed during upload.
          const typ = view.state.schema.nodes.image;
          if (typ) {
            const node = typ.create({ fileId: file.fileId, alt: file.name.slice(0, 200) });
            const tx = view.state.tr.replaceRangeWith(pos, pos, node);
            if (tx.doc.lastChild?.type === typ) tx.insert(tx.doc.content.size, view.state.schema.nodes.paragraph.create());
            const after = Math.min(tx.mapping.map(pos, 1), tx.doc.content.size);
            tx.setSelection(Selection.near(tx.doc.resolve(after), 1));
            view.dispatch(tx);
          }
        }).catch(error => setErrorPegado(error instanceof Error ? error.message : "No se pudo guardar la imagen pegada."))
          .finally(() => { cursorPegado.current = null; setPegandoImagen(false); });
        return true;
      },
      attributes: atributos({
        class: `qhdn-editor-contenido${soloLectura ? " qhdn-editor-lectura" : ""}`,
        role: soloLectura ? undefined : "textbox",
        "aria-multiline": soloLectura ? undefined : "true",
        "aria-labelledby": etiquetaId,
        "aria-label": etiquetaId ? undefined : ariaLabel,
        "aria-describedby": descripcionId,
        "aria-invalid": invalido ? "true" : undefined,
      }),
    },
    onUpdate: ({ editor: e }) => onChangeRef.current?.(e.getJSON()),
    onTransaction: ({ transaction }) => {
      if (cursorPegado.current !== null) cursorPegado.current = transaction.mapping.map(cursorPegado.current);
    },
    onBlur: () => onBlurRef.current?.(),
  }, [extensiones, soloLectura, etiquetaId, descripcionId, invalido, ariaLabel]);

  // Si el valor cambia desde fuera (otra entrada, restablecer), se refleja sin emitir onChange.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (archivosPrivados && soloLectura && valor) {
      // Keep unchanged private image node views mounted while the author types
      // in the live preview. An all-document setContent would refetch the images.
      try {
        const current = editor.state.doc;
        const next = editor.schema.nodeFromJSON(valor);
        const start = current.content.findDiffStart(next.content);
        if (start === null) return;
        const end = current.content.findDiffEnd(next.content);
        if (end) {
          const overlap = Math.max(0, start - Math.min(end.a, end.b));
          const tx = editor.state.tr.replace(start, end.a + overlap, next.slice(start, end.b + overlap));
          if (tx.doc.eq(next)) {
            editor.view.dispatch(tx.setMeta("preventUpdate", true).setMeta("addToHistory", false));
            return;
          }
        }
      } catch { /* use the normal tolerant parser for historical documents */ }
    }
    const actual = JSON.stringify(editor.getJSON());
    const siguiente = JSON.stringify(valor ?? { type: "doc", content: [{ type: "paragraph" }] });
    if (actual !== siguiente) editor.commands.setContent(valor ?? "", { emitUpdate: false });
  }, [editor, valor, archivosPrivados, soloLectura]);

  if (soloLectura) {
    return <div className="qhdn-editor qhdn-editor-solo-lectura"><EditorContent editor={editor} /></div>;
  }

  return (
    <div className={`qhdn-editor qhdn-editor-${tamano}${invalido ? " qhdn-editor-invalido" : ""}`}>
      {editor && <BarraEditor editor={editor} usuariosMencion={usuariosMencion} nombre={nombreBarra ?? ariaLabel ?? "el texto"} perfil={perfil} cargarArchivo={archivosPrivados && perfil === "medio" ? cargarArchivo : undefined} />}
      <EditorContent editor={editor} />
      {pegandoImagen && <p role="status">Guardando la imagen pegada…</p>}
      {errorPegado && <p role="alert" className="qhdn-error-campo">{errorPegado}</p>}
    </div>
  );
}

/** Solo lectura: mismo esquema, sin barra. */
export function VisorEnriquecido({ valor, ariaLabel, archivosPrivados }: { valor: DocEnriquecido | null; ariaLabel?: string; archivosPrivados?: boolean }) {
  if (!valor) return <p className="texto-ayuda">Sin contenido.</p>;
  return <EditorEnriquecido valor={valor} soloLectura ariaLabel={ariaLabel} perfil={archivosPrivados ? "medio" : undefined} archivosPrivados={archivosPrivados} />;
}

type Panel = null | "enlace" | "color" | "mencion";

type PropsBoton = {
  indice: number;
  foco: number;
  setFoco: (i: number) => void;
  panelId: string;
  etiqueta: string;
  Icono: LucideIcon;
  activo?: boolean;
  /** El botón abre un panel: usa aria-expanded en vez de aria-pressed. */
  controla?: boolean;
  onClick: () => void;
};

function BotonBarra({ indice, foco, setFoco, panelId, etiqueta, Icono, activo, controla, onClick }: PropsBoton) {
  return (
    <button
      type="button"
      data-item-barra
      tabIndex={indice === foco ? 0 : -1}
      onFocus={() => setFoco(indice)}
      className={`qhdn-boton-barra${activo ? " activo" : ""}`}
      aria-label={etiqueta}
      title={etiqueta}
      aria-pressed={controla ? undefined : Boolean(activo)}
      aria-expanded={controla ? Boolean(activo) : undefined}
      aria-controls={controla && activo ? panelId : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icono size={15} aria-hidden="true" />
    </button>
  );
}

function BarraEditor({ editor, usuariosMencion, nombre, perfil, cargarArchivo }: { editor: Editor; usuariosMencion: UsuarioPortal[]; nombre: string; perfil?: "medio" | "compacto" | "cliente"; cargarArchivo?: CargarArchivo }) {
  const [panel, setPanel] = useState<Panel>(null);
  const [indiceFoco, setIndiceFoco] = useState(0);
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null);
  const [subiendoPrivado, setSubiendoPrivado] = useState(false);
  const cargaEnCurso = useRef(false);
  const barraRef = useRef<HTMLDivElement>(null);
  const inputImagen = useRef<HTMLInputElement>(null);
  const inputArchivo = useRef<HTMLInputElement>(null);
  const subida = useSubidaEditor();
  const idPanel = useId();

  const estado = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      titulo: e.isActive("heading", { level: 3 }),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      link: e.isActive("link"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      blockquote: e.isActive("blockquote"),
      code: e.isActive("code"),
      codeBlock: e.isActive("codeBlock"),
      color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
      href: (e.getAttributes("link").href as string | undefined) ?? "",
    }),
  });

  // Patrón de barra de herramientas WAI-ARIA: una sola parada de tabulación y flechas para moverse.
  function alTeclear(e: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    if ((e.target as HTMLElement).tagName === "SELECT" && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
    const items = Array.from(barraRef.current?.querySelectorAll<HTMLElement>("[data-item-barra]") ?? []);
    const actual = items.indexOf(document.activeElement as HTMLElement);
    if (actual < 0) return;
    e.preventDefault();
    let siguiente = actual;
    if (e.key === "ArrowRight") siguiente = (actual + 1) % items.length;
    if (e.key === "ArrowLeft") siguiente = (actual - 1 + items.length) % items.length;
    if (e.key === "Home") siguiente = 0;
    if (e.key === "End") siguiente = items.length - 1;
    setIndiceFoco(siguiente);
    items[siguiente].focus();
  }

  let contador = 0;
  const sig = () => contador++;
  const comun = { foco: indiceFoco, setFoco: setIndiceFoco, panelId: idPanel };
  const alternarPanel = (p: Panel) => setPanel((actual) => (actual === p ? null : p));

  const almacenamientoNoConectado = "El almacenamiento de archivos todavía no está conectado.";
  async function elegirArchivo(archivo: File | undefined, clase: "imagen" | "archivo") {
    setErrorArchivo(null);
    if (!archivo) return;
    if (cargarArchivo) {
      if (cargaEnCurso.current) return;
      cargaEnCurso.current = true;
      setSubiendoPrivado(true);
      try {
        const guardado = await cargarArchivo(archivo, clase === "imagen" ? "imagen" : "documento");
        if (editor.isDestroyed) return;
        if (clase === "imagen") editor.chain().focus().insertContent([
          { type: "image", attrs: { fileId: guardado.fileId, alt: guardado.name.slice(0, 200) } },
          { type: "paragraph" },
        ]).run();
        else editor.chain().focus().insertContent([{ type: "adjuntoArchivo", attrs: { fileId: guardado.fileId, nombre: guardado.name.slice(0, 200), tamano: guardado.bytes } }, { type: "text", text: " " }]).run();
      } catch (error) { setErrorArchivo(error instanceof Error ? error.message : "No se pudo subir el archivo."); }
      finally { cargaEnCurso.current = false; setSubiendoPrivado(false); }
      return;
    }
    if (perfil || !subida) return setErrorArchivo(almacenamientoNoConectado);
    if (clase === "imagen" && !TIPOS_IMAGEN.includes(archivo.type)) return setErrorArchivo("La imagen debe ser PNG, JPG, GIF o WebP.");
    if (archivo.size > (clase === "imagen" ? MAX_IMAGEN : MAX_ARCHIVO)) {
      return setErrorArchivo(`El archivo supera ${clase === "imagen" ? "5 MB" : "20 MB"}.`);
    }
    const url = await subida.subir(archivo);
    if (clase === "imagen") editor.chain().focus().setImage({ src: url, alt: archivo.name }).run();
    else editor.chain().focus().insertContent([{ type: "adjuntoArchivo", attrs: { href: url, nombre: archivo.name, tamano: archivo.size } }, { type: "text", text: " " }]).run();
  }

  const selectIndice = sig();
  const contenido: ReactNode = (
    <>
      <select
        data-item-barra
        tabIndex={selectIndice === indiceFoco ? 0 : -1}
        onFocus={() => setIndiceFoco(selectIndice)}
        className="qhdn-select-barra"
        aria-label="Estilo de párrafo"
        value={estado?.titulo ? "titulo" : "normal"}
        onChange={(e) => {
          if (e.target.value === "titulo") editor.chain().focus().setHeading({ level: 3 }).run();
          else editor.chain().focus().setParagraph().run();
        }}
      >
        <option value="normal">Normal</option>
        {perfil !== "compacto" && <option value="titulo">Título</option>}
      </select>
      <span className="qhdn-separador" aria-hidden="true" />
      <BotonBarra {...comun} indice={sig()} etiqueta="Negrita" Icono={Bold} activo={estado?.bold} onClick={() => editor.chain().focus().toggleBold().run()} />
      <BotonBarra {...comun} indice={sig()} etiqueta="Cursiva" Icono={Italic} activo={estado?.italic} onClick={() => editor.chain().focus().toggleItalic().run()} />
      <BotonBarra {...comun} indice={sig()} etiqueta="Subrayado" Icono={Underline} activo={estado?.underline} onClick={() => editor.chain().focus().toggleUnderline().run()} />
      <BotonBarra {...comun} indice={sig()} etiqueta="Tachado" Icono={Strikethrough} activo={estado?.strike} onClick={() => editor.chain().focus().toggleStrike().run()} />
      <BotonBarra {...comun} indice={sig()} etiqueta="Enlace" Icono={IconoEnlace} activo={panel === "enlace"} controla onClick={() => alternarPanel("enlace")} />
      <span className="qhdn-separador" aria-hidden="true" />
      <BotonBarra {...comun} indice={sig()} etiqueta="Lista con viñetas" Icono={List} activo={estado?.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()} />
      <BotonBarra {...comun} indice={sig()} etiqueta="Lista numerada" Icono={ListOrdered} activo={estado?.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
      {perfil !== "compacto" && <BotonBarra {...comun} indice={sig()} etiqueta="Cita" Icono={Quote} activo={estado?.blockquote} onClick={() => editor.chain().focus().toggleBlockquote().run()} />}
      {perfil !== "cliente" && <BotonBarra {...comun} indice={sig()} etiqueta="Código en línea" Icono={Code} activo={estado?.code} onClick={() => editor.chain().focus().toggleCode().run()} />}
      {(!perfil || perfil === "medio") && <BotonBarra {...comun} indice={sig()} etiqueta="Bloque de código" Icono={SquareCode} activo={estado?.codeBlock} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />}
      <BotonBarra {...comun} indice={sig()} etiqueta="Color del texto" Icono={Palette} activo={panel === "color"} controla onClick={() => alternarPanel("color")} />
      <span className="qhdn-separador" aria-hidden="true" />
      <BotonBarra {...comun} indice={sig()} etiqueta="Adjuntar archivo" Icono={Paperclip} onClick={() => { if (!cargaEnCurso.current) (cargarArchivo || (!perfil && subida)) ? inputArchivo.current?.click() : setErrorArchivo(almacenamientoNoConectado); }} />
      <BotonBarra {...comun} indice={sig()} etiqueta="Insertar imagen" Icono={ImagePlus} onClick={() => { if (!cargaEnCurso.current) (cargarArchivo || (!perfil && subida)) ? inputImagen.current?.click() : setErrorArchivo(almacenamientoNoConectado); }} />
      {usuariosMencion.length > 0 && <BotonBarra {...comun} indice={sig()} etiqueta="Mencionar a un usuario" Icono={AtSign} activo={panel === "mencion"} controla onClick={() => alternarPanel("mencion")} />}
    </>
  );

  return (
    <div className="qhdn-editor-cabecera">
      <div ref={barraRef} role="toolbar" aria-label={`Formato de ${nombre}`} className="qhdn-barra" onKeyDown={alTeclear}>
        {contenido}
      </div>
      <input ref={inputImagen} type="file" hidden accept={(cargarArchivo ? tiposImagenPrivada : TIPOS_IMAGEN).join(",")} onChange={(e) => { void elegirArchivo(e.target.files?.[0], "imagen"); e.target.value = ""; }} />
      <input ref={inputArchivo} type="file" hidden accept={cargarArchivo ? aceptaDocumentoPrivado : undefined} onChange={(e) => { void elegirArchivo(e.target.files?.[0], "archivo"); e.target.value = ""; }} />
      {panel && (
        <div id={idPanel} className="qhdn-editor-panel">
          {panel === "enlace" && <PanelEnlace editor={editor} hrefActual={estado?.href ?? ""} onCerrar={() => setPanel(null)} />}
          {panel === "color" && (
            <div role="group" aria-label="Colores del texto" className="qhdn-colores">
              {COLORES.map((c) => (
                <button
                  key={c.nombre}
                  type="button"
                  aria-label={`Color ${c.nombre.toLowerCase()}`}
                  aria-pressed={(estado?.color ?? null) === c.valor}
                  className="qhdn-color"
                  onClick={() => {
                    if (c.valor) editor.chain().focus().setColor(c.valor).run();
                    else editor.chain().focus().unsetColor().run();
                    setPanel(null);
                  }}
                >
                  <span aria-hidden="true" style={{ background: c.valor ?? "var(--color-text)" }} />
                  {c.nombre}
                </button>
              ))}
            </div>
          )}
          {panel === "mencion" && (
            <PanelMencion
              usuarios={usuariosMencion}
              onElegir={(u) => {
                editor.chain().focus().insertContent([{ type: "mencion", attrs: { id: u.id, etiqueta: u.nombre } }, { type: "text", text: " " }]).run();
                setPanel(null);
              }}
              onCerrar={() => setPanel(null)}
            />
          )}
        </div>
      )}
      {subida && subida.progreso !== null && (
        <div className="qhdn-subida" role="status" aria-live="polite">
          <span>Subiendo {subida.nombre}… {subida.progreso}%</span>
          <progress max={100} value={subida.progreso} aria-label={`Progreso de ${subida.nombre}`} />
        </div>
      )}
      {subiendoPrivado && <p role="status" aria-live="polite">Subiendo archivo a almacenamiento privado…</p>}
      {errorArchivo && <p className="qhdn-error-campo" role="alert">{errorArchivo}</p>}
    </div>
  );
}

function PanelEnlace({ editor, hrefActual, onCerrar }: { editor: Editor; hrefActual: string; onCerrar: () => void }) {
  const [url, setUrl] = useState(hrefActual);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  function aplicar() {
    const limpio = url.trim();
    if (!/^(https?:\/\/|mailto:)/i.test(limpio)) return setError("Escribe una dirección que empiece por https://, http:// o mailto:.");
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive("link")) {
      editor.chain().focus().insertContent({ type: "text", text: limpio, marks: [{ type: "link", attrs: { href: limpio } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: limpio }).run();
    }
    onCerrar();
  }
  return (
    <div className="qhdn-panel-enlace">
      <label htmlFor={id}>Dirección del enlace</label>
      <div className="qhdn-fila">
        <input
          id={id}
          autoFocus
          value={url}
          placeholder="https://"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); aplicar(); }
            if (e.key === "Escape") { e.preventDefault(); onCerrar(); }
          }}
        />
        <button type="button" className="primario" onClick={aplicar}>Aplicar</button>
        {hrefActual && <button type="button" onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); onCerrar(); }}>Quitar enlace</button>}
        <button type="button" onClick={onCerrar}>Cancelar</button>
      </div>
      {error && <p id={`${id}-error`} className="qhdn-error-campo" role="alert">{error}</p>}
    </div>
  );
}

function PanelMencion({ usuarios, onElegir, onCerrar }: { usuarios: UsuarioPortal[]; onElegir: (u: UsuarioPortal) => void; onCerrar: () => void }) {
  const [busqueda, setBusqueda] = useState("");
  const id = useId();
  const q = busqueda.trim().toLowerCase();
  const filtrados = usuarios.filter((u) => u.activo && (!q || u.nombre.toLowerCase().includes(q) || u.correo.toLowerCase().includes(q))).slice(0, 8);
  return (
    <div className="qhdn-panel-mencion">
      <label htmlFor={id}>Mencionar a un usuario</label>
      <input
        id={id}
        autoFocus
        type="search"
        value={busqueda}
        placeholder="Nombre o correo"
        onChange={(e) => setBusqueda(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCerrar(); } }}
      />
      <p className="texto-ayuda">La mención resalta el nombre. No envía avisos.</p>
      <ul className="qhdn-lista-mencion">
        {filtrados.length === 0 ? <li className="texto-ayuda">Sin coincidencias.</li> : filtrados.map((u) => (
          <li key={u.id}>
            <button type="button" onClick={() => onElegir(u)}>
              <strong>{u.nombre}</strong> <small>{u.correo}</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export { formatoTamano };
