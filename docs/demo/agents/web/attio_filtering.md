url: https://docs.attio.com/rest-api/guides/filtering
title: Filtering and sorting | Attio Docs

A filter names attributes by their `api_slug`.

- Shorthand: `{ "email_addresses": "ada@example.com" }` is `{ "email_addresses": { "$eq": "ada@example.com" } }`.
- `$eq`, `$in` (a list of values), `$contains` (text containing).
- `$and`, `$or` (lists of filters), `$not` (a filter).

A select or status attribute is filtered by its option's title: `{ "plan": "monthly" }`. Comparisons of text ignore case.
