url: https://docs.stripe.com/webhooks
title: Receive Stripe events in your webhook endpoint

Stripe sends events to your webhook endpoint as an HTTPS POST whose JSON body is an Event object. Listen for the event types your integration needs (for example `invoice.payment_failed`), and return a 2xx status before any slow work.

## Delivery

- Stripe retries an event whose delivery did not get a 2xx answer, for up to three days, with an exponential back off.
- **Handle duplicate events.** Webhook endpoints might occasionally receive the same event more than once. Guard against duplicated event receipts by logging the event IDs you've processed, and then not processing already-logged events.
- **Order isn't guaranteed.** Stripe doesn't guarantee that events are delivered in the order they were generated.

## Check signatures

Stripe signs each event it sends with the endpoint's secret, in the `Stripe-Signature` header. Hosted platforms that receive the webhook for you usually check it before your code runs.

## Event object

See [The Event object](https://docs.stripe.com/api/events/object): `type` says what happened, and `data.object` holds the API resource it is about, as it was when the event happened.
