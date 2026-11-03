url: https://docs.attio.com/rest-api/endpoint-reference/records/list-records
title: List records | Attio Docs

`POST /v2/objects/{object}/records/query`

Lists the records of an object that match a filter. `{object}` is the object's slug (`people`, `companies`) or id.

## Body

- `filter` (object, optional): which records to answer, by attribute slug. See [Filtering](https://docs.attio.com/rest-api/guides/filtering).
- `limit` (number, optional): the most records to answer.

```json
{ "filter": { "email_addresses": "ada@example.com" }, "limit": 1 }
```

## Response

`200`: `{ "data": [record, …] }`, an empty list when nothing matches. A record:

```json
{
  "id": { "workspace_id": "…", "object_id": "people", "record_id": "…" },
  "values": {
    "name": [{ "first_name": "Ada", "last_name": "Lovelace", "full_name": "Ada Lovelace", "attribute_type": "personal-name" }],
    "email_addresses": [{ "email_address": "ada@example.com", "attribute_type": "email-address" }]
  }
}
```

Every attribute's value is a list (empty when unset); see [Attribute types](https://docs.attio.com/docs/attribute-types) for each type's shape.
