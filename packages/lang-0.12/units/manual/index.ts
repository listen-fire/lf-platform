// The manual unit as production described it at 0.12: its manifest, and the
// describing half of its adapter (`listEntryPoints`, `describe`). A run-now
// press, and the files it carries, are the running half, which this package
// does not carry.
//
//   listen to manual fire backfill

import type { Adapter, AdapterManifest } from '@listen-fire/engine/public/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor } from '@listen-fire/engine/public/catalog';

import { BaseAdapter } from '@listen-fire/module-kit/adapter/base';

import { MANUAL_HANDBOOK_SECTION } from './handbook_section';

/** Stable adapter identifier — the trigger `kind` of manual-derived rows. */
export const MANUAL_ADAPTER_TYPE = 'manual';

/** Type id for the invocation position a Run-now seeds. Internal currency —
 *  stays lowercase; authors see `MANUAL_INVOCATION_DISPLAY_NAME`. */
export const MANUAL_INVOCATION_TYPE_ID = 'invocation';

/** Natural type name for an invocation — TitleCase, like every other graph's
 *  nodes (adapters/CLAUDE.md). The event seed keys its position by this name
 *  (the address is the natural node name, layer 8); the typeId stays stable. */
export const MANUAL_INVOCATION_DISPLAY_NAME = 'Invocation';

/** Type id for the per-file record (one position per uploaded file). Internal
 *  currency — stays lowercase; authors see `MANUAL_FILE_DISPLAY_NAME`. */
export const MANUAL_FILE_TYPE_ID = 'file';

/** Natural type name for a supplied file — TitleCase. Every fanned file
 *  position carries this name as its `recordType` (THE ONE RULE, base.ts), so
 *  field reads resolve it through the resolver; the typeId stays stable. */
export const MANUAL_FILE_DISPLAY_NAME = 'File';

/** Edge id on the invocation that fans out one position per uploaded file. */
export const MANUAL_FILES_FIELD = 'files';

/**
 * Static manifest. Source-only, credential-free, no subscribable events
 * (the channel needs no registration — Run-now injects in-process). A
 * manual listener takes no config: `listen to go {} fire backfill`. An
 * invocation optionally carries text + files (accessed via `Text` field
 * and `Files` edge; the retired `#resources` bundle is gone).
 */
export const MANUAL_MANIFEST: AdapterManifest = {
  adapterType: MANUAL_ADAPTER_TYPE,
  displayName: 'Run now',
  description:
    'On-demand runs. A movement listening to a manual channel runs when ' +
    'someone presses Run now — optionally with text and/or files. Backfills, ' +
    'one-off jobs, direct submissions. Built in; nothing to connect.',
  supportedTriggers: ['webhook'],
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue', 'getRelated',
    'getActorCandidates', 'extractActor', 'resolveFileRef',
  ],
  // `web`/`WEB` are the legacy slugs of the now-folded web adapter; they alias
  // here so stored web-trigger rows resolve to manual at runtime.
  triggerKinds: ['web', 'WEB'],
  triggerExpectation:
    'Fires only when someone explicitly runs the movement — the Run button, ' +
    'a chat submission, or an API/agent call — optionally carrying text and ' +
    'files. Nothing fires on its own; do not present a manual channel as ' +
    'automatic capture.',
  handbookSection: MANUAL_HANDBOOK_SECTION,
  vocabulary: {
    // A built-in owns no brand, but it still owns a MARK: a card that names a
    // source and shows nothing beside it reads as a source we failed to
    // identify. So this is a glyph rather than a logo — drawn as a stroke, the
    // way the rest of the product draws its icons — and it says the one thing
    // this channel is: someone presses it.
    icon: {
      d: 'M7 4.5 L19 12 L7 19.5 Z',
      fill: false,
    },
    eventPhrase: {
      // Covers the `web`/`WEB` legacy-slug alias only — the former switch's
      // WEB_QUESTION/CHROME_EXTENSION/API cases have no owning adapter (they
      // are pre-translation-graph pipeline-input kinds, not adapters) and
      // fall through to the renderer core's generic fallback instead.
      default: [{ template: 'When data is submitted directly to Listen-Fire' }],
    },
  },
};

export class ManualSurface extends BaseAdapter implements Adapter {
  readonly adapterType = MANUAL_ADAPTER_TYPE;
  readonly supportedTriggers = MANUAL_MANIFEST.supportedTriggers;

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    // The natural names (`Invocation` / `File`, TitleCase) are the currency
    // authors, the checker, and the hover use; the internal `invocation` /
    // `file` typeIds live only in this adapter's private cache. They no longer
    // need to be identical: the event edge keys its seed by the natural node
    // NAME (the address, layer 8), fanned file positions carry the natural
    // name (THE ONE RULE, base.ts), and describe accepts either spelling — so
    // reads resolve through the resolver whichever way a position is stamped.
    return [
      {
        typeId: MANUAL_INVOCATION_TYPE_ID,
        displayName: MANUAL_INVOCATION_DISPLAY_NAME,
        writable: false,
        // Nothing enumerates Run-now presses — one is DELIVERED to the fired
        // movement. `readable: true` was the encoding's forced lie; the event
        // edge marker is what the honest spelling was blocked on. No
        // change-kind axis, so no `action` field.
        readable: false,
        fires: true,
      },
      {
        typeId: MANUAL_FILE_TYPE_ID,
        displayName: MANUAL_FILE_DISPLAY_NAME,
        writable: false,
        // A supplied file is reached ONLY via the invocation's `Files` edge —
        // the same child-type honesty as every category-1 sweep entry: the
        // position survives via reachability; the phantom root read dies.
        readable: false,
      },
    ];
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId === MANUAL_INVOCATION_TYPE_ID) {
      return {
        typeId: MANUAL_INVOCATION_TYPE_ID,
        displayName: MANUAL_INVOCATION_DISPLAY_NAME,
        description: 'One Run-now press — when, by whom, and any text or files supplied.',
        fields: [
          { fieldId: 'firedAt', displayName: 'Fired at', kind: 'date', writable: false, required: true, description: 'When the run was requested (UTC).' },
          { fieldId: 'actorEmail', displayName: 'Run by (email)', kind: 'string', writable: false, required: false, description: 'Email of the member who pressed Run now, when known.' },
          { fieldId: 'actorName', displayName: 'Run by (name)', kind: 'string', writable: false, required: false, description: 'Name of the member who pressed Run now, when known.' },
          { fieldId: 'text', displayName: 'Text', kind: 'string', writable: false, required: false, description: 'Text supplied when running the movement (optional).' },
          // `content` is a friendly alias for the text — authors who want
          // "the body" regardless of how the run was triggered use this.
          { fieldId: 'content', displayName: 'Content', kind: 'string', writable: false, required: false, description: 'The supplied text. An alias for "Text".' },
        ],
        references: [
          {
            fieldId: MANUAL_FILES_FIELD,
            targetTypeId: MANUAL_FILE_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: 'Files',
            // Read-only: the files came with the run request; nothing is
            // ever created along this edge.
            writable: false,
            description: 'Files supplied when running the movement (zero or more).',
          },
        ],
      };
    }
    if (typeId === MANUAL_FILE_TYPE_ID) {
      return {
        typeId: MANUAL_FILE_TYPE_ID,
        displayName: MANUAL_FILE_DISPLAY_NAME,
        fields: [
          { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: true },
          { fieldId: 'contentType', displayName: 'Content Type', kind: 'string', writable: false, required: true },
          { fieldId: 'size', displayName: 'Size', kind: 'number', writable: false, required: false },
          // `data` is the binary handle — the File primitive per
          // resources_currency.md, matching the email/whatsapp attachment's
          // File field so File-typed expressions route into File-typed targets.
          { fieldId: 'data', displayName: 'File', kind: 'file', writable: false, required: false },
        ],
        references: [],
      };
    }
    return null;
  }
}
