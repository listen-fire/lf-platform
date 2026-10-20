// The OCR slot's methods (docs/contracts/ocr-slot.md): a scanned PDF's or an
// image's bytes in, their text out. The host asks it only of a file with no
// usable text layer (an image always); a module asks it through the host's
// OCR door (`ctx.ocr`). Every answer says how many pages it read and what
// they cost, which the host adds to the run's spend. A module may publish
// its price per page (`ocr.prices`), so a host can refuse a read its run
// cannot afford before making it.

import { z } from 'zod';

import { WireCostLine } from '../protocol';

export const OCR_METHODS = ['ocr.read'] as const;

/** The optional method a module lists in its manifest when it publishes its price. */
export const OCR_PRICES_METHOD = 'ocr.prices';

/** The refusal code for bytes of a type the module does not read. */
export const OCR_UNSUPPORTED_TYPE_CODE = 'unsupported_type';

export const OcrReadRequest = z.object({
  /** The file's bytes, base64. */
  bytes: z.string().min(1),
  /** `application/pdf`, or an image type (`image/png`, `image/jpeg`, …). */
  contentType: z.string().min(1),
  /** The file's name, for the module's logs. */
  name: z.string().optional(),
  /** Names the read in cost lines and logs (`file_text`, `web.vc-url-retrieval`). */
  label: z.string().min(1),
});
export type OcrReadRequestShape = z.infer<typeof OcrReadRequest>;

export const OcrReadAnswer = z.object({
  /** Every page's text, in page order; empty when the pages hold none. */
  text: z.string(),
  /** The pages read (an image is one). */
  pages: z.number().int().nonnegative(),
  cost: z.array(WireCostLine),
});
export type OcrReadAnswerShape = z.infer<typeof OcrReadAnswer>;

/** `ocr.prices`: the least one page costs, in dollars. Zero: the module is
 *  free, and its answers may cost nothing. */
export const OcrPricesAnswer = z.object({ perPage: z.number().nonnegative() });
export type OcrPricesAnswerShape = z.infer<typeof OcrPricesAnswer>;
