url: https://docs.attio.com/rest-api/endpoint-reference/records/get-a-record
title: Get a record | Attio Docs

`GET /v2/objects/{object}/records/{record_id}`

Gets one record by its id. `200`: `{ "data": record }` (a record as in [List records](https://docs.attio.com/rest-api/endpoint-reference/records/list-records)). `404` when there is no such record.
