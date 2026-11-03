url: https://docs.attio.com/docs/attribute-types
title: Attribute types | Attio Docs

A record's `values` hold each attribute as a list of values (empty when unset). Each value carries its `attribute_type` and the fields of its type:

- `text`: `{ "value": "…" }`
- `number`: `{ "value": 42 }`
- `personal-name`: `{ "first_name", "last_name", "full_name" }`
- `email-address`: `{ "email_address": "…" }`
- `domain`: `{ "domain": "…" }`
- `select`: `{ "option": { "id": { "option_id": "…" }, "title": "…" } }`
- `status`: `{ "status": { "id": { "status_id": "…" }, "title": "…" } }`
- `record-reference`: `{ "target_object": "companies", "target_record_id": "…" }`
- `actor-reference`: `{ "referenced_actor_type": "workspace-member", "referenced_actor_id": "…" }`
- `date`, `timestamp`: `{ "value": "2024-01-31" }`

A single-valued attribute holds at most one value; read it as `values.<slug>[0]`.
