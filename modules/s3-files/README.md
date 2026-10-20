# @lf/s3-files

The files slot over an S3 interface bucket. lf keeps the documents a run stores in your bucket instead of the project's `.lf/files/` folder, so they survive a container that is replaced.

Works against AWS S3, Google Cloud Storage (its S3 interoperability endpoint), Cloudflare R2, MinIO, and any service that speaks the S3 API.

## Install

1. Install the package into the project's externals folder and keep `lf-external.yaml` (shipped in the package) beside it, as `externals/s3_files/lf-external.yaml`.
2. Name it in `lf.yaml`:

   ```yaml
   core:
     files: s3_files
   ```

3. Run `lf connect s3_files` to give it its settings. They go to the project's secrets file (or `LF_SECRET__S3_FILES__<SETTING>` in containers and CI), never into `lf.yaml`.

## Settings

| setting | meaning |
|---|---|
| `bucket` | the bucket documents are kept in |
| `region` | the bucket's region (`auto` for R2; any value such as `us-east-1` for MinIO and GCS) |
| `endpoint` | the service's S3 URL; leave empty for AWS |
| `key_prefix` | a folder inside the bucket; leave empty for the bucket's root |
| `path_style` | `true` to put the bucket in the URL path (MinIO, a bare IP); empty for AWS, GCS and R2 |
| `access_key_id`, `secret_access_key` | the credentials (secret); leave both empty on AWS to use the machine's own (an IAM role, the environment) |

| service | `endpoint` | `path_style` |
|---|---|---|
| AWS S3 | empty | empty |
| Google Cloud Storage | `https://storage.googleapis.com` (use an HMAC key) | empty |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | empty |
| MinIO | `http://minio:9000` | `true` |

## How documents are kept

- A put stores the bytes at `<key_prefix>/<tenant>/<uuid>/<name>` with the content type given, and answers a descriptor whose handle is `s3://<bucket>/<key>`.
- Two puts of one name are two documents (the uuid differs).
- `files.owns` is true only for the tenant whose folder the key sits in, and only if the object exists. A handle from another bucket, outside the prefix, or shaped any other way is not owned.
- `files.open` of a document never stored is refused.
- Bytes travel base64 inside lf's request (the files slot has no streaming), so a document is held in memory whole.

## Tests

`pnpm test` in this folder runs the slot's conformance kit and every method against a fake S3 service driven by the real S3 client. It does not reach a real bucket.
