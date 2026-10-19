// The small timing and stream helpers the document sources were written with.

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** Wait `baseMs` plus up to `jitterMs` more, so a scripted session does not
 *  click at machine-regular intervals. */
export async function setJitteredTimeout({ baseMs, jitterMs = 0 }: { baseMs: number; jitterMs?: number }): Promise<void> {
  const waitMs = baseMs + jitterMs * Math.random();
  await new Promise((res) => setTimeout(res, waitMs));
}

type TimeoutState = 'timed_out' | 'cancelled';

interface Timer {
  promise: Promise<TimeoutState>;
  cancel(): void;
}

function timer(interval: number): Timer {
  let cleanup: (() => void) | undefined;
  const promise = new Promise<TimeoutState>((resolve) => {
    const handle = setTimeout(() => {
      cleanup = undefined;
      resolve('timed_out');
    }, interval);
    cleanup = () => {
      clearTimeout(handle);
      resolve('cancelled');
    };
  });
  return { promise, cancel: () => cleanup?.() };
}

/**
 * Repeat `action` every `interval` until `target` resolves, giving up after
 * `timeout` ("Timed out"). For a click whose effect (a download starting) is
 * the only sign it landed.
 */
export async function retryUntilResolves<T>({
  action,
  target,
  interval,
  timeout,
}: {
  action: (iteration: number) => unknown;
  target: Promise<T>;
  interval: number;
  timeout: number;
}): Promise<T> {
  const overall = timer(timeout);
  let finished = false;
  let timedOut = false;
  target.then(
    () => {
      finished = true;
    },
    () => undefined,
  );
  overall.promise.then((state) => {
    timedOut = state === 'timed_out' ? true : timedOut;
  });

  // If the target or the timeout has already settled, the action is not tried.
  await timer(0).promise;

  let iteration = 0;
  while (!finished && !timedOut) {
    const retry = timer(interval);
    await action(iteration);
    await Promise.race([target, retry.promise, overall.promise]);
    retry.cancel();
    iteration++;
  }

  overall.cancel();
  if (!finished) throw new Error('Timed out');
  return target;
}

/**
 * Put a stream's contents into a temporary file and read it back from there,
 * so the stream answered outlives whatever produced it (a download tied to a
 * browser that is about to close). The file is removed once read.
 */
export async function pipeThroughTmpFile(rs: Readable): Promise<{ data: Readable; size: number }> {
  const tmpFilePath = path.join(tmpdir(), randomUUID());
  await pipeline(rs, createWriteStream(tmpFilePath));
  const { size } = await stat(tmpFilePath);
  const data = createReadStream(tmpFilePath);
  data.on('close', async () => {
    await rm(tmpFilePath);
  });
  return { data, size };
}

/** A URL from what someone pasted: as written, else with `https://` before it. */
export function toUrl(url: string): URL {
  const trimmed = url.trim();
  for (const candidate of [trimmed, `https://${trimmed}`]) {
    try {
      return new URL(candidate);
    } catch (err) {
      console.error(err);
    }
  }
  throw new Error(`Could not make a URL from "${url}"`);
}

/** A fetch body as a Node stream. */
export function bodyStream(body: globalThis.ReadableStream<Uint8Array>): Readable {
  // The DOM and Node declare two ReadableStream types for the one object
  // fetch answers at runtime.
  return Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>);
}
