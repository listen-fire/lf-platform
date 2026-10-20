// @lf/judge-llm served as the judge slot's module (docs/contracts/judge-slot.md)
// for a host that starts it, such as lf: the identity judge's rules and
// prompts, with its one model call made through the host's models door
// (LF_HOST_URL), so it runs on whatever fills the host's models slot — Claude,
// or Gemini through @lf/models — and needs no key of its own. What the door
// says each call cost is the answer's `cost`, charged to the run that asked.

import { z } from 'zod';

import { JUDGE_METHODS, JudgeArbitrateRequest, type JudgeArbitrateAnswerShape, type WireSlotManifestShape } from 'engine-contracts/slots';
import { WireExternalRecordRef, type WireCostLineShape } from 'engine-contracts';
import { hostModels, type HostModelsDoor } from 'module-kit/host_models';
import { SlotRefusal, type SlotAnswer } from 'module-runtime/module-wire';

import { createIdentityJudge } from './judge';

export const JUDGE_LLM_MANIFEST: WireSlotManifestShape = { protocolVersion: 2, name: 'judge_llm', kind: 'core', slot: 'judge', methods: [...JUDGE_METHODS] };

/** A candidate as a search answers it; the judge reads only its `data`, so
 *  one that names no system is still a candidate. */
const Candidate = WireExternalRecordRef.extend({ adapterType: z.string().default('') });

/** The host's models door, as a host that starts the module names it
 *  (LF_HOST_URL, LF_HOST_TOKEN); `undefined` when it names none. */
export function hostDoorFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): HostModelsDoor | undefined {
  const url = env.LF_HOST_URL;
  if (url === undefined || url === '') return undefined;
  const token = env.LF_HOST_TOKEN;
  return {
    url: `${url.replace(/\/$/, '')}/api/public/adapter/judge_llm/models`,
    headers: token !== undefined && token !== '' ? { authorization: `Bearer ${token}` } : {},
  };
}

export function judgeLlmAnswer(door: HostModelsDoor | undefined): SlotAnswer {
  return async (method, params) => {
    if (method !== 'judge.arbitrate') throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
    const request = JudgeArbitrateRequest.safeParse(params);
    const candidates = Candidate.array().safeParse(params.candidates);
    if (!request.success || !candidates.success) {
      const issues = [...(request.error?.issues ?? []), ...(candidates.error?.issues ?? [])];
      throw new SlotRefusal('bad_request', `judge.arbitrate: ${issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')}`);
    }
    const cost: WireCostLineShape[] = [];
    let judgeUnavailable: string | undefined;
    const judge = createIdentityJudge({
      askModel: async ({ label, model, system, user, validator }) => {
        if (door === undefined) throw new Error('the host names no models door (LF_HOST_URL), so the judge has no model to ask');
        const models = hostModels(door)({ charge: (line) => void cost.push(line) });
        return models.chatStructured({ label, model, system, userMessage: user, schema: validator, toolName: 'verdict', toolDescription: 'Which candidate, if any, is the same entity, and how sure.' });
      },
    });
    const index = await judge.arbitrateEntityCandidates({
      ...request.data,
      candidates: candidates.data,
      onJudgeUnavailable: (message) => {
        judgeUnavailable = message;
      },
    });
    const answer: JudgeArbitrateAnswerShape = { index, cost, ...(judgeUnavailable !== undefined ? { judgeUnavailable } : {}) };
    return answer;
  };
}
