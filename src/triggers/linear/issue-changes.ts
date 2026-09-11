/** Fields which change the work requested on an issue. Delivery timestamps and sort order do not. */
export const LINEAR_WORK_FIELDS = [
  "title",
  "description",
  "stateId",
  "assigneeId",
  "delegateId",
  "labelIds",
  "priority",
  "dueDate",
  "estimate",
  "cycleId",
  "projectId",
  "teamId",
  "parentId",
] as const;

export type LinearWorkField = (typeof LINEAR_WORK_FIELDS)[number];
export interface LinearIssueChange {
  field: LinearWorkField;
  before: string | number | string[] | null;
  after: string | number | string[] | null;
}

/** Read only explicit before/after evidence: a missing property is not a removal. */
export function linearIssueChanges(
  data: Record<string, unknown>,
  previous: unknown,
): LinearIssueChange[] {
  if (!record(previous)) return [];
  return LINEAR_WORK_FIELDS.flatMap((field) => {
    if (!Object.hasOwn(previous, field) || !Object.hasOwn(data, field)) return [];
    const before = fieldValue(field, previous[field]);
    const after = fieldValue(field, data[field]);
    if (
      before === undefined ||
      after === undefined ||
      JSON.stringify(before) === JSON.stringify(after)
    )
      return [];
    return [{ field, before, after }];
  });
}

function fieldValue(
  field: LinearWorkField,
  value: unknown,
): LinearIssueChange["after"] | undefined {
  if (value === null) return null;
  if (field === "labelIds") {
    return Array.isArray(value) && value.every((id): id is string => typeof id === "string")
      ? [...new Set(value)].sort()
      : undefined;
  }
  if (["priority", "estimate"].includes(field))
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
