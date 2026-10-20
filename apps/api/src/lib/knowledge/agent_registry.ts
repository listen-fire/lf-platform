import type { SuggestedAction, ToolTrace, ClassifiedType, AgentChannel, IngestableType } from './agent_types';
import type { Attachment } from '../file_generation';

// ---------------------------------------------------------------------------
// Agent domain types
// ---------------------------------------------------------------------------

/**
 * Agent domains.
 *
 * Routing notes:
 *  - `unified` is THE user-facing knowledge agent: one consultant with a
 *    scope-gated tool surface spanning the retired query / ontology /
 *    output / movement / system domains (see `unified_agent.ts`). The
 *    orchestrator normalises those retired domains onto `unified` at
 *    dispatch; their registrations below remain only for direct callers
 *    that haven't migrated (tRPC views, Slack, WhatsApp).
 *  - `output` is a tiny no-LLM dispatcher kept for conversations tagged
 *    with it; it immediately hands off to the unified agent.
 */
export type AgentDomain =
  | 'unified'
  | 'query'
  | 'ontology'
  | 'output'
  | 'movement'
  | 'system';

/**
 * Unified result shape returned by all agent domains.
 * Fields that only apply to certain domains are optional.
 */
export interface AgentResult {
  text: string;
  trace: ToolTrace[];
  suggestedActions: SuggestedAction[];
  attachments: Attachment[];
  classifiedAs?: ClassifiedType;
  context?: string;
  /** Output agent returns the built config */
  outputConfig?: unknown;
  /** Auto-generated recap of the turn's internal work. Persisted to
   *  `agent_message.metadata.tldr` and re-injected on resume. Agents may
   *  opt in by populating it. */
  tldr?: string;
}

/**
 * Onboarding-funnel context attached to a conversation that started at
 * `/setup`. Carries the leaf the user picked + a primer the Setup agent
 * can read on first turn. F1 wires it in; F2 makes it useful.
 */
export interface AgentInvocationFunnelContext {
  leafSlug: string;
  pain: string;
  painShape: string;
  domain: string;
  suggestedArc: 'integration-first' | 'model-first' | null;
  primer?: string;
  templateRef?: string;
}

/**
 * Context that every agent invocation receives.
 * Domain-specific options are passed via `domainOptions`.
 */
export interface AgentInvocation {
  message: string;
  sessionId?: string;
  teamId: string;
  conversationId?: string;
  conversationHistory: Array<{
    role: 'user' | 'assistant';
    content: string;
    /** Optional per-turn recap from a prior assistant turn. Re-injected
     *  by agents that support it so the LLM sees continuity past the
     *  verbatim text. */
    tldr?: string;
  }>;
  /** Domain-specific options (e.g., uploadedDocumentIds for query, adapterType for output) */
  domainOptions?: Record<string, unknown>;
  /**
   * Onboarding-funnel leaf the user picked at `/setup`, if any. Set on
   * conversation creation by the funnel UI and surfaced unchanged to
   * every turn of the conversation. The Setup agent reads it to prime
   * its first response; other agents ignore it. F1 plumbs it through;
   * F2 makes it useful.
   */
  funnelContext?: AgentInvocationFunnelContext | null;
  /** Extra tool definitions injected by the orchestrator (e.g., handoff tools) */
  additionalToolDefs?: any[];
  /** Extra tool implementations injected by the orchestrator */
  additionalToolImpls?: Record<string, (args: any) => Promise<any>>;
  /**
   * Per-conversation navigation state at turn-start. N1 surfaces this
   * to every agent invocation so tools that operate on pinned named
   * references can read what the agent (or its prior handoff partner)
   * was working on. Mutation goes through the NavigationState service
   * (`navigateTo` / `extendNavigation` / `resolveByName`); this field
   * is a turn-start snapshot, not a live handle.
   *
   */
  navigationState?: Record<string, unknown>;
  /**
   * M3: the latest running-state paragraph for this conversation, or
   * null when the conversation hasn't been compacted yet (turn 1) /
   * the agent isn't opted into compaction. The agent's runner
   * decides whether to inject it into its system prompt.
   *
   */
  runningState?: string | null;
}

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  domain: AgentDomain;
  /** Domains this agent can hand off to */
  canHandoffTo: AgentDomain[];
  /**
   * M3: opt this agent into Haiku running-state compaction. When true,
   * the orchestrator calls `compactIfDue(conversationId)` on turn
   * entry, persists the resulting paragraph onto
   * `agent_conversation.metadata.runningState`, and threads it into the
   * agent invocation as `runningState`. The agent's runner is
   * responsible for injecting the paragraph into its own system prompt
   * (see Setup's `buildSystemPromptWithFunnel`).
   *
   * Default: false. Setup flips this on in M3; other agents stay off
   * until we see one of them exhibit the same memory symptom.
   *
   */
  enableRunningState?: boolean;
  /** Run the agent. Wraps the existing agent runner. */
  run: (invocation: AgentInvocation) => Promise<AgentResult>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<AgentDomain, AgentConfig>();

export function registerAgent(config: AgentConfig): void {
  registry.set(config.domain, config);
}

export function getAgent(domain: AgentDomain): AgentConfig {
  const config = registry.get(domain);
  if (!config) throw new Error(`Unknown agent domain: ${domain}`);
  return config;
}

export function getAllAgents(): AgentConfig[] {
  return Array.from(registry.values());
}

// ---------------------------------------------------------------------------
// Registration — lazily imported to avoid circular dependencies
// ---------------------------------------------------------------------------

export async function initAgentRegistry(): Promise<void> {
  // Only register if not already done (idempotent)
  if (registry.size > 0) return;

  // The unified agent — the one user-facing consultant. Carries the whole
  // scope-gated tool surface, so it gets NO handoff targets: a handoff
  // would let a scope-restricted invocation escalate to an agent that
  // doesn't respect scopes (observed in the 2026-06-11 eval — a channel
  // without movements.author handed off to Setup, which happily authored).
  // Scopes are the safety boundary; the agent declines and names the
  // missing scope instead.
  registerAgent({
    domain: 'unified',
    canHandoffTo: [],
    run: async (invocation) => {
      const { runUnifiedAgent, parseAgentScopes, parsePageContext } = await import('./unified_agent');
      const opts = invocation.domainOptions ?? {};
      const result = await runUnifiedAgent(invocation.message, {
        sessionId: invocation.sessionId,
        teamId: invocation.teamId,
        conversationId: invocation.conversationId,
        conversationHistory: invocation.conversationHistory,
        scopes: parseAgentScopes(opts.scopes),
        pageContext: parsePageContext(opts.pageContext),
        showMode: opts.showMode === true,
        funnelContext: invocation.funnelContext
          ? {
              pain: invocation.funnelContext.pain,
              painShape: invocation.funnelContext.painShape,
              domain: invocation.funnelContext.domain,
              suggestedArc: invocation.funnelContext.suggestedArc,
              ...(invocation.funnelContext.primer
                ? { primer: invocation.funnelContext.primer }
                : {}),
            }
          : null,
        additionalToolDefs: invocation.additionalToolDefs,
        additionalToolImpls: invocation.additionalToolImpls,
      });
      return {
        text: result.text,
        trace: result.trace,
        suggestedActions: result.suggestedActions ?? [],
        attachments: [],
      };
    },
  });

  // ── Deprecated domain registrations ────────────────────────────────
  // The orchestrator routes all of the domains below to `unified`. They
  // stay registered because their runners are still called directly by
  // tRPC views, Slack, and WhatsApp.

  registerAgent({
    domain: 'ontology',
    canHandoffTo: ['query', 'output', 'system'],
    run: async (invocation) => {
      const { runOntologyAgent } = await import('./ontology_agent');
      const result = await runOntologyAgent(invocation.message, {
        sessionId: invocation.sessionId,
        teamId: invocation.teamId,
        conversationHistory: invocation.conversationHistory,
        additionalToolDefs: invocation.additionalToolDefs,
        additionalToolImpls: invocation.additionalToolImpls,
      });
      return {
        text: result.text,
        trace: [],
        suggestedActions: [],
        attachments: [],
      };
    },
  });

  // Output dispatcher — no LLM, pure routing. The legacy pipelines it once
  // served are gone; data movement is authored by the unified agent.
  registerAgent({
    domain: 'output',
    canHandoffTo: ['unified'],
    run: async () => {
      const { HandoffSignal } = await import('./handoff');
      throw new HandoffSignal(
        'unified',
        'User wants to move data between systems. The unified agent authors the data movement.',
      );
    },
  });

  // Movement author — authors data-movement (.mvt) programs from
  // plain-language briefs through the propose → typecheck → repair loop
  // (plans/2026-06-10-data-movement-language/1_principles.md §9).
  registerAgent({
    domain: 'movement',
    canHandoffTo: ['query', 'ontology', 'system'],
    run: async (invocation) => {
      const { runMovementAgent } = await import('./movement_agent');
      const result = await runMovementAgent(invocation.message, {
        sessionId: invocation.sessionId,
        teamId: invocation.teamId,
        conversationHistory: invocation.conversationHistory,
        additionalToolDefs: invocation.additionalToolDefs,
        additionalToolImpls: invocation.additionalToolImpls,
      });
      return {
        text: result.text,
        trace: [],
        suggestedActions: [],
        attachments: [],
      };
    },
  });

  registerAgent({
    domain: 'system',
    canHandoffTo: ['query', 'ontology', 'output'],
    run: async (invocation) => {
      const { runSystemAgent } = await import('./system_agent');
      const result = await runSystemAgent(invocation.message, {
        sessionId: invocation.sessionId,
        teamId: invocation.teamId,
        conversationHistory: invocation.conversationHistory,
        additionalToolDefs: invocation.additionalToolDefs,
        additionalToolImpls: invocation.additionalToolImpls,
      });
      return {
        text: result.text,
        trace: [],
        suggestedActions: [],
        attachments: [],
      };
    },
  });
}
