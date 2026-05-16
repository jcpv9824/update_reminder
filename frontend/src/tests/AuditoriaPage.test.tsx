import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AuditoriaPage from "../pages/AuditoriaPage";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: apiMock }));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuditoriaPage />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.get.mockImplementation((path: string) => {
    if (path === "/clients") return Promise.resolve([]);
    if (path.startsWith("/audit-logs?")) return Promise.resolve({ items: [], page: 1, pageSize: 10, total: 0 });
    return Promise.resolve([]);
  });
});

describe("AuditoriaPage", () => {
  it("envía búsqueda general al endpoint paginado y conserva página 1", async () => {
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText("Buscar..."), { target: { value: "task_completed" } });

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("/audit-logs?page=1&pageSize=10&search=task_completed")));
  });
});
