import type { HttpRequest } from "@azure/functions";

export type PageResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export function getPagination(req: HttpRequest): { enabled: boolean; page: number; pageSize: number } {
  const hasPage = req.query.has("page") || req.query.has("pageSize");
  const rawPage = Number(req.query.get("page") ?? "1");
  const rawPageSize = Number(req.query.get("pageSize") ?? "10");
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(Math.floor(rawPageSize), 100) : 10;
  return { enabled: hasPage, page, pageSize };
}

export function paginateArray<T>(items: T[], page: number, pageSize: number): PageResult<T> {
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    total: items.length,
  };
}
