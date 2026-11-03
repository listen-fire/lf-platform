url: https://docs.stripe.com/api/invoices/object
title: The Invoice object | Stripe API Reference

Invoices are statements of amounts owed by a customer. A subscription creates one each billing period and tries to pay it automatically.

## Attributes

- `id` (string): `in_…`.
- `object` (string): `"invoice"`.
- `account_country`, `account_name` (string, nullable): the country and public name of the business the invoice is from.
- `amount_due` (integer): final amount due at this time for this invoice, in the smallest currency unit (cents for `usd`; see [Currencies](https://docs.stripe.com/currencies)).
- `amount_paid`, `amount_remaining` (integer): in the smallest currency unit.
- `attempt_count` (integer): number of payment attempts made for this invoice.
- `attempted` (boolean): whether an attempt has been made to pay the invoice.
- `billing_reason` (enum, nullable): `subscription_cycle`, `subscription_create`, `subscription_update`, `manual`, ….
- `collection_method` (enum): `charge_automatically` or `send_invoice`.
- `currency` (enum): three-letter ISO currency code, in lowercase.
- `customer` (string, nullable): ID of the customer, `cus_…`.
- `customer_email` (string, nullable): the customer's email, as it was when the invoice was finalized.
- `customer_name` (string, nullable): the customer's name, as it was when the invoice was finalized.
- `hosted_invoice_url` (string, nullable): the URL of the hosted invoice page, where the customer can see and pay the invoice. Null until the invoice is finalized.
- `invoice_pdf` (string, nullable): the link to download the PDF.
- `lines` (list): the individual line items: `{ object: "list", data: [{ amount, currency, description, … }], has_more }`.
- `metadata` (object): set of key-value pairs.
- `next_payment_attempt` (timestamp, nullable): when the next payment attempt is scheduled, if any.
- `number` (string, nullable): a unique, human-readable identifier for the invoice, e.g. `LL-4300`.
- `paid` (boolean)
- `payment_intent` (string, nullable)
- `status` (enum, nullable): `draft`, `open`, `paid`, `uncollectible` or `void`.
- `subscription` (string, nullable): the subscription this invoice was prepared for, `sub_…`.
- `subscription_details.metadata` (object, nullable): the subscription's metadata when the invoice was created.
- `total` (integer): total after discounts and taxes, in the smallest currency unit.
