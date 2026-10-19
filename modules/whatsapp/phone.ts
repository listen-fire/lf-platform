// Canonical WhatsApp phone normalization, shared by the WhatsApp source
// adapter (candidate emission + actor extraction in `adapters/whatsapp`) and
// Listen-Fire's phone→user lookup (`acting_user_shared.lookupTeamUserByPhone`).
//
// Keeping ONE normalizer guarantees the phone the adapter surfaces as the
// `@actor_*` identifier is byte-identical to the value matched against
// `phone_number.phone_number` — they previously drifted (the adapter trimmed
// outer whitespace only; the lookup additionally stripped all internal
// whitespace), so a number could authenticate under one form and be reported
// under another.
//
// Mirrors v3 (`adapters/pipeline/inbound/twilio.adapter.ts`), which strips
// only the `whatsapp:` transport prefix (`From.replace('whatsapp:', '')`)
// before matching. We add a surrounding trim for robustness but deliberately
// do NOT alter the number's internal characters — matching v3's comparison
// exactly so the TG path authenticates the same senders v3 did.

export function normalizeWhatsappPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.trim().replace(/^whatsapp:/i, '').trim();
  return stripped.length > 0 ? stripped : null;
}
