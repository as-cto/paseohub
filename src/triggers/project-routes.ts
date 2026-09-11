import type { Database, ProjectRecord } from "../db/types.js";
import { parseCompiledHubConfig } from "../config/compiler.js";

/** A projection of the published bundle; never a second source of routing authority. */
export async function readProjectRoutes(database: Database, organizationId: string) {
  const projects = await database.listProjectsForOrganization(organizationId);
  const snapshots = await Promise.all(
    projects.map((project) => readProjectRoute(database, project)),
  );
  return {
    routes: snapshots.flatMap((snapshot) => snapshot.routes),
    activity: snapshots.flatMap((snapshot) => snapshot.activity),
  };
}

async function readProjectRoute(database: Database, project: ProjectRecord) {
  const revision = await database.findActiveProjectConfiguration(project.id);
  if (revision === undefined) return { routes: [], activity: [] };
  const configuration = parseCompiledHubConfig(revision.normalizedConfiguration);
  const activity = (await database.listProjectActivityRuns(project.id, 100)).map(
    ({ run, receipt }) => ({
      id: run.id,
      triggerId: `project:${project.id}:${run.configuredTriggerName}`,
      triggerName: `${project.name} / ${run.configuredTriggerName}`,
      provider: receipt.provider,
      source: receipt.source,
      repo: receipt.repo,
      status: run.status,
      receivedAt: receipt.receivedAt.toISOString(),
    }),
  );
  const routes = configuration.triggers.map((trigger) => ({
    id: `project:${project.id}:${trigger.name}`,
    source: "project_bundle" as const,
    name: trigger.name,
    event: trigger.on,
    project: { id: project.id, name: project.name, slug: project.slug },
    revision: { id: revision.id, version: revision.version },
    sourceFile: trigger.sourceFile ?? null,
    filters: trigger.filters ?? {},
    targets: trigger.steps.map((step) => {
      const environment = configuration.environments.find((item) => item.name === step.environment);
      if (environment?.kind !== "daemon")
        return {
          step: step.id,
          environment: step.environment,
          daemon: null,
          cwd: null,
          worktree: null,
        };
      return {
        step: step.id,
        environment: step.environment,
        daemon: environment.daemon,
        cwd: environment.cwd,
        worktree: environment.worktree ?? null,
      };
    }),
    lastTriggered:
      activity.find((run) => run.triggerId === `project:${project.id}:${trigger.name}`) ?? null,
  }));
  return { routes, activity };
}
export type ProjectRouteView = Awaited<ReturnType<typeof readProjectRoutes>>["routes"][number];
