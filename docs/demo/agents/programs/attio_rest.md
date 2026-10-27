# Attio REST API (v2): the parts for reading records

Every request carries the workspace's access token as `Authorization: Bearer <token>`; bodies are JSON. Paths below are relative to the API's base URL.

## Objects and attributes

- `GET /v2/objects`: the workspace's objects. `{ data: [{ api_slug, singular_noun, plural_noun, … }] }`. People are `people`, companies `companies`.
- `GET /v2/objects/{object}/attributes`: an object's attributes, the workspace's own among them. `{ data: [{ api_slug, title, type, is_multiselect, … }] }`. `type` is one of `text`, `number`, `personal-name`, `email-address`, `domain`, `select`, `status`, `record-reference`, ….
- `GET /v2/objects/{object}/attributes/{attribute}/options`: a `select` attribute's options. `{ data: [{ id: { option_id }, title, is_archived }] }`. An option is set and filtered by its `title`.

## Records

- `POST /v2/objects/{object}/records/query`: the records matching a filter. Body `{ filter, limit }`; the filter names attributes by their `api_slug`, e.g. `{ "filter": { "email_addresses": "ada@example.com" }, "limit": 1 }` (shorthand for `$eq`; also `$in`, `$contains`, `$and`, `$or`, `$not`). Answers `{ data: [record] }`, empty when none matches.
- `GET /v2/objects/{object}/records/{record_id}`: one record. `{ data: record }`; 404 when there is none.

A record is `{ id: { workspace_id, object_id, record_id }, values }`. `values` holds every attribute by its `api_slug`, each as a list of typed values (empty when unset):

- `text`: `[{ value: "…" }]`
- `personal-name`: `[{ first_name, last_name, full_name }]`
- `email-address`: `[{ email_address: "…" }]`
- `select`: `[{ option: { id: { option_id }, title: "…" } }]`

## Errors

A failed request answers its HTTP status with `{ status_code, type, code, message }`. `429 Too Many Requests` is rate limiting and carries `Retry-After` (seconds); a `5xx` is a transient failure on Attio's side. Neither is retried by the API itself.
