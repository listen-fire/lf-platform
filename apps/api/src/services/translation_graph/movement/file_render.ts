// The production `files.render` — `FILE(content, "pdf" | "text")` turns a
// composed string into a stored file artifact and answers its descriptor.
//
// The PDF is drawn by `@lf/pdf`'s writer (no browser, no dependency): it
// reproduces the layout this once got from Chromium's `page.pdf` for the
// slack preview's plain-text path. This is the language versions 1 to 4
// spelling; from version 5 a movement calls the `@lf/pdf` plugin, whose answer
// the plugin invoker stores through `storeArtifact` below.
//
// The bytes go straight to the document store and never reach the engine:
// what comes back is a document-store descriptor, durable as it stands, so a
// movement that parks after composing a FILE() resumes holding the same file.
//
// Content is treated as PLAIN TEXT in both renderings, so what the author
// composed is what the reader sees — predictable over clever.

import { Readable } from 'node:stream';

import type { RenderFile } from 'movement-engine/public/host';
import type { FileRef } from 'movement-engine/public/adapter';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { documentStoreFileRef, teamDocumentKeyPrefix } from 'movement-engine/public/files';

import { renderPlainTextPdf } from '@listen-fire/pdf';

/** The team's `files.render`: its artifacts are stored under the team's key
 *  prefix, which is what makes them the team's to read again. */
export function renderFileArtifactFor(teamId: TeamId): RenderFile {
  return renderInto(teamId);
}

/** A render for no team: its artifacts carry no team's prefix, so only a store
 *  that vouches for its own files (a test's in-memory store) serves them back.
 *  The run host renders with `renderFileArtifactFor`. */
export const renderFileArtifact: RenderFile = renderInto(undefined);

function renderInto(teamId: TeamId | undefined): RenderFile {
  return async (input) => {
    if (input.type === 'text') {
      return storeArtifact({
        teamId,
        name: 'movement-artifact.txt',
        contentType: 'text/plain',
        bytes: Buffer.from(input.content, 'utf8'),
      });
    }
    const { bytes } = renderPlainTextPdf(input.content);
    return storeArtifact({
      teamId,
      name: 'movement-artifact.pdf',
      contentType: 'application/pdf',
      bytes,
    });
  };
}

export async function storeArtifact(options: {
  teamId: TeamId | undefined;
  name: string;
  contentType: string;
  bytes: Buffer;
}): Promise<FileRef> {
  const { teamId, name, contentType, bytes } = options;
  // Lazy import keeps the document-store + registry off this module's eval-time
  // graph (Playwright / dry-run captures load it without an S3 dependency).
  const { services } = await import('../../../adapters/registry');
  const { objectUri } = await services.document.upload(Readable.from(bytes), {
    filename: name,
    mimeType: contentType,
    contentLength: bytes.byteLength,
    ...(teamId !== undefined ? { keyPrefix: teamDocumentKeyPrefix(teamId) } : {}),
  });
  return documentStoreFileRef({ objectUri, name, contentType, size: bytes.byteLength });
}
