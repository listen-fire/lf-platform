url: https://docs.stripe.com/api/events/object
title: The Event object | Stripe API Reference

Events are Stripe's way of letting you know when something interesting happens in your account. A webhook delivers an Event as its JSON body.

## Attributes

- `id` (string): unique identifier for the event, `evt_…`. A redelivery of the same event has the same `id`.
- `object` (string): `"event"`.
- `api_version` (string, nullable): the API version used to render `data`.
- `created` (timestamp): when the event was created, in seconds since the Unix epoch.
- `data.object` (object): the object the event is about, e.g. an [Invoice](https://docs.stripe.com/api/invoices/object) for `invoice.*` events.
- `data.previous_attributes` (object, optional): for `*.updated` events, the values of the attributes that changed.
- `livemode` (boolean)
- `pending_webhooks` (integer): how many webhooks haven't yet been delivered successfully.
- `request` (object, nullable): `{ id, idempotency_key }` of the API request that caused the event, if any.
- `type` (string): the event type, e.g. `invoice.payment_failed`. See [Types of events](https://docs.stripe.com/api/events/types).

## Example

```json
{
  "id": "evt_1NG8Du2eZvKYlo2CUI79vXWy",
  "object": "event",
  "api_version": "2024-06-20",
  "created": 1686089970,
  "data": { "object": { "id": "in_1NG8Dt2eZvKYlo2C…", "object": "invoice", "…": "…" } },
  "livemode": false,
  "pending_webhooks": 1,
  "request": { "id": null, "idempotency_key": null },
  "type": "invoice.payment_failed"
}
```
