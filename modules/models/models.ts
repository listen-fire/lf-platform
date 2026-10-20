// @lf/models: the models slot (docs/contracts/models-slot.md) on one vendor
// the install names — Gemini, OpenAI, Claude on Anthropic's API or Claude on
// Vertex — through the platform's own pieces: its model map decides which
// vendor model answers each name a movement writes, its provider translators
// speak to the vendor, the shared client makes the call, and the shared price
// table prices it. Nothing here is a second copy of any of them.

import { z } from 'zod';

import { anthropicClient, costMicrodollars, priceFor, type ChatCall, type ChatProvider, type LlmUsage, type Price } from '@listen-fire/anthropic';
import { MODELS_METHODS, MODELS_PRICES_METHOD, ModelsCallRequest, type ModelsCallAnswerShape, type ModelsCallRequestShape, type ModelsPricesAnswerShape, type WireSlotManifestShape } from 'engine-contracts/slots';
import { chatProviderOf, type VendorAccess } from 'model-providers/chat';
import { chatModelNames, claudeModelId, hasCapability, isModelName, parseModelMap, providers, resolveModel, type ChatModelName, type ModelMap, type Provider } from 'movement-engine/public/models';
import { neverAsAny } from 'movement-engine/public/types';
import { SlotRefusal, type SlotAnswer } from 'module-runtime/module-wire';

export const MODELS_MANIFEST: WireSlotManifestShape = { protocolVersion: 2, name: 'models', kind: 'core', slot: 'models', methods: [...MODELS_METHODS, MODELS_PRICES_METHOD] };

/** The tier names a movement's `AI()` and extraction calls write, beside the
 *  registry's own names (`claudeModelId` says which registry name each is). */
const TIER_NAMES = ['haiku', 'sonnet', 'opus', 'opus5'] as const;
type TierName = (typeof TIER_NAMES)[number];

function isTierName(name: string): name is TierName {
  return TIER_NAMES.some((tier) => tier === name);
}

/** What a request may write as its `model`: a tier name or a chat model's own. */
function chatModelOf(name: string): ChatModelName | undefined {
  if (isTierName(name)) return claudeModelId(name);
  return isModelName(name) && hasCapability(name, 'chat') ? name : undefined;
}

/** The vendor model a name goes to when the install's map is silent and the
 *  vendor does not serve Claude under its own names. */
const DEFAULT_MODEL: Record<'gemini' | 'openai', string> = { gemini: 'gemini-3.8-flash', openai: 'gpt-5-mini' };

/** The answer's output ceiling when the request names none: lf's built-in
 *  module's flat ceiling, so moving a project to this module changes no call's room. */
const DEFAULT_MAX_TOKENS = 32_000;

/** One install: its vendor and the model map that sends every chat name there. */
export interface ModelsInstall {
  vendor: Provider;
  access: VendorAccess;
  /** `MODEL_MAP` as the platform reads it, the install's own lines and its defaults. */
  modelMap: string;
}

function text(settings: Record<string, unknown>, name: string): string | undefined {
  const value = settings[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isProvider(value: string): value is Provider {
  return providers.some((provider) => provider === value);
}

const missing = (name: string, why: string) => new SlotRefusal('missing_setting', `models has no \`${name}\` setting (${why}): run \`lf connect models\``);

function accessOf(vendor: Provider, settings: Record<string, unknown>): VendorAccess {
  const baseUrl = text(settings, 'base_url');
  const at = baseUrl !== undefined ? { baseUrl } : {};
  const apiKey = text(settings, 'api_key');
  const cloud = () => {
    const project = text(settings, 'google_project');
    if (project === undefined) throw missing('google_project', `${vendor} on Google Cloud needs its project`);
    const clientEmail = text(settings, 'google_client_email');
    const privateKey = text(settings, 'google_private_key');
    if ((clientEmail === undefined) !== (privateKey === undefined)) {
      throw new SlotRefusal('missing_setting', 'models needs both `google_client_email` and `google_private_key`, or neither (to use the environment’s own Google credentials)');
    }
    return {
      project,
      location: text(settings, 'google_region') ?? 'global',
      ...(clientEmail !== undefined && privateKey !== undefined ? { serviceAccount: { clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') } } : {}),
      ...at,
    };
  };
  switch (vendor) {
    case 'anthropic':
    case 'openai':
      if (apiKey === undefined) throw missing('api_key', `the ${vendor} API key`);
      return { provider: vendor, apiKey, ...at };
    case 'gemini':
      return { provider: 'gemini', access: apiKey !== undefined ? { apiKey, ...at } : { cloud: cloud() } };
    case 'vertex':
      return { provider: 'vertex', cloud: cloud() };
    default:
      return neverAsAny(vendor);
  }
}

/** The install's map lines (`model_map`), held to the platform's rules and to
 *  this install's one vendor: a line sending a name elsewhere has no key here. */
function ownLines(vendor: Provider, raw: string | undefined): ModelMap {
  let map: ModelMap;
  try {
    map = parseModelMap(raw);
  } catch (error) {
    throw new SlotRefusal('bad_setting', `models' \`model_map\`: ${error instanceof Error ? error.message.replace(/MODEL_MAP/g, 'model_map') : String(error)}`);
  }
  for (const [name, { provider, wireModel }] of map) {
    if (!hasCapability(name, 'chat')) throw new SlotRefusal('bad_setting', `models' \`model_map\` names ${name}, which is not a chat model`);
    if (provider !== vendor) throw new SlotRefusal('bad_setting', `models' \`model_map\` sends ${name} to ${provider}/${wireModel}, but this install's vendor is ${vendor}`);
  }
  return map;
}

/** Every chat name to this vendor: the install's own line, else its default
 *  model (`model`), else, for a vendor serving Claude, the name itself. */
function modelMapOf(vendor: Provider, settings: Record<string, unknown>): string {
  const own = ownLines(vendor, text(settings, 'model_map'));
  const fallback = (name: ChatModelName): string => {
    const model = text(settings, 'model');
    switch (vendor) {
      case 'gemini':
      case 'openai':
        return `${vendor}/${model ?? DEFAULT_MODEL[vendor]}`;
      case 'anthropic':
      case 'vertex':
        return `${vendor}/${model ?? name}`;
      default:
        return neverAsAny(vendor);
    }
  };
  const lines = Object.fromEntries(chatModelNames.map((name) => {
    const line = own.get(name);
    return [name, line !== undefined ? `${line.provider}/${line.wireModel}` : fallback(name)];
  }));
  // Parsed again so a bad `model` is refused as a map line would be.
  ownLines(vendor, JSON.stringify(lines));
  return JSON.stringify(lines);
}

export function readInstall(settings: Record<string, unknown>): ModelsInstall {
  const vendor = text(settings, 'vendor');
  if (vendor === undefined) throw missing('vendor', `one of ${providers.join(', ')}`);
  if (!isProvider(vendor)) throw new SlotRefusal('bad_setting', `models' \`vendor\` is "${vendor}": it is one of ${providers.join(', ')}`);
  const install = { vendor, access: accessOf(vendor, settings), modelMap: modelMapOf(vendor, settings) };
  for (const name of chatModelNames) {
    const key = priceKey(install, name);
    if (priceFor(key) === undefined) {
      throw new SlotRefusal('bad_setting', `models sends ${name} to ${key}, which has no price: name a priced model (modules/anthropic/prices.json lists them)`);
    }
  }
  return install;
}

/** Who bills a call to `name`, and what they call it: the price table's key. */
function priceKey(install: Pick<ModelsInstall, 'modelMap'>, name: ChatModelName): string {
  const { provider, wireModel } = resolveModel(name, { MODEL_MAP: install.modelMap });
  return `${provider}/${wireModel}`;
}

/** `models.prices`: every name a request may write, at its vendor model's price. */
export function pricesOf(install: ModelsInstall): ModelsPricesAnswerShape {
  const prices: Record<string, Price> = {};
  for (const name of [...TIER_NAMES, ...chatModelNames]) {
    const model = chatModelOf(name);
    const price = model === undefined ? undefined : priceFor(priceKey(install, model));
    if (price !== undefined) prices[name] = price;
  }
  return { prices };
}

/** One `models.call`, made by the shared client on the install's vendor. */
export async function callModel(install: ModelsInstall, request: ModelsCallRequestShape, chatProvider: ChatProvider): Promise<ModelsCallAnswerShape> {
  const asked = request.model ?? 'sonnet';
  const model = chatModelOf(asked);
  if (model === undefined) throw new SlotRefusal('bad_request', `models.call: model "${asked}" is not a model name (${[...TIER_NAMES, ...chatModelNames].join(', ')})`);
  const resolved = resolveModel(model, { MODEL_MAP: install.modelMap });
  const call: ChatCall = { client: chatProvider, wireModel: resolved.wireModel, resolved };
  const spent: LlmUsage[] = [];
  const client = anthropicClient({
    chatCallFor: () => call,
    recordUsage: async (usage) => void spent.push(usage),
    logFields: () => ({ module: 'models', vendor: install.vendor }),
  });
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const answer = async (): Promise<{ text: string; data?: unknown }> => {
    if (request.schema !== undefined) {
      const data = await client.anthropicChatStructured({
        system: request.system,
        userMessage: request.userMessage,
        model,
        maxTokens,
        label: request.label,
        schema: z.looseObject({}).meta(request.schema),
        toolName: request.toolName ?? 'answer',
        toolDescription: request.toolDescription ?? 'The answer, in the shape asked for.',
      });
      return { text: JSON.stringify(data), data };
    }
    const reply = await client.anthropicChatDetailed({
      system: request.system,
      userMessage: request.userMessage,
      model,
      maxTokens,
      label: request.label,
      // A ceiling the caller named is the answer's whole room: no continuation past it.
      noContinue: request.maxTokens !== undefined,
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
    });
    return { text: reply.text };
  };
  return { ...(await answer()), ...priced(spent) };
}

/** What the call spent, each vendor model's tokens priced from the table. */
function priced(spent: readonly LlmUsage[]): Pick<ModelsCallAnswerShape, 'cost' | 'usage'> {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const cost: ModelsCallAnswerShape['cost'] = [];
  for (const one of spent) {
    const tokens = { inputTokens: one.inputTokens, outputTokens: one.outputTokens, cacheReadTokens: one.cacheReadTokens ?? 0, cacheCreationTokens: one.cacheCreationTokens ?? 0 };
    usage.inputTokens += tokens.inputTokens;
    usage.outputTokens += tokens.outputTokens;
    usage.cacheReadTokens += tokens.cacheReadTokens;
    usage.cacheCreationTokens += tokens.cacheCreationTokens;
    const label = `${one.resolved.provider}/${one.resolved.wireModel}`;
    // Every name was priced when the install was read, so a key without a price is a fault here.
    const microdollars = costMicrodollars(label, tokens);
    if (microdollars === undefined) throw new Error(`models: no price for ${label}`);
    cost.push({ label, microdollars });
  }
  return { cost, usage };
}

/** The slot's answers, reading the install once per distinct settings (lf
 *  carries them on every request). The vendor's client is built at the first
 *  call: publishing prices reaches no vendor. */
export function modelsAnswer(): SlotAnswer {
  const installs = new Map<string, { install: ModelsInstall; provider?: ChatProvider }>();
  const installOf = (settings: Record<string, unknown>) => {
    const id = JSON.stringify(settings);
    let held = installs.get(id);
    if (held === undefined) {
      held = { install: readInstall(settings) };
      installs.set(id, held);
    }
    return held;
  };
  return async (method, params, settings) => {
    switch (method) {
      case 'models.call': {
        const request = ModelsCallRequest.safeParse(params);
        if (!request.success) throw new SlotRefusal('bad_request', `models.call: ${request.error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')}`);
        const held = installOf(settings);
        held.provider ??= chatProviderOf(held.install.access);
        return callModel(held.install, request.data, held.provider);
      }
      case MODELS_PRICES_METHOD:
        return pricesOf(installOf(settings).install);
      default:
        throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
    }
  };
}
