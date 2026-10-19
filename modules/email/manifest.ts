// The email adapter's manifest: what the catalog, editor, checker and the
// authoring agent read about email without constructing the adapter. The
// inbound address it shows is the deployment's own (`address.ts`).

import type { AdapterManifest, ConfigBlock } from 'movement-engine/public/adapter';

import { INBOUND_EMAIL_ADDRESS_VAR, inboundRoutingAddress } from './address';
import { EMAIL_ADAPTER_ALIASES, EMAIL_ADAPTER_TYPE } from './types';

/**
 * Static manifest. Source-only — no write methods (so NOT a target) and no
 * `requiredCredentialType` (inbound creds live on the legacy `pipeline_input`,
 * not a team credential). No meta root.
 *
 */
// The inbound address an email trigger listens on, declared as config blocks
// (the forwarding-address UI organically replicated as data — no bespoke
// component). A `section` frames it in plain prose; a `slug` block collects
// the variable part of `<local>+<key>@<domain>` while the prefix/suffix show
// the whole address live in the input chrome. `config.key` is the plus-suffix
// the inbound handler matches against (`routingKey: true` declares it
// generically, so no named "forwarding-address" concept lives in the engine).
// Editable from the automation detail page; unique across the team's email
// triggers (the engine enforces it on write). `destination` and other
// structural keys live in config too but are derived from the orchestration,
// not user-edited.
//
// The prefix and suffix come from the deployment's own address (`address.ts`),
// not from a constant: they used to spell one hardcoded inbox, which told
// every other deployment's authors to forward their mail there. A deployment
// with no
// address configured still shows the block — the key is real and it is what a
// routed message will be matched on — but says nothing about where to send
// mail, because it does not know.
//
// Phase 2 (first ship)
export function emailTriggerConfig(): readonly ConfigBlock[] {
  const address = inboundRoutingAddress();
  return [
    {
      kind: 'section',
      tone: address === null ? 'note' : 'info',
      text:
        address === null
          ? 'This deployment has no inbound email address yet, so nothing can ' +
            `reach this automation. Set ${INBOUND_EMAIL_ADDRESS_VAR} to the ` +
            'address mail is delivered to.'
          : 'Email sent to your inbound address starts this automation. ' +
            'Forward or CC it to route a message into your movement.',
    },
    {
      kind: 'slug',
      key: 'key',
      label: 'Inbound email address',
      ...(address !== null ? { prefix: address.prefix, suffix: address.suffix } : {}),
      required: true,
      min: 1,
      max: 30,
      unique: true,
      routingKey: true,
    },
  ];
}

/** How the deployment's own address reads in prose, for the agent. */
function inboundAddressShape(): string {
  const address = inboundRoutingAddress();
  return address === null ? '<local>+<key>@<domain>' : `${address.prefix}<key>${address.suffix}`;
}

export const EMAIL_MANIFEST: AdapterManifest = {
  adapterType: EMAIL_ADAPTER_TYPE,
  displayName: 'Email',
  category: 'Email',
  aliases: EMAIL_ADAPTER_ALIASES,
  description:
    'Inbound email. Forward mail to a dedicated address and a movement runs ' +
    'on each message — sender, subject, body, and attachments. Built in; no ' +
    'account to connect.',
  get triggerExpectation() {
    return (
      'Fires once per email actually delivered to the movement\'s dedicated ' +
      `forwarding address (${inboundAddressShape()}) — it does NOT read an ` +
      'existing inbox or see mail sent elsewhere. The user must forward or ' +
      'send mail to that address for it to fire; the listen key is the ' +
      'plus-suffix, so different keys route different mail. Describe it as ' +
      '"when an email is sent to your inbound address", not "when you get an ' +
      'email".'
    );
  },
  supportedTriggers: ['webhook'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated',
    'getActorCandidates', 'extractActor', 'resolveFileRef',
  ],
  triggerKinds: ['CUSTOM_EMAIL', 'MAILGUN', 'INBOUND_EMAIL', 'GMAIL'],
  // Inbound mail reaches the trigger via a minted `<local>+<key>@<domain>`
  // forwarding address; the plus-suffix lives in `config.key`, declared as
  // the adapter's `routingKey` value block (no named inbound-channel flag).
  get triggerConfig() {
    return emailTriggerConfig();
  },
  // Without an address there is no door for mail to arrive at, so an author
  // who imports email on such a deployment is writing something that can
  // never fire. That is a gap they are shown, not a boot failure: a
  // deployment that uses no email at all should still start.
  get configurationGap() {
    return inboundRoutingAddress() === null
      ? `${INBOUND_EMAIL_ADDRESS_VAR} is not set, so no address routes mail into a movement`
      : undefined;
  },
  vocabulary: {
    icon: {
      d: 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zm16 2l-8 5-8-5v2l8 5 8-5V6z',
      fill: true,
    },
    // No discrete `subscribableEvents` (email has one implicit channel), so
    // everything lives under `default` — the same address→tag→bare
    // preference order `describeSource` used to hardcode.
    //
    // The address phrasing says what the reader has to DO, because this
    // channel only ever fires on mail they send to that address themselves
    // (see `triggerExpectation`): "arrives at" reads like a mailbox being
    // watched, which is the one thing it is not. The routing tag below is the
    // honest fallback while nothing has provisioned an address yet — a draft
    // has a tag and no address, and inventing one would name a place mail
    // cannot be sent.
    eventPhrase: {
      default: [
        { template: 'When you send an email to {address}' },
        { template: 'When an email arrives tagged `{key}`' },
        { template: 'When an email arrives' },
      ],
    },
  },
};
