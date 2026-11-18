export const CATALOG_ACTIVE_USERS_UNAVAILABLE = "No pudimos obtener los datos de esta base de datos." as const;

/**
 * Opaque identifiers supplied by the server-side verified destination registry.
 * The reader, not this report or its caller input, resolves the connection.
 */
export type CatalogActiveUserTarget = Readonly<{
  physicalDatabaseId: string;
  serverGroupId: string;
  reportingProfileId: string;
}>;

/** Pass only links already authorized for the requested report and recipients. */
export type CatalogActiveUserReportLink = Readonly<{
  clientId: string;
  clientName: string;
  databaseLinkId: string;
  databaseAlias: string;
  target: CatalogActiveUserTarget | null;
}>;

export type CatalogActiveUserCountReader = (
  target: CatalogActiveUserTarget,
  signal: AbortSignal,
) => Promise<number>;

export type CatalogActiveUserObservation =
  | Readonly<{ status: "available"; activeUsers: number; checkedAt: string }>
  | Readonly<{
    status: "unavailable";
    activeUsers: null;
    checkedAt: string;
    message: typeof CATALOG_ACTIVE_USERS_UNAVAILABLE;
  }>;

export type CatalogActiveUserReport = {
  rows: Array<Omit<CatalogActiveUserReportLink, "target"> & CatalogActiveUserObservation>;
  summary: {
    /** Sum of successful counts for distinct physical databases; not unique people. */
    activeUsers: number | null;
    physicalDatabases: number;
    verifiedCounts: number;
    unverifiedLinks: number;
    partial: boolean;
  };
};

export type CatalogActiveUserReportOptions = {
  maxConcurrent?: number;
  maxConcurrentPerServer?: number;
  perDatabaseTimeoutMs?: number;
  reportTimeoutMs?: number;
  signal?: AbortSignal;
};

type RegistryEntry = { target: CatalogActiveUserTarget; consistent: boolean };
type Job = { target: CatalogActiveUserTarget; controller: AbortController };

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum) : fallback;
}

function unavailable(): CatalogActiveUserObservation {
  return {
    status: "unavailable",
    activeUsers: null,
    checkedAt: new Date().toISOString(),
    message: CATALOG_ACTIVE_USERS_UNAVAILABLE,
  };
}

function hasTargetIds(target: CatalogActiveUserTarget | null): target is CatalogActiveUserTarget {
  return target !== null && [target.physicalDatabaseId, target.serverGroupId, target.reportingProfileId]
    .every(value => typeof value === "string" && value.trim().length > 0);
}

function sameReader(a: CatalogActiveUserTarget, b: CatalogActiveUserTarget): boolean {
  return a.serverGroupId === b.serverGroupId && a.reportingProfileId === b.reportingProfileId;
}

/**
 * Collect one aggregate observation per physical database. The reader must honor
 * cancellation and close its SQL request/connection. Even if it fails to do so,
 * a timed-out call keeps its slot until it settles, so it cannot cause fan-out.
 */
export async function collectCatalogActiveUserReport(
  links: readonly CatalogActiveUserReportLink[],
  readActiveUsers: CatalogActiveUserCountReader,
  options: CatalogActiveUserReportOptions = {},
): Promise<CatalogActiveUserReport> {
  const maxConcurrent = bounded(options.maxConcurrent, 6, 32);
  const maxPerServer = Math.min(maxConcurrent, bounded(options.maxConcurrentPerServer, 2, 8));
  const perDatabaseTimeoutMs = bounded(options.perDatabaseTimeoutMs, 4_000, 30_000);
  const reportTimeoutMs = bounded(options.reportTimeoutMs, 20_000, 120_000);
  const observations = new Map<string, CatalogActiveUserObservation>();
  const entries = new Map<string, RegistryEntry>();
  let unverifiedLinks = 0;

  for (const { target } of links) {
    if (!hasTargetIds(target)) {
      unverifiedLinks++;
      continue;
    }
    const current = entries.get(target.physicalDatabaseId);
    if (current) {
      current.consistent &&= sameReader(current.target, target);
    } else {
      const { physicalDatabaseId, serverGroupId, reportingProfileId } = target;
      entries.set(physicalDatabaseId, {
        target: { physicalDatabaseId, serverGroupId, reportingProfileId },
        consistent: true,
      });
    }
  }

  const pending: CatalogActiveUserTarget[] = [];
  for (const [id, entry] of entries) {
    if (entry.consistent) pending.push(entry.target);
    // Never switch to another principal or host for the same physical ID.
    else observations.set(id, unavailable());
  }

  if (pending.length > 0) {
    await new Promise<void>(resolve => {
      const running = new Set<Job>();
      const activePerServer = new Map<string, number>();
      const reportSignal = options.signal;
      let done = false;
      const deadline = setTimeout(stop, reportTimeoutMs);

      function stop() {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        reportSignal?.removeEventListener("abort", stop);
        for (const job of running) job.controller.abort();
        for (const id of entries.keys()) {
          if (!observations.has(id)) observations.set(id, unavailable());
        }
        resolve();
      }

      const record = (id: string, value: CatalogActiveUserObservation) => {
        if (done || observations.has(id)) return;
        observations.set(id, value);
        if (observations.size === entries.size) stop();
      };

      function launch(target: CatalogActiveUserTarget) {
        const { physicalDatabaseId, serverGroupId } = target;
        const controller = new AbortController();
        const job = { target, controller };
        running.add(job);
        activePerServer.set(serverGroupId, (activePerServer.get(serverGroupId) ?? 0) + 1);
        const abortTimer = () => clearTimeout(timeout);
        const timeout = setTimeout(() => {
          controller.abort();
          record(physicalDatabaseId, unavailable());
        }, perDatabaseTimeoutMs);
        controller.signal.addEventListener("abort", abortTimer, { once: true });

        function settle(value: CatalogActiveUserObservation) {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", abortTimer);
          running.delete(job);
          const count = (activePerServer.get(serverGroupId) ?? 1) - 1;
          if (count) activePerServer.set(serverGroupId, count);
          else activePerServer.delete(serverGroupId);
          record(physicalDatabaseId, value);
          pump();
        }

        void Promise.resolve()
          .then(() => {
            if (controller.signal.aborted) return undefined;
            return readActiveUsers(target, controller.signal);
          })
          .then(value => settle(typeof value === "number" && Number.isSafeInteger(value) && value >= 0
              ? { status: "available", activeUsers: value, checkedAt: new Date().toISOString() }
              : unavailable()), () => settle(unavailable()));
      }

      function pump() {
        while (!done && running.size < maxConcurrent) {
          const next = pending.findIndex(target => (activePerServer.get(target.serverGroupId) ?? 0) < maxPerServer);
          if (next < 0) break;
          launch(pending.splice(next, 1)[0]);
        }
      }

      reportSignal?.addEventListener("abort", stop, { once: true });
      if (reportSignal?.aborted) stop();
      else pump();
    });
  }

  let sum = 0;
  let verifiedCounts = 0;
  for (const value of observations.values()) {
    if (value.status !== "available") continue;
    sum += value.activeUsers;
    verifiedCounts++;
  }
  const overflow = !Number.isSafeInteger(sum);

  return {
    rows: links.map(({ clientId, clientName, databaseLinkId, databaseAlias, target }) => ({
      clientId,
      clientName,
      databaseLinkId,
      databaseAlias,
      ...(hasTargetIds(target) ? observations.get(target.physicalDatabaseId) ?? unavailable() : unavailable()),
    })),
    summary: {
      activeUsers: verifiedCounts > 0 && !overflow ? sum : null,
      physicalDatabases: entries.size,
      verifiedCounts,
      unverifiedLinks,
      partial: unverifiedLinks > 0 || verifiedCounts !== entries.size || overflow,
    },
  };
}
