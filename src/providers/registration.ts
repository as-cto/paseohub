import type { ProjectConfigurationStore } from "../configuration/store.js";
import type { ConnectionResolutionContext, ConnectionResolver } from "../config/connections.js";
import type { OrganizationConnectionUsage } from "../db/types.js";
import type { OutputExecutor, OutputToolDefinition } from "../execution-capabilities/outputs.js";
import type { TriggerProvider, TriggerSource } from "../triggers/index.js";
import type { GitHubConfigurationProvider } from "../configuration/github-sync.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentProvider,
  AttachmentResolver,
} from "../attachments/capabilities.js";
import type { SlackDeliveryStatus } from "../triggers/slack/source/index.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";

export interface TriggerProviderResources {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  connectionsForProject: (projectId: string) => ConnectionResolver;
  attachments?: AttachmentCapabilityRegistry;
  executions?: TriggerProviderExecutionControl;
}

/** Lets a provider end running work on behalf of its platform, e.g. a user pressing Stop. */
export interface TriggerProviderExecutionControl {
  /**
   * Fails the project's work selected by `matches` with `reason`: pending executions and
   * accepted runs whose execution was not dispatched yet. `matches` sees each candidate's
   * output context and the id of the workflow run it belongs to (null for an execution outside
   * a workflow run). The failure follows the usual terminal path: the daemon agent is
   * interrupted and the provider's failure hook receives `reason`. `stopped` counts both kinds.
   */
  stopActive(input: {
    projectId: string;
    reason: string;
    matches: (work: { outputContext: unknown; triggerRunId: string | null }) => boolean;
  }): Promise<{ stopped: number }>;
  /**
   * Delivers a message to the agent of a live execution selected by `matches`.
   *
   * The conversational counterpart of `stopActive`: a platform where the user keeps writing into
   * the same panel (a Linear agent session) can continue the agent it already started instead of
   * starting another one and replaying the thread as text. `delivered: false` means no live agent
   * matched — the ordinary case once a turn has ended — and the caller starts a run as before.
   */
  promptActive(input: {
    projectId: string;
    prompt: string;
    inputId?: string;
    turnContext?: { triggerContext: unknown; outputContext: unknown };
    activeTurnBehavior?: "interrupt" | "steer";
    matches: (work: {
      outputContext: unknown;
      triggerRunId: string | null;
      launchIntent?: LaunchMachineIntent | null;
    }) => boolean;
  }): Promise<{
    delivered: boolean;
    /**
     * Whether a live execution matched at all, delivered or not.
     *
     * The two failures need opposite handling: nothing live means the previous turn simply ended
     * (start a run, as always), while something live that refused the message means an agent is
     * running out of reach — leaving it there would put two agents on one conversation.
     */
    live: boolean;
  }>;
}

export type TriggerProviderFactory = (
  resources: TriggerProviderResources,
) => TriggerProvider | undefined;

export interface ProviderIntegrationRegistration {
  resolve(
    projectId: string,
    connectionSlug: string,
    value: string,
    context?: ConnectionResolutionContext,
  ): Promise<string>;
  githubAuthority?: GitHubAuthorityRegistration;
}

export interface GitHubAuthorityRegistration {
  mint(input: {
    projectId: string;
    connectionSlug: string;
    repositories: readonly string[];
    permissions: Readonly<Record<string, "read" | "write" | "admin">>;
  }): Promise<{
    token: string;
    expiresAt: number;
    botUserId: number;
    botLogin: string;
  }>;
  revoke(token: string): Promise<void>;
}

export interface ProviderConnectionRegistration {
  name: string;
  status(connections: OrganizationConnectionUsage): unknown;
  actions: Readonly<Record<string, (request: Request) => Promise<Response>>>;
}

export interface ProviderOutputRegistration {
  type: string;
  tool: OutputToolDefinition;
  available?: (outputContext: unknown) => boolean;
  execute: OutputExecutor;
}

export interface ProviderRequestRegistration {
  name: string;
  handle(request: Request): Promise<Response>;
}

export interface ProviderAttachmentRegistration {
  provider: AttachmentProvider;
  resolve: AttachmentResolver;
}

export interface ProviderRegistration {
  configurationSnapshot?: { version: number; callbackOrigin: string };
  connection: ProviderConnectionRegistration;
  integration?: ProviderIntegrationRegistration;
  triggerProviders: readonly TriggerProviderFactory[];
  sources: readonly TriggerSource[];
  outputs: readonly ProviderOutputRegistration[];
  requests: readonly ProviderRequestRegistration[];
  attachment?: ProviderAttachmentRegistration;
  githubConfiguration?: GitHubConfigurationProvider;
  slackDelivery?: { status(): SlackDeliveryStatus; retry(): Promise<void> };
}
