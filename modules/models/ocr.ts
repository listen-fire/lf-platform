// @lf/models as the ocr slot (docs/contracts/ocr-slot.md), on a vendor that
// reads PDFs and images itself: Gemini. The file goes to the install's model
// (the one `sonnet` goes to) with an instruction to transcribe it, and the
// answer is priced from the shared price table, as a model call is.
//
// Its own install entry (lf-external.ocr.yaml, `models_ocr`), not a second
// slot on the models install: lf holds one module to one slot (a manifest
// names its slot, `lf connect` and the conformance kit check it), so filling
// two would change that rule for every slot; a second entry costs only its
// settings, connected once more.

import type Anthropic from '@anthropic-ai/sdk';

import { costMicrodollars, priceFor, type ChatProvider } from '@listen-fire/anthropic';
import { OCR_METHODS, OCR_PRICES_METHOD, OCR_UNSUPPORTED_TYPE_CODE, OcrReadRequest, type OcrPricesAnswerShape, type OcrReadAnswerShape, type WireSlotManifestShape } from 'engine-contracts/slots';
import { chatProviderOf } from 'model-providers/chat';
import { claudeModelId, resolveModel } from 'movement-engine/public/models';
import { SlotRefusal, type SlotAnswer } from 'module-runtime/module-wire';

import { readInstall, type ModelsInstall } from './models';

export const MODELS_OCR_MANIFEST: WireSlotManifestShape = { protocolVersion: 2, name: 'models_ocr', kind: 'core', slot: 'ocr', methods: [...OCR_METHODS, OCR_PRICES_METHOD] };

/** Gemini bills a PDF page, and an image up to a tile, as this many input tokens. */
const TOKENS_PER_PAGE = 258;

/** Room for a long document's text; a transcription cut short is refused, not returned. */
const MAX_OUTPUT_TOKENS = 32_000;

/** Where each page's text begins, as Document AI's reader marks it (packages/ocr-google). */
const PAGE_START = '>>PAGE_START<<';

const SYSTEM = [
  'You transcribe documents.',
  "Answer with the file's text exactly as it is written, page by page in reading order, and nothing else: no commentary, no summary, no markdown fences.",
  `Begin each page with a line holding only ${PAGE_START}.`,
  'Write a table row by row, its cells separated by " | ". Leave out text you cannot read rather than guessing it.',
].join(' ');

type ImageType = Anthropic.Base64ImageSource['media_type'];
const IMAGE_TYPES: readonly ImageType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function imageType(mimeType: string): ImageType | undefined {
  return IMAGE_TYPES.find((type) => type === mimeType);
}

/** The file as the request carries it; undefined for a type the vendor does not read. */
function fileBlock(mimeType: string, data: string): Anthropic.ContentBlockParam | undefined {
  if (mimeType === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  const image = imageType(mimeType);
  return image !== undefined ? { type: 'image', source: { type: 'base64', media_type: image, data } } : undefined;
}

/** The model a read goes to: the one the install sends `sonnet` to. */
function ocrModel(install: ModelsInstall): { wireModel: string; priceKey: string } {
  const { provider, wireModel } = resolveModel(claudeModelId('sonnet'), { MODEL_MAP: install.modelMap });
  return { wireModel, priceKey: `${provider}/${wireModel}` };
}

function readsFiles(install: ModelsInstall): void {
  if (install.vendor !== 'gemini') {
    throw new SlotRefusal('bad_setting', `models_ocr reads files on gemini, whose models read PDFs and images themselves; this install's vendor is ${install.vendor}`);
  }
}

/** A PDF's pages, counted in its bytes (`/Type /Page`, not `/Pages`); at least one. */
function pdfPages(bytes: Buffer): number {
  return Math.max(1, bytes.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0);
}

/** `ocr.prices`: the least a page costs, its tokens at the model's input price. */
export function ocrPriceOf(install: ModelsInstall): OcrPricesAnswerShape {
  readsFiles(install);
  const price = priceFor(ocrModel(install).priceKey);
  // Every name was priced when the install was read.
  if (price === undefined) throw new Error(`models_ocr: no price for ${ocrModel(install).priceKey}`);
  return { perPage: (TOKENS_PER_PAGE * price.input) / 1_000_000 };
}

/** One `ocr.read`, made on the install's vendor. */
export async function readFile(install: ModelsInstall, bytes: Buffer, contentType: string, provider: ChatProvider): Promise<OcrReadAnswerShape> {
  readsFiles(install);
  const mimeType = contentType.split(';')[0].trim().toLowerCase();
  const file = fileBlock(mimeType, bytes.toString('base64'));
  if (file === undefined) throw new SlotRefusal(OCR_UNSUPPORTED_TYPE_CODE, `models_ocr reads PDFs and images (${IMAGE_TYPES.join(', ')}), not ${contentType}`);
  const { wireModel, priceKey } = ocrModel(install);
  let reply: Anthropic.Message;
  try {
    reply = await provider.messages
      .stream({ model: wireModel, max_tokens: MAX_OUTPUT_TOKENS, system: SYSTEM, messages: [{ role: 'user', content: [file, { type: 'text', text: 'Transcribe this file.' }] }] })
      .finalMessage();
  } catch (error) {
    throw new SlotRefusal('module_error', `${priceKey}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tokens = { inputTokens: reply.usage.input_tokens, outputTokens: reply.usage.output_tokens, cacheReadTokens: reply.usage.cache_read_input_tokens ?? 0, cacheCreationTokens: reply.usage.cache_creation_input_tokens ?? 0 };
  const microdollars = costMicrodollars(priceKey, tokens);
  if (microdollars === undefined) throw new Error(`models_ocr: no price for ${priceKey}`);
  if (reply.stop_reason === 'max_tokens') {
    throw new SlotRefusal('module_error', `${priceKey} stopped at ${MAX_OUTPUT_TOKENS} tokens before the file's text was done: a transcription cut short is not returned`);
  }
  const text = reply.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  return { text, pages: mimeType === 'application/pdf' ? pdfPages(bytes) : 1, cost: [{ label: priceKey, microdollars }] };
}

/** The slot's answers, reading the install once per distinct settings. */
export function modelsOcrAnswer(): SlotAnswer {
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
      case 'ocr.read': {
        const request = OcrReadRequest.safeParse(params);
        if (!request.success) throw new SlotRefusal('bad_request', `ocr.read: ${request.error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')}`);
        const held = installOf(settings);
        readsFiles(held.install);
        held.provider ??= chatProviderOf(held.install.access);
        return readFile(held.install, Buffer.from(request.data.bytes, 'base64'), request.data.contentType, held.provider);
      }
      case OCR_PRICES_METHOD:
        return ocrPriceOf(installOf(settings).install);
      default:
        throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
    }
  };
}
