import type { LinearApiClient } from "../../providers/linear/client.js";
import { reportFailure } from "../../failures/index.js";

/** Session link enrichment is best effort; the complete URL remains in both final bodies. */
export async function attachLinearReplyLinks(
  client: LinearApiClient,
  context: { linearOrganizationId: string; agentSessionId: string | null },
  content: string,
  expectedConnectionId?: string,
): Promise<void> {
  if (context.agentSessionId === null) return;
  const links = pullRequestLinks(content);
  if (links.length === 0) return;
  try {
    await client.updateAgentSessionExternalUrls({
      linearOrganizationId: context.linearOrganizationId,
      agentSessionId: context.agentSessionId,
      externalUrls: links,
      ...(expectedConnectionId === undefined ? {} : { expectedConnectionId }),
    });
  } catch (error: unknown) {
    reportFailure(
      error,
      { operation: "linear.session.external-urls", component: "triggers", provider: "linear" },
      { diagnostic: { agentSessionId: context.agentSessionId } },
    );
  }
}

/**
 * GitHub pull requests named in a reply, in order and without duplicates.
 *
 * Deliberately narrow: only `/pull/<number>` URLs, because `externalUrls` is what Linear reads to
 * show "this session opened this PR". Any other link the agent mentions belongs in the text.
 */
function pullRequestLinks(content: string): Array<{ label: string; url: string }> {
  const matches = content.matchAll(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gu);
  const seen = new Set<string>();
  const links: Array<{ label: string; url: string }> = [];
  for (const match of matches) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ label: `${match[1]}/${match[2]}#${match[3]}`, url });
  }
  return links;
}
