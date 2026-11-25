import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ErpClientLookup } from "../contrato";

const minimumLength = 3;
const debounceMs = 120;

export function ErpClientCombobox({ name, readOnly, scope, lookup, onSelect }: {
  name: string | null;
  readOnly: boolean;
  scope: string[];
  lookup: (q: string, signal?: AbortSignal) => Promise<ErpClientLookup[]>;
  onSelect: (choice: ErpClientLookup | null) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const serial = useRef(0);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [request, setRequest] = useState<{ term: string; serial: number }>();
  const term = input.trim();
  const valid = open && editing && !readOnly && term.length >= minimumLength;
  const isCurrent = valid && request?.term === term;
  const result = useQuery({
    queryKey: [...scope, "erp-clients", id, request?.term, request?.serial],
    queryFn: ({ signal }) => lookup(request!.term, signal),
    enabled: isCurrent,
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });
  const choices = isCurrent && result.isSuccess && !result.isFetching && Array.isArray(result.data) ? result.data : [];
  const activeChoice = choices[activeIndex];
  const popup = valid;

  useEffect(() => {
    if (!valid) return;
    const timer = setTimeout(() => setRequest({ term, serial: ++serial.current }), debounceMs);
    return () => clearTimeout(timer);
  }, [term, valid]);

  useEffect(() => {
    if (activeChoice) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeChoice, activeIndex, id]);

  function close() {
    setOpen(false);
    setEditing(false);
    setActiveIndex(-1);
    setRequest(undefined);
  }

  function choose(choice: ErpClientLookup) {
    onSelect(choice);
    close();
  }

  function retry() {
    setActiveIndex(-1);
    setRequest({ term, serial: ++serial.current });
  }

  function onKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") { close(); return; }
    if (event.key === "Enter") {
      event.preventDefault(); // Typing cannot create/save a client or submit the draft.
      if (activeChoice) choose(activeChoice);
      else if (isCurrent && result.isError) retry();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      if (choices.length) {
        setActiveIndex(i => event.key === "ArrowDown"
          ? (i + 1) % choices.length
          : i <= 0 ? choices.length - 1 : i - 1);
      }
    }
  }

  if (readOnly) return <p><strong>Cliente:</strong> {name || "Sin cliente seleccionado"}</p>;

  return <div className="qhdn-erp-cliente" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }}>
    <label htmlFor={id}><span aria-hidden="true">6. </span>Cliente *</label>
    <div className="qhdn-erp-ancla">
    <div className="qhdn-erp-campo">
      <input ref={inputRef} id={id} role="combobox" aria-autocomplete="list" aria-expanded={popup}
        aria-controls={popup ? `${id}-list` : undefined}
        aria-activedescendant={activeChoice ? `${id}-option-${activeIndex}` : undefined}
        aria-describedby={`${id}-help`} autoComplete="off" maxLength={100}
        placeholder="Busca un cliente del ERP" value={editing ? input : (name ?? "")}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={onKeys}
        onChange={event => {
          const next = event.target.value;
          setOpen(true); setEditing(true); setInput(next); setActiveIndex(-1);
          if (next.trim() !== term) setRequest(undefined);
        }} />
      {name && <button type="button" onClick={() => { onSelect(null); close(); inputRef.current?.focus(); }} aria-label="Quitar cliente">Quitar</button>}
    </div>
    {popup && <div className="qhdn-erp-desplegable">
      {valid && (!isCurrent || result.isFetching) && <p role="status">Buscando…</p>}
      {isCurrent && result.isError && <div className="qhdn-erp-error"><p role="alert">No se pudo consultar el catálogo del ERP.</p>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { retry(); inputRef.current?.focus(); }}>Reintentar</button><small>Pulsa Enter para reintentar.</small>
      </div>}
      {isCurrent && result.isSuccess && !result.isFetching && choices.length === 0 && <p role="status">Sin coincidencias en el ERP.</p>}
      <ul id={`${id}-list`} role="listbox" aria-label="Clientes del ERP">
        {choices.map((choice, index) => <li id={`${id}-option-${index}`} role="option" key={choice.id} aria-selected={index === activeIndex}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(choice)}>{choice.label}</li>)}
      </ul>
    </div>}
    </div>
    <p id={`${id}-help`} className="texto-ayuda">Escribe al menos 3 caracteres y selecciona un cliente del ERP.</p>
  </div>;
}
