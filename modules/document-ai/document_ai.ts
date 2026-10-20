// @lf/document-ai: the ocr slot (docs/contracts/ocr-slot.md) on Google
// Document AI, through the platform's own adapter (packages/ocr-google):
// a file of up to 15 pages and 20 MB goes to the online endpoint, a longer
// one is batched through a Cloud Storage bucket, exactly as the platform
// reads a scanned PDF. Each read is priced per page.

import { Readable } from 'node:stream';

import { GoogleDocumentAIAdapter } from '@listen-fire/ocr-google';
import { OCR_METHODS, OCR_PRICES_METHOD, OCR_UNSUPPORTED_TYPE_CODE, OcrReadRequest, type OcrPricesAnswerShape, type OcrReadAnswerShape, type WireSlotManifestShape } from 'engine-contracts/slots';
import { SlotRefusal, type SlotAnswer } from 'module-runtime/module-wire';

export const DOCUMENT_AI_MANIFEST: WireSlotManifestShape = { protocolVersion: 2, name: 'document_ai', kind: 'core', slot: 'ocr', methods: [...OCR_METHODS, OCR_PRICES_METHOD] };

/** Enterprise Document OCR's list price: $1.50 per 1,000 pages. */
const LIST_PRICE_PER_PAGE = 0.0015;

/** What Document AI reads. */
const READABLE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/tiff', 'image/bmp', 'image/webp'];

/** One install's settings, read. */
export interface DocumentAiInstall {
  perPage: number;
  adapter: GoogleDocumentAIAdapter;
}

function text(settings: Record<string, unknown>, name: string): string | undefined {
  const value = settings[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function required(settings: Record<string, unknown>, name: string, why: string): string {
  const value = text(settings, name);
  if (value === undefined) throw new SlotRefusal('missing_setting', `document_ai has no \`${name}\` setting (${why}): run \`lf connect document_ai\``);
  return value;
}

export function readInstall(settings: Record<string, unknown>): DocumentAiInstall {
  const location = required(settings, 'location', 'where the processor lives: eu or us');
  const clientEmail = text(settings, 'client_email');
  const privateKey = text(settings, 'private_key');
  if ((clientEmail === undefined) !== (privateKey === undefined)) {
    throw new SlotRefusal('missing_setting', 'document_ai needs both `client_email` and `private_key`, or neither (to use the environment’s own Google credentials)');
  }
  const price = text(settings, 'price_per_page');
  const perPage = price === undefined ? LIST_PRICE_PER_PAGE : Number(price);
  if (!Number.isFinite(perPage) || perPage < 0) throw new SlotRefusal('bad_setting', `document_ai's \`price_per_page\` is "${price}": a price in dollars, such as 0.0015`);
  const bucketName = text(settings, 'bucket');
  const storageEndpoint = text(settings, 'storage_url');
  const adapter = new GoogleDocumentAIAdapter({
    projectId: required(settings, 'project', 'the Google Cloud project the processor is in'),
    projectLocation: location,
    processorId: required(settings, 'processor_id', "the OCR processor's id"),
    documentAiEndpoint: text(settings, 'base_url') ?? `${location}-documentai.googleapis.com`,
    ...(clientEmail !== undefined && privateKey !== undefined ? { clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') } : {}),
    ...(bucketName !== undefined ? { bucketName } : {}),
    ...(storageEndpoint !== undefined ? { storageEndpoint } : {}),
  });
  return { perPage, adapter };
}

/** A PDF's page count, which decides online or batch; undefined when the
 *  file cannot be opened (it is batched, as the platform batches every PDF
 *  whose pages it does not know). */
async function pdfPages(bytes: Uint8Array): Promise<number | undefined> {
  try {
    const { getDocumentProxy } = await import('unpdf');
    const document = await getDocumentProxy(new Uint8Array(bytes));
    return document.numPages;
  } catch {
    return undefined;
  }
}

/** One `ocr.read`. */
export async function readFile(install: DocumentAiInstall, bytes: Buffer, contentType: string): Promise<OcrReadAnswerShape> {
  const mimeType = contentType.split(';')[0].trim().toLowerCase();
  if (!READABLE_TYPES.includes(mimeType)) throw new SlotRefusal(OCR_UNSUPPORTED_TYPE_CODE, `Document AI reads PDFs and images (${READABLE_TYPES.join(', ')}), not ${contentType}`);
  const numpages = mimeType === 'application/pdf' ? await pdfPages(bytes) : 1;
  let read;
  try {
    read = await install.adapter.read(Readable.from(bytes), { size: bytes.length, mimeType, ...(numpages !== undefined ? { numpages } : {}) });
  } catch (error) {
    throw new SlotRefusal('module_error', `Document AI: ${error instanceof Error ? error.message : String(error)}`);
  }
  const microdollars = Math.round(read.pages * install.perPage * 1_000_000);
  return { text: read.text ?? '', pages: read.pages, cost: [{ label: 'document-ai/ocr', microdollars }] };
}

/** The slot's answers, reading the install once per distinct settings (lf
 *  carries them on every request). */
export function documentAiAnswer(): SlotAnswer {
  const installs = new Map<string, DocumentAiInstall>();
  const installOf = (settings: Record<string, unknown>) => {
    const id = JSON.stringify(settings);
    let install = installs.get(id);
    if (install === undefined) {
      install = readInstall(settings);
      installs.set(id, install);
    }
    return install;
  };
  return async (method, params, settings) => {
    switch (method) {
      case 'ocr.read': {
        const request = OcrReadRequest.safeParse(params);
        if (!request.success) throw new SlotRefusal('bad_request', `ocr.read: ${request.error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')}`);
        return readFile(installOf(settings), Buffer.from(request.data.bytes, 'base64'), request.data.contentType);
      }
      case OCR_PRICES_METHOD: {
        const prices: OcrPricesAnswerShape = { perPage: installOf(settings).perPage };
        return prices;
      }
      default:
        throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
    }
  };
}
