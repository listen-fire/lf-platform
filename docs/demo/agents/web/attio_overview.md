url: https://docs.attio.com/rest-api/overview
title: REST API overview | Attio Docs

Attio's REST API reads and writes the records, lists and notes of a workspace. Requests and responses are JSON; paths start with `/v2`.

## Authentication

Send the workspace's access token (or an OAuth access token) as a bearer token: `Authorization: Bearer <token>`.

## Objects, attributes and records

A workspace holds **objects** (`people`, `companies`, `deals`, and any custom objects). Each object has **attributes**: Attio's standard ones (a person's `name`, `email_addresses`) and the workspace's own custom ones. A **record** is one person, company or deal; its `values` hold every attribute by its `api_slug`. See [Attribute types](https://docs.attio.com/docs/attribute-types).

## Rate limits

Requests are rate limited per workspace. A request over the limit is answered `429 Too Many Requests`, with a `Retry-After` header saying how many seconds to wait before trying again.

## Errors

Errors are answered with an HTTP status and a body `{ status_code, type, code, message }`. A `5xx` status is a failure on Attio's side and is usually transient. The API does not retry anything for you; retry a 429 or 5xx after a delay.
