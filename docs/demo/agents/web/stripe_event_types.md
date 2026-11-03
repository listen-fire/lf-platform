url: https://docs.stripe.com/api/events/types
title: Types of events | Stripe API Reference

Each event's `type` names what happened; `data.object` is the resource it happened to.

## Invoice events (`data.object` is an [Invoice](https://docs.stripe.com/api/invoices/object))

- `invoice.created`: occurs whenever a new invoice is created.
- `invoice.finalized`: occurs whenever a draft invoice is finalized and updated to be an open invoice.
- `invoice.paid`: occurs whenever an invoice payment attempt succeeds or an invoice is marked as paid out-of-band.
- `invoice.payment_failed`: occurs whenever an invoice payment attempt fails, due to either a declined payment, including soft decline, or to the lack of a stored payment method.
- `invoice.payment_succeeded`: occurs whenever an invoice payment attempt succeeds.
- `invoice.upcoming`: occurs X days before a subscription is scheduled to create an invoice that is automatically charged.
- `invoice.voided`: occurs whenever an invoice is voided.

## Customer and subscription events

- `customer.created`, `customer.updated`, `customer.deleted`: `data.object` is a Customer.
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`: `data.object` is a Subscription.

## Charge events

- `charge.succeeded`, `charge.failed`, `charge.refunded`: `data.object` is a Charge.
