import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErpClientCombobox } from "../pages/queHayDeNuevo/componentes/ErpClientCombobox";
import type { ErpClientLookup } from "../pages/queHayDeNuevo/contrato";

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, failed) => { resolve = ok; reject = failed; });
  return { promise, resolve, reject };
}

function mount(lookup: (q: string, signal?: AbortSignal) => Promise<ErpClientLookup[]>) {
  const onSelect = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <ErpClientCombobox name={null} readOnly={false} scope={["whats-new", "fixture-actor"]} lookup={lookup} onSelect={onSelect} />
  </QueryClientProvider>);
  const input = screen.getByRole("combobox", { name: /Cliente/ });
  act(() => input.focus());
  return { input, onSelect };
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Qué hay de nuevo · selector del ERP", () => {
  it("debounces for 120 ms after three trimmed characters and anchors results to the input, not its help text", async () => {
    vi.useFakeTimers();
    const pending = deferred<ErpClientLookup[]>();
    const lookup = vi.fn(() => pending.promise);
    const { input, onSelect } = mount(lookup);

    fireEvent.change(input, { target: { value: "  an " } });
    await tick(500);
    expect(lookup).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-expanded", "false");

    fireEvent.change(input, { target: { value: "  and " } });
    await tick(119);
    expect(lookup).not.toHaveBeenCalled();
    await tick(1);
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith("and", expect.any(AbortSignal));

    const choice = { id: "erp-qa-andina", label: "Andina Industrial QA" };
    pending.resolve([choice]);
    await tick(5);
    const list = screen.getByRole("listbox", { name: "Clientes del ERP" });
    const anchor = input.closest(".qhdn-erp-ancla");
    const help = document.getElementById(input.getAttribute("aria-describedby")!);
    expect(anchor).toContainElement(list);
    expect(anchor).not.toContainElement(help);
    expect(input).toHaveAttribute("aria-controls", list.id);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: choice.label }).id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(choice);
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("aborts superseded requests and never displays or selects their late answers", async () => {
    vi.useFakeTimers();
    const stale = deferred<ErpClientLookup[]>();
    const current = deferred<ErpClientLookup[]>();
    const lookup = vi.fn((q: string, _signal?: AbortSignal) => q === "and" ? stale.promise : current.promise);
    const { input, onSelect } = mount(lookup);

    fireEvent.change(input, { target: { value: "and" } });
    await tick(120);
    const firstSignal = lookup.mock.calls[0][1]!;
    fireEvent.change(input, { target: { value: "bog" } });
    expect(firstSignal.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Buscando");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    await tick(120);

    const bogota = { id: "erp-qa-bogota", label: "Bogotá Laboratorio QA" };
    current.resolve([bogota]);
    await tick(5);
    expect(screen.getByRole("option", { name: bogota.label })).toBeInTheDocument();

    // A transport that ignores AbortSignal still cannot replace the current result.
    stale.resolve([{ id: "erp-qa-andina", label: "Andina Industrial QA" }]);
    await tick(5);
    expect(screen.queryByRole("option", { name: /Andina/ })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(bogota);
  });

  it("cancels in-flight lookup when the user closes the list with Escape", async () => {
    vi.useFakeTimers();
    const pending = deferred<ErpClientLookup[]>();
    const lookup = vi.fn((_q: string, _signal?: AbortSignal) => pending.promise);
    const { input, onSelect } = mount(lookup);

    fireEvent.change(input, { target: { value: "and" } });
    await tick(120);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(lookup.mock.calls[0][1]?.aborted).toBe(true);
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveFocus();

    pending.resolve([{ id: "erp-qa-andina", label: "Andina Industrial QA" }]);
    await tick(5);
    expect(screen.queryByRole("listbox", { name: "Clientes del ERP" })).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
