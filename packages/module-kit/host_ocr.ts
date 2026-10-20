// The host's OCR slot, reached by a module served as a process: one POST per
// read to the host's OCR door, which the host answers through whatever fills
// its `ocr` slot (or refuses, saying the slot is empty). As with the models
// door, the door bills nothing itself: each read's cost is charged to the
// call that asked, so it rides that call's response `cost` to the run.

import { OcrReadAnswer, type OcrReadRequestShape } from 'engine-contracts/slots';

import type { ModuleOcr, ModuleSpend } from './define';

export interface HostOcrDoor {
  /** `{host}/api/public/adapter/{adapterType}/ocr`. */
  url: string;
  /** The headers the host's doors take from this process. */
  headers: Readonly<Record<string, string>>;
}

/** What a refused read says: the door's own message where it gave one. */
function refusal(status: number, body: string): string {
  try {
    const message: unknown = Reflect.get(Object(JSON.parse(body)), 'message');
    if (typeof message === 'string') return message;
  } catch {
    // Not JSON: the body as it came.
  }
  return `the host's OCR door answered ${status}: ${body}`;
}

export function hostOcr(door: HostOcrDoor): (spend: ModuleSpend) => ModuleOcr {
  return (spend) => ({
    async read(input) {
      const request: OcrReadRequestShape = {
        bytes: Buffer.from(input.bytes).toString('base64'),
        contentType: input.contentType,
        label: input.label,
        ...(input.name !== undefined ? { name: input.name } : {}),
      };
      const response = await fetch(door.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...door.headers },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error(refusal(response.status, await response.text()));
      const answer = OcrReadAnswer.parse(await response.json());
      for (const line of answer.cost) spend.charge(line);
      return { text: answer.text, pages: answer.pages };
    },
  });
}
