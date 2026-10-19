import { createHash, type BinaryToTextEncoding, type Hash } from 'node:crypto';
import { Transform } from 'node:stream';

// A pass-through that digests what flows by, so an upload is checksummed in
// the same pass that sends it.
export class ChecksumTransform extends Transform {
  private readonly hash: Hash;
  private digest: string | null = null;

  constructor(options: { algorithm: string; encoding: BinaryToTextEncoding } = { algorithm: 'md5', encoding: 'hex' }) {
    super({
      transform: (chunk, encoding, callback) => {
        this.hash.update(chunk, encoding);
        this.push(chunk, encoding);
        callback();
      },
      flush: (callback) => {
        this.digest = this.hash.digest(options.encoding);
        callback();
      },
    });
    this.hash = createHash(options.algorithm);
  }

  getDigest(): string {
    if (!this.digest) throw new Error('Digest not yet calculated');
    return this.digest;
  }
}
