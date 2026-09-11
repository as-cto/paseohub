import { DataCell, DataRow, DataTable } from "../components/app/data-table.js";
import { StatusPill } from "../components/app/status-pill.js";
import type { ProjectRouteView } from "./project-routes.js";

const COLUMNS = [
  { header: "Project route", className: "w-auto" },
  { header: "Event", className: "hidden w-64 min-w-64 md:table-cell" },
  { header: "Target", className: "hidden w-56 min-w-56 lg:table-cell" },
] as const;
const EMPTY = {
  title: "No published project routes",
  description: "Routes appear here when a project's .paseo bundle is published and activated.",
};

export function ProjectRoutesTable({ routes }: { routes: readonly ProjectRouteView[] }) {
  return (
    <section className="mb-8 min-w-0 space-y-3" aria-labelledby="project-routes-title">
      <div>
        <h2 id="project-routes-title">Project routes</h2>
        <p className="text-sm text-muted-foreground">
          Read from each project's active published bundle. Update its .paseo files and publish a
          new revision to change these routes.
        </p>
      </div>
      <DataTable
        label="Published project routes"
        columns={COLUMNS}
        isEmpty={routes.length === 0}
        empty={EMPTY}
      >
        {routes.map((route) => (
          <DataRow key={route.id}>
            <DataCell className="min-w-0 max-w-0 py-3 align-top whitespace-normal">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all">
                  {route.project.name} / {route.name}
                </span>
                <StatusPill tone="success">{`Published v${String(route.revision.version)}`}</StatusPill>
              </div>
              <span className="block break-all text-xs text-muted-foreground">
                {route.sourceFile ?? ".paseo bundle"}
              </span>
              <span className="block break-all text-sm md:hidden">{route.event}</span>
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground">Routing details</summary>
                <dl className="mt-2 space-y-2 text-xs">
                  <div>
                    <dt>Active revision</dt>
                    <dd className="break-all font-mono">{route.revision.id}</dd>
                  </div>
                  {route.targets.map((target) => (
                    <div key={target.step}>
                      <dt>
                        {target.step} · {target.environment}
                      </dt>
                      <dd className="break-all">
                        {target.daemon ?? "Configured environment"} {target.cwd ?? ""}
                      </dd>
                      <dd className="break-all font-mono">
                        {target.worktree === null
                          ? "No worktree configured"
                          : JSON.stringify(target.worktree)}
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>Trigger filters</dt>
                    <dd className="whitespace-pre-wrap break-all font-mono">
                      {JSON.stringify(route.filters, null, 2)}
                    </dd>
                  </div>
                </dl>
              </details>
            </DataCell>
            <DataCell className="hidden py-3 align-top whitespace-normal md:table-cell">
              <span className="break-all text-sm">{route.event}</span>
            </DataCell>
            <DataCell className="hidden py-3 align-top whitespace-normal lg:table-cell">
              {route.targets.map((target) => (
                <span key={target.step} className="block break-all text-sm">
                  {target.daemon ?? target.environment}
                  <span className="block text-xs text-muted-foreground">{target.cwd}</span>
                </span>
              ))}
            </DataCell>
          </DataRow>
        ))}
      </DataTable>
    </section>
  );
}
