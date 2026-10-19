/**
 * Dev-loop knowledge agent chat CLI.
 *
 *   pnpm dev:chat "<message>" [--scopes a,b] [--conversation <id>] [--pretty]
 *   pnpm dev:chat <agent> "<message>" [...]
 *
 * The unified agent is the default (and what every retired knowledge
 * domain routes to via the orchestrator). Legacy agent names are still
 * accepted; `translation` keeps its own dispatch.
 *
 * --scopes takes a comma-separated list of agent scopes (see
 * lib/knowledge/unified_agent.ts) and defaults to all of them — use it
 * to simulate a narrow surface, e.g. --scopes library.read,knowledge.read
 *
 * Bypasses tRPC and the AgentUpdate subscription — calls the agent runner
 * directly. Conversations are persisted in agent_conversation / agent_message
 * the same way the tRPC handler persists them, so a future turn can resume
 * by passing --conversation.
 *
 * Last conversation per agent is cached at .dev-loop/last-<agent>.json.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ensureDevLoopTeam, buildAgentContext } from './_lib';
import { initAgentRegistry, type AgentDomain } from '../../lib/knowledge/agent_registry';
import { ALL_AGENT_SCOPES, type AgentScope } from '../../lib/knowledge/unified_agent';
import { runConversationTurn } from '../../lib/knowledge/orchestrator';
import { prismaClient } from '../../prisma';
import { LlmUsageContext } from '../../lib/llm_usage';

const CACHE_DIR = join(process.cwd(), '.dev-loop');
const VALID_DOMAINS: AgentDomain[] = [
  'unified',
  'query',
  'ontology',
  'output',
  'movement',
  'system',
];
const AGENT_TYPE_BY_DOMAIN: Record<AgentDomain, string> = {
  unified: 'knowledge_unified',
  query: 'knowledge_query',
  ontology: 'knowledge_ontology',
  output: 'knowledge_output',
  movement: 'knowledge_movement',
  system: 'knowledge_system',
};

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      'Usage: pnpm dev:chat "<message>" [--scopes a,b] [--conversation <id>] [--pretty]\n' +
        '       pnpm dev:chat <unified|translation|…legacy names> "<message>" [...]',
    );
    process.exit(2);
  }

  // First arg is an agent name when it matches a known domain; otherwise
  // the whole invocation targets the unified agent and args[0] is the
  // message.
  let domain: AgentDomain = 'unified';
  let messageIndex = 0;
  if (VALID_DOMAINS.includes(args[0] as AgentDomain)) {
    domain = args[0] as AgentDomain;
    messageIndex = 1;
  }

  let message = args[messageIndex];
  if (message === undefined || message.startsWith('--')) {
    console.error('No message provided.');
    process.exit(2);
  }
  if (message === '--last') {
    // Re-use last message — useful for retries
    message = '<re-use last message not implemented>';
  }

  let conversationId: string | undefined;
  let pretty = false;
  let resume = false;
  let scopes: AgentScope[] | undefined;
  for (let i = messageIndex + 1; i < args.length; i++) {
    if (args[i] === '--conversation' || args[i] === '-c') {
      conversationId = args[++i];
    } else if (args[i] === '--resume') {
      resume = true;
    } else if (args[i] === '--pretty') {
      pretty = true;
    } else if (args[i] === '--scopes') {
      const raw = (args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const invalid = raw.filter((s) => !ALL_AGENT_SCOPES.includes(s as AgentScope));
      if (invalid.length > 0) {
        console.error(
          `Unknown scope(s): ${invalid.join(', ')}. Valid: ${ALL_AGENT_SCOPES.join(', ')}`,
        );
        process.exit(2);
      }
      scopes = raw as AgentScope[];
    }
  }

  return { domain, message, conversationId, pretty, resume, scopes };
}

function lastConversationFile(domain: AgentDomain) {
  return join(CACHE_DIR, `last-${domain}.json`);
}

function readLastConversation(domain: AgentDomain): string | undefined {
  const f = lastConversationFile(domain);
  if (!existsSync(f)) return undefined;
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as { conversationId?: string };
    return data.conversationId;
  } catch {
    return undefined;
  }
}

function writeLastConversation(domain: AgentDomain, conversationId: string) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(lastConversationFile(domain), JSON.stringify({ conversationId }, null, 2));
}

async function main() {
  const { domain, message, conversationId: passedConvId, pretty, resume, scopes } = parseArgs();

  await initAgentRegistry();

  const seed = await ensureDevLoopTeam();
  const ctx = buildAgentContext(seed.teamId, seed.userId);

  const agentType = AGENT_TYPE_BY_DOMAIN[domain];
  let conversationId = passedConvId;
  if (!conversationId && resume) {
    conversationId = readLastConversation(domain);
  }

  if (conversationId) {
    const conv = await prismaClient.agentConversation.findFirst({
      where: { id: conversationId, teamId: seed.teamId, agentType },
      select: { id: true },
    });
    if (!conv) {
      console.error(`Conversation ${conversationId} not found for agent=${domain}`);
      process.exit(1);
    }
  } else {
    const conv = await prismaClient.agentConversation.create({
      data: {
        teamId: seed.teamId,
        userId: seed.userId,
        agentType,
        title: message.slice(0, 100),
        // Route runConversationTurn to the right agent. Without this it
        // would fall back to whatever the schema default is.
        activeAgent: domain,
      },
    });
    conversationId = conv.id;
  }

  await prismaClient.agentMessage.create({
    data: { conversationId, role: 'user', content: message },
  });

  const sessionId = randomUUID();
  const usageContext = new LlmUsageContext({ teamId: seed.teamId, conversationId });

  // Route through the orchestrator so dev:chat exercises the same
  // path as the tRPC chat handler — M2 thoughts persistence, M3 Haiku
  // compaction, M4 sliding-window enrichment, handoff/hand-back, and
  // tombstone-update all kick in. The orchestrator writes the
  // assistant message itself, so don't duplicate it below.
  // No enterTransaction: production fires runConversationTurn from a
  // tRPC handler's `backgroundWork` AFTER the tRPC transaction has
  // closed, so the orchestrator runs against the plain (non-txn)
  // prismaClient. LLM calls are slow enough that wrapping in a real
  // transaction would hit the txn timeout. The principal buildAgentContext
  // binds is what makes `prisma` resolve to the writable client.
  const result = await ctx.runAsync(async () =>
    usageContext.runAsync(() =>
      runConversationTurn({
        conversationId: conversationId!,
        sessionId,
        userMessage: message,
        domainOptions: {
          ...(domain === 'output' ? { adapterType: 'ATTIO' } : {}),
          ...(scopes ? { scopes } : {}),
        },
      }),
    ),
  );

  writeLastConversation(domain, conversationId);

  const out = {
    agent: domain,
    conversationId,
    sessionId,
    text: result.text,
    trace: result.trace,
    suggestedActions: result.suggestedActions,
    classifiedAs: result.classifiedAs,
    outputConfig: result.outputConfig,
  };

  if (pretty) {
    console.log(`# ${domain} agent — conversation ${conversationId}`);
    console.log();
    console.log(result.text);
    if (result.trace && result.trace.length > 0) {
      console.log('\n## Tool calls');
      for (const t of result.trace) {
        const toolName = (t as any).toolName ?? (t as any).tool ?? '?';
        const argsStr = JSON.stringify((t as any).input ?? (t as any).args ?? {}).slice(0, 200);
        console.log(`  - ${toolName}(${argsStr})`);
      }
    }
    if (result.outputConfig) {
      console.log('\n## Built config');
      console.log(JSON.stringify(result.outputConfig, null, 2));
    }
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
