url: https://docs.attio.com/rest-api/endpoint-reference/attributes/list-attributes
title: List attributes | Attio Docs

`GET /v2/objects/{object}/attributes`

Lists an object's attributes, Attio's standard ones and the workspace's own. `200`: `{ "data": [attribute, …] }`, each:

```json
{ "id": { "workspace_id": "…", "object_id": "people", "attribute_id": "…" }, "api_slug": "plan", "title": "Plan", "type": "select", "is_multiselect": false, "is_required": false, "is_unique": false, "is_writable": true }
```

## Select options

`GET /v2/objects/{object}/attributes/{attribute}/options`: a `select` attribute's options, `{ "data": [{ "id": { "option_id": "…" }, "title": "…", "is_archived": false }] }`.
