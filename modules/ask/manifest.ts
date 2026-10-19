// Ask's manifest: what a host's catalog, editor, handbook and checker read
// about the adapter, construction-free.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { ASK_ADAPTER_TYPE } from './types';

export const ASK_MANIFEST: AdapterManifest = {
  adapterType: ASK_ADAPTER_TYPE,
  displayName: 'Ask',
  description:
    'Ask a person a question mid-run and wait for their answer. A written ask ' +
    'yields a private link that renders the right control — approve/decline, a ' +
    'typed value, a choice, an editable table, or an acknowledgement — and ' +
    'records the answer back against the run. Built in; nothing to connect.',
  authoringHints:
    'Write a question along its family edge: `-[:Check]->` (yes/no), ' +
    '`-[:Provide]->` (a typed value — set `Answer Type` to text/number/date/' +
    'boolean), `-[:Choose]->` (exactly one of `Options`), `-[:Select]->` ' +
    '(a subset of `Options`, possibly none), `-[:Correct]->` (review/edit ' +
    '`Rows` — records the changed fields and any dropped), `-[:Draft]->` (a ' +
    'structured answer the person composes), `-[:Form]->` (several named ' +
    '`Fields` answered together as one object), `-[:Review]->` (an ' +
    'acknowledgement). Each write yields a `Url` to deliver (Slack, email, …) ' +
    '— the adapter never delivers it for you. Cancel an open ask with ' +
    '`write a { Cancelled: true }`.',
  supportedTriggers: [],
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord',
  ],
};

