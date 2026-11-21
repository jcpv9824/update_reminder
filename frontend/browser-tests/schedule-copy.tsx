import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FrecuenciasPage from "../src/pages/FrecuenciasPage";
import "../src/styles.css";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <FrecuenciasPage />
  </QueryClientProvider>,
);
