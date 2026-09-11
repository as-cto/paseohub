import { z } from "zod";

/** Explicit workflow-state IDs; no automatic guesses from translated state names. */
export const LinearFinalizationPolicySchema = z
  .object({
    team_id: z.string().min(1),
    review_state_id: z.string().min(1),
    completed_state_id: z.string().min(1),
    waiting_state_id: z.string().min(1).optional(),
    allowed_assignee_ids: z.array(z.string().min(1)).min(1).max(100).optional(),
  })
  .strict();
