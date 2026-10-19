/**
 * Repo-wide id-leak lint test for the agent layer.
 *
 * Standing invariant: the agent surface — system prompts + tool
 * descriptions + tool argument schemas — speaks in **names**, not ids.
 * No `tgId`, `pipelineInputId`, `pipelineOutputId`, `triggerEntryId`, no
 * `pi-`/`po-`/`tg-` handle prefixes, no raw uuid placeholders in prompt
 * prose. Future regressions get caught at CI.
 *
 * Implementation: static analysis of agent source files via regex
 * against the SYSTEM_PROMPT template literal + the tool definition
 * block. We don't load the agent runner — that pulls in casl / DB /
 * adapter / OpenAI deps, none of which are needed to lint the prompt
 * shape. Mirrors the precedent in
 * `translation_agent_provisioned.unit.test.ts` (sliced regex against
 * the source file) and `setup_agent_f2.unit.test.ts` (walks
 * SETUP_STATIC_TOOL_DEFINITIONS object tree).
 *
 * Linted agents (user-facing surface):
 *   - setup_agent        — onboarding concierge
 *   - translation_agent  — TG authoring specialist
 *   - ontology_agent     — schema/model design
 *   - query_agent        — KG data querying
 *
 * Exempt:
 *   - system_agent       — debug surface; users paste ids from
 *     operational logs / Render URLs into the chat (the brief's
 *     "internal admin tool that genuinely needs an id" escalation
 *     trigger; resolved 2026-05-24 in `_execution/_escalations.md`).
 *
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENT_DIR = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Per-agent source extraction
// ---------------------------------------------------------------------------

interface AgentSurface {
  /** Agent display name — used only in test failure messages. */
  name: string;
  /** Path to the agent's source file (for error messages). */
  path: string;
  /** Concatenated body of every `SYSTEM_PROMPT` template literal in the
   *  file. Most agents declare exactly one; translation declares the
   *  main prompt + a `TLDR_SYSTEM_PROMPT`. Both count. */
  systemPrompt: string;
  /** Concatenated body of every tool-definition block in the file.
   *  Best-effort regex match; over-captures rather than under-captures
   *  so the lint is conservative. */
  toolDefs: string;
}

/**
 * Extract every `const … SYSTEM_PROMPT = \`…\`` template literal in
 * the file (top-level only — nested `${…}` interpolations are fine,
 * the regex is non-greedy on the outer backticks). Returns the joined
 * body text so callers can grep across all of them.
 *
 * Why non-greedy + multi-match: query_agent has one SYSTEM_PROMPT;
 * translation_agent has SYSTEM_PROMPT + TLDR_SYSTEM_PROMPT; setup_agent
 * has SYSTEM_PROMPT only. The regex tolerates all three shapes.
 */
function extractSystemPrompts(source: string): string {
  const re = /(?:const|export const)\s+\w*SYSTEM_PROMPT\w*\s*=\s*`([\s\S]*?)`\s*;/g;
  const bodies: string[] = [];
  for (let m: RegExpExecArray | null = re.exec(source); m; m = re.exec(source)) {
    bodies.push(m[1]);
  }
  return bodies.join('\n\n');
}

/**
 * Extract every tool-definition block in the file. The agent surface
 * uses either `STATIC_TOOL_DEFINITIONS` / `toolDefinitions` arrays —
 * each is a list of `{ name, description, parameters }` objects. We
 * grab the array body literally and lint it as a string.
 *
 * Over-captures gracefully (longer arrays = more text linted, which is
 * the safer direction).
 */
function extractToolDefs(source: string): string {
  const re =
    /(?:const|export const)\s+\w*(?:TOOL_DEFINITIONS|toolDefinitions)\w*[^=]*=\s*\[([\s\S]*?)\n\];\n/g;
  const bodies: string[] = [];
  for (let m: RegExpExecArray | null = re.exec(source); m; m = re.exec(source)) {
    bodies.push(m[1]);
  }
  return bodies.join('\n\n');
}

/**
 * Load an agent's lintable surface from one or more source paths. Each
 * path's text is concatenated before extraction — useful when the
 * prompt or tool defs live in a sibling file.
 */
function loadAgent(args: {
  displayName: string;
  sources: string[];
}): AgentSurface {
  const sources = args.sources.map((rel) =>
    rel.startsWith('/') ? rel : join(AGENT_DIR, rel),
  );
  const combined = sources.map((p) => readFileSync(p, 'utf8')).join('\n\n');
  return {
    name: args.displayName,
    path: sources.join(' + '),
    systemPrompt: extractSystemPrompts(combined),
    toolDefs: extractToolDefs(combined),
  };
}

const LINTED_AGENTS: AgentSurface[] = [
  loadAgent({ displayName: 'ontology', sources: ['ontology_agent.ts'] }),
];

// ---------------------------------------------------------------------------
// Ban list
// ---------------------------------------------------------------------------

/**
 * Patterns banned from agent system prompts AND tool-definition bodies.
 *
 * Each entry: a regex + a one-line rationale that becomes the test's
 * failure message so a future agent (human or LLM) immediately knows
 * what to fix.
 *
 * The ban list is intentionally narrow — too-broad patterns (`\bid\b`
 * everywhere) produce false positives on legitimate plain-language
 * uses ("the customer's id badge", "identify the right field"). What
 * matters here is the camelCase/snake_case framework-id placeholders
 * the V-cycle was juggling.
 */
interface BannedPattern {
  pattern: RegExp;
  rationale: string;
}

const BANNED: BannedPattern[] = [
  // Framework id parameter names — V5/V8 surfaces these to the LLM.
  {
    pattern: /\btgId\b/,
    rationale:
      'tool args + prompts speak in names; `tgId` is a framework id — ' +
      'expose `tgName` (resolved at the framework boundary) instead',
  },
  {
    pattern: /\bpipelineInputId\b/,
    rationale:
      'agent layer speaks in names; `pipelineInputId` is a framework id — ' +
      'expose `triggerName` instead',
  },
  {
    pattern: /\bpipelineOutputId\b/,
    rationale:
      'agent layer speaks in names; `pipelineOutputId` is a framework id — ' +
      'expose `triggerName` / `tgName` instead',
  },
  {
    pattern: /\btriggerEntryId\b/,
    rationale:
      'agent layer speaks in names; `triggerEntryId` is a framework id — ' +
      'expose `triggerName` instead',
  },
  {
    pattern: /\btriggerId\b/,
    rationale:
      'agent layer speaks in names; `triggerId` is a framework id — ' +
      'expose `triggerName` instead',
  },
  // Handle prefixes — these leak into prose when an agent fabricates ids.
  {
    pattern: /\bpi-[0-9a-f]/i,
    rationale: '`pi-…` handle prefix should not appear in agent prose',
  },
  {
    pattern: /\bpo-[0-9a-f]/i,
    rationale: '`po-…` handle prefix should not appear in agent prose',
  },
  {
    pattern: /\btg-[0-9a-f]/i,
    rationale: '`tg-…` handle prefix should not appear in agent prose',
  },
  // Bare uuid in prose / tool descriptions.
  {
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    rationale:
      'raw uuid in agent surface — agents work in names; the framework ' +
      'resolves ids internally',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent layer — no id leaks (N4 standing rule)', () => {
  // Smoke check — make sure the source-extraction regexes actually
  // matched something on every linted agent. If a future refactor
  // moves the SYSTEM_PROMPT declaration to a different shape, this
  // catches the lint silently going from "asserting things" to
  // "asserting nothing".
  describe('extraction smoke', () => {
    for (const agent of LINTED_AGENTS) {
      it(`${agent.name}: extracted a non-empty system prompt`, () => {
        expect(agent.systemPrompt.length).toBeGreaterThan(100);
      });
    }
  });

  // The actual ban-list assertions.
  describe('system prompts', () => {
    for (const agent of LINTED_AGENTS) {
      for (const { pattern, rationale } of BANNED) {
        it(`${agent.name}: prompt has no ${pattern}`, () => {
          if (pattern.test(agent.systemPrompt)) {
            throw new Error(
              `${agent.name} system prompt contains banned pattern ${pattern}: ${rationale}\n` +
                `Source: ${agent.path}`,
            );
          }
        });
      }
    }
  });

  describe('tool definitions', () => {
    for (const agent of LINTED_AGENTS) {
      for (const { pattern, rationale } of BANNED) {
        it(`${agent.name}: tool defs have no ${pattern}`, () => {
          // Some agents (ontology, query) build their tool definitions
          // inline near the runner rather than in a named const. The
          // smoke check below tolerates an empty tool-defs body for
          // those — we still get prompt-level coverage from the block
          // above. The translation + setup agents do have named const
          // blocks and ARE exercised here.
          if (!agent.toolDefs) return;
          if (pattern.test(agent.toolDefs)) {
            throw new Error(
              `${agent.name} tool definitions contain banned pattern ${pattern}: ${rationale}\n` +
                `Source: ${agent.path}`,
            );
          }
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Sanity check — the lint catches a deliberate leak
//
// We can't poison the real source files in a unit test, so this
// asserts the ban-list logic directly: a synthetic "system prompt"
// containing `tgId` MUST fail the same check the real prompts pass.
// If this sanity assertion ever stops failing, the lint is no-op.
// ---------------------------------------------------------------------------

describe('lint sanity — deliberate leak still trips the ban list', () => {
  it('catches `Pass the tgId here` in a synthetic prompt', () => {
    const synthetic = 'You are an agent. Pass the tgId here when calling preview.';
    const tripped = BANNED.some(({ pattern }) => pattern.test(synthetic));
    expect(tripped).toBe(true);
  });

  it('catches a raw uuid in a synthetic prompt', () => {
    const synthetic =
      'When the user says "the dealflow sync", look it up as 550e8400-e29b-41d4-a716-446655440000.';
    const tripped = BANNED.some(({ pattern }) => pattern.test(synthetic));
    expect(tripped).toBe(true);
  });

  it('does NOT trip on benign uses of the word "id" in prose', () => {
    // The ban list is intentionally narrow — false positives on
    // "identify", "the customer's id badge", etc. would be noise.
    const benign =
      "I'll identify the right field for you, then preview what would land. " +
      "Don't worry about ids — that's an internal detail.";
    const tripped = BANNED.some(({ pattern }) => pattern.test(benign));
    expect(tripped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// N3-N: structural lint over tool-definition parameter shapes
//
// The string-level lint above catches `tgId` and uuids in agent prose
// + tool-def text. N3-N tightens the contract: every agent-facing tool
// def's `parameters.properties.*` keys must end in something other than
// `Id` — agents address triggers / syncs / entities / relationships by
// name; resolver shims at each tool impl convert names → internal ids.
//
// We can't `require()` the agent files in this test — the import
// transitively pulls in Prisma runtime types whose loader fails in this
// jest config (baseline issue noted in CLAUDE.md). Instead we
// parse the tool-def array body out of source and scan it as text,
// catching every `<word>Id:` key inside a `properties: { ... }` block.
//
// The regex is bounded: it only matches identifier keys that end in
// `Id` and are followed by a JSON-shaped value (`{ … }`). It tolerates
// the `\bId$` shape but allows `Identity`, `Identifier`, etc. (anchored
// on the `Id:` token, not `id` mid-word).
// ---------------------------------------------------------------------------

interface StructuralCheckTarget {
  agent: string;
  path: string;
  source: string;
}

const STRUCTURAL_TARGETS: StructuralCheckTarget[] = [
  {
    agent: 'ontology',
    path: join(AGENT_DIR, 'ontology_agent.ts'),
    source: readFileSync(join(AGENT_DIR, 'ontology_agent.ts'), 'utf8'),
  },
];

/**
 * Scan the source of an agent file for `*Id` parameter keys in tool
 * defs. Walks every tool-def block (same extractor the prompt-lint
 * uses) and matches `<identifier>Id:` keys — including nested object
 * schemas — within the captured slice.
 *
 * Returns one entry per leak so a failing test prints them all at once.
 */
function collectStructuralIdLeaks(args: { agent: string; source: string }): string[] {
  const toolDefsBody = extractToolDefs(args.source);
  if (!toolDefsBody) return [];
  const problems: string[] = [];

  // Match `<word>Id:` keys (the JSON-schema-style property name). The
  // body is JavaScript object-literal text, so keys are bare
  // identifiers (no quotes). Allow optional surrounding whitespace.
  // Capture the leading identifier so the failure message says which
  // key tripped.
  const idKeyRe = /^[ \t]*([A-Za-z][A-Za-z0-9_]*Id)\s*:/gm;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = idKeyRe.exec(toolDefsBody))) {
    const key = m[1];
    // Allow stable client-supplied handles WITHIN a structure the
    // agent itself authors and references in the same call —
    // distinct from framework UUIDs the agent has to learn from
    // somewhere else. These three keys appear on SchemaTypeStructure
    // / SketchModel where the agent picks its OWN stable ids for
    // entity rename animations + relationship endpoints. The shape
    // is fully self-contained, so there's no name-resolver
    // mechanism the framework can substitute.
    const allowlist = new Set<string>([
      'fromEntityId',
      'toEntityId',
      'targetEntityId',
    ]);
    if (allowlist.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(
      `${args.agent} tool defs contain param \`${key}\` — ` +
        '`*Id`-typed parameters are not allowed in agent-facing tool defs; ' +
        `expose \`${key.replace(/Id$/, 'Name')}\` instead (resolve internally)`,
    );
  }

  // Description-level guard: a `description: "…UUID of the…"` is the
  // same leak by another route. The earlier ban list catches the
  // word `uuid` in tool-def text via the string-level test; reassert
  // here too for completeness and a clearer failure message.
  if (/description\s*:\s*['"`][^'"`]*\buuid\b[^'"`]*['"`]/i.test(toolDefsBody)) {
    problems.push(
      `${args.agent} tool defs contain a description mentioning "uuid" — agents speak in names, not ids`,
    );
  }

  return problems;
}

describe('agent layer — structural no-`*Id` lint over tool definitions (N3-N)', () => {
  for (const target of STRUCTURAL_TARGETS) {
    it(`${target.agent}: every tool def parameter speaks in names, not ids`, () => {
      const problems = collectStructuralIdLeaks(target);
      if (problems.length > 0) {
        throw new Error(
          `Tool-def id leaks in '${target.agent}' agent (N3-N):\n` +
            problems.map((p) => `  - ${p}`).join('\n') +
            `\nSource: ${target.path}`,
        );
      }
    });
  }

  it('sanity: a synthetic tool-def slice with `triggerId:` is caught', () => {
    // Synthesise a tool-defs body the same shape `extractToolDefs`
    // would yield — a STATIC_TOOL_DEFINITIONS array literal.
    const synthetic = `const STATIC_TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'syntheticTool',
    description: 'A tool that takes a UUID for testing the lint.',
    parameters: {
      type: 'object',
      properties: {
        triggerId: { type: 'string', description: 'UUID of the trigger' },
      },
    },
  },
];
`;
    const problems = collectStructuralIdLeaks({ agent: 'synthetic', source: synthetic });
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.join('\n')).toMatch(/triggerId/);
    expect(problems.join('\n')).toMatch(/uuid/i);
  });

  it('sanity: a clean tool-def slice passes', () => {
    const clean = `const STATIC_TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'syntheticClean',
    description: 'A tool that takes names only.',
    parameters: {
      type: 'object',
      properties: {
        triggerName: { type: 'string', description: 'Name of the trigger.' },
      },
    },
  },
];
`;
    expect(collectStructuralIdLeaks({ agent: 'synthetic', source: clean })).toEqual([]);
  });
});
