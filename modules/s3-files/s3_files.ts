// @lf/s3-files: the files slot (docs/contracts/files-slot.md) over an S3
// interface bucket, with the meaning of lf's own @lf/local-files: a put makes
// a new document, only the tenant that put it owns it, and opening what was
// never stored is refused.

import { randomUUID } from 'node:crypto';

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { FILES_METHODS, FilesOpenRequest, FilesOwnsRequest, FilesPutRequest, type StoredFileShape, type WireSlotManifestShape } from 'engine-contracts/slots';
import { storeKey } from 'files-s3';
import { SlotRefusal, type SlotAnswer } from 'module-runtime/module-wire';

export const S3_FILES_MANIFEST: WireSlotManifestShape = { protocolVersion: 2, name: 's3_files', kind: 'core', slot: 'files', methods: [...FILES_METHODS] };

/** What lf.yaml's install entry for the module holds (lf-external.yaml's `settings`). */
export interface S3FilesSettings {
  bucket: string;
  region: string;
  /** Any S3 compatible service; absent means AWS S3 itself. */
  endpoint?: string;
  keyPrefix?: string;
  /** The bucket in the path rather than the host name (MinIO, a bare IP). */
  pathStyle: boolean;
  /** Both absent: the SDK's own provider chain (an IAM role, the environment). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

function text(settings: Record<string, unknown>, name: string): string | undefined {
  const value = settings[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function readSettings(settings: Record<string, unknown>): S3FilesSettings {
  const required = (name: string) => {
    const value = text(settings, name);
    if (value === undefined) throw new SlotRefusal('missing_setting', `s3_files has no \`${name}\` setting: run \`lf connect s3_files\``);
    return value;
  };
  const accessKeyId = text(settings, 'access_key_id');
  const secretAccessKey = text(settings, 'secret_access_key');
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw new SlotRefusal('missing_setting', 's3_files needs both `access_key_id` and `secret_access_key`, or neither (to use the environment’s credentials)');
  }
  const endpoint = text(settings, 'endpoint');
  const keyPrefix = text(settings, 'key_prefix')?.replace(/^\/+|\/+$/g, '');
  return {
    bucket: required('bucket'),
    region: required('region'),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(keyPrefix !== undefined && keyPrefix !== '' ? { keyPrefix } : {}),
    pathStyle: text(settings, 'path_style')?.toLowerCase() === 'true',
    ...(accessKeyId !== undefined && secretAccessKey !== undefined ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  };
}

export function s3ClientOf(settings: S3FilesSettings): S3Client {
  return new S3Client({
    region: settings.region,
    endpoint: settings.endpoint,
    forcePathStyle: settings.pathStyle,
    credentials: settings.credentials,
  });
}

/** One tenant's folder name: a single path segment that cannot collide with
 *  another tenant's (`a/b` never lands inside `a`). */
function tenantSegment(tenant: string): string {
  return encodeURIComponent(tenant).replace(/\./g, '%2E');
}

function nameSegment(name: string): string {
  const named = name.replace(/\//g, '_');
  return named === '.' || named === '..' ? 'file' : named;
}

export class S3Files {
  constructor(
    private readonly client: S3Client,
    private readonly settings: Pick<S3FilesSettings, 'bucket' | 'keyPrefix'>,
  ) {}

  private get folder(): string {
    return this.settings.keyPrefix === undefined ? '' : `${this.settings.keyPrefix}/`;
  }

  private objectUri(key: string): string {
    return `s3://${this.settings.bucket}/${key}`;
  }

  /** `<folder><tenant>/<uuid>/<name>` for the tenant, from a handle this
   *  module made; undefined for any other handle. */
  private keyOf(objectUri: string, tenant?: string): string | undefined {
    const head = `s3://${this.settings.bucket}/`;
    if (!objectUri.startsWith(head)) return undefined;
    const key = storeKey(objectUri.slice(head.length));
    if (key === undefined || !key.startsWith(this.folder)) return undefined;
    const segments = key.slice(this.folder.length).split('/');
    if (segments.length !== 3) return undefined;
    if (tenant !== undefined && segments[0] !== tenantSegment(tenant)) return undefined;
    return key;
  }

  async put(request: { tenant: string; name: string; contentType: string; bytes: string }): Promise<StoredFileShape> {
    const body = Buffer.from(request.bytes, 'base64');
    const key = `${this.folder}${tenantSegment(request.tenant)}/${randomUUID()}/${nameSegment(request.name)}`;
    await this.client.send(new PutObjectCommand({ Bucket: this.settings.bucket, Key: key, Body: body, ContentLength: body.length, ContentType: request.contentType }));
    return { __brand: 'FileRef', name: request.name, contentType: request.contentType, size: body.length, source: { store: 'document', objectUri: this.objectUri(key) } };
  }

  async owns(request: { objectUri: string; tenant: string }): Promise<boolean> {
    const key = this.keyOf(request.objectUri, request.tenant);
    if (key === undefined) return false;
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.settings.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async open(request: { objectUri: string }): Promise<{ bytes: string }> {
    const key = this.keyOf(request.objectUri);
    if (key === undefined) throw new SlotRefusal('not_found', `'${request.objectUri}' is not a document of this store`);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }));
      if (response.Body === undefined) throw new SlotRefusal('not_found', `${request.objectUri} has no body`);
      return { bytes: Buffer.from(await response.Body.transformToByteArray()).toString('base64') };
    } catch (error) {
      if (isNotFound(error)) throw new SlotRefusal('not_found', `no stored document ${request.objectUri}`);
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;
}

/** The slot's answers, building the client once per distinct settings (lf
 *  carries them on every request). */
export function s3FilesAnswer(options: { clientOf?: (settings: S3FilesSettings) => S3Client } = {}): SlotAnswer {
  const clientOf = options.clientOf ?? s3ClientOf;
  const clients = new Map<string, S3Files>();
  const filesOf = (raw: Record<string, unknown>) => {
    const settings = readSettings(raw);
    const id = JSON.stringify(settings);
    let files = clients.get(id);
    if (files === undefined) {
      files = new S3Files(clientOf(settings), settings);
      clients.set(id, files);
    }
    return files;
  };
  return async (method, params, settings) => {
    switch (method) {
      case 'files.put':
        return filesOf(settings).put(FilesPutRequest.parse(params));
      case 'files.owns':
        return filesOf(settings).owns(FilesOwnsRequest.parse(params));
      case 'files.open':
        return filesOf(settings).open(FilesOpenRequest.parse(params));
      default:
        throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
    }
  };
}
