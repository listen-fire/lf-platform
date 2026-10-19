// The files slot on a Node host: where a team's file bytes are stored,
// streamed, presigned and deleted. A Node contract, since its bytes are Node
// streams; the platform and any files module (files-s3) take it from here.

import type { Readable } from 'node:stream';

export interface DocumentProvider {
  upload(
    readable: Readable,
    {
      filename,
      mimeType,
      contentLength,
      keyPrefix,
    }: {
      filename: string;
      mimeType?: string;
      contentLength: number;
      /** Optional isolation prefix for the stored object's key (e.g. a
       *  short-lived `exposed/` namespace). When set, the object key begins
       *  with it, so a presign route can be scoped to that prefix alone. */
      keyPrefix?: string;
    },
  ): Promise<{ objectUri: string; checksum: string }>;

  getFile({ objectUri }: { objectUri: string }): Promise<{
    webStream: ReadableStream;
    ContentLength: number | undefined;
    ContentType: string | undefined;
  } | null>;

  getFileNodeStream({ objectUri }: { objectUri: string }): Promise<
    Readable & {
      size: number;
      contentType?: string;
    }
  >;

  getDownloadUrl({ objectUri }: { objectUri: string }): Promise<string>;

  /**
   * The store's key for an `objectUri` it would serve, or undefined for one it
   * would not: the ONE reading of a URI, which every read, delete and
   * ownership check (`streamFileRef`) goes through, so none reads a key
   * another would not.
   */
  keyOf(objectUri: string): string | undefined;

  delete(uri: string): Promise<void>;
}
