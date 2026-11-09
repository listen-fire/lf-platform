// What a remote module answers when it has no secret to be called with: the
// install holds none, or the one it holds is not the reader's to use. The two
// read the same, so a refusal never confirms a secret that is there.

/** The error of a read of a remote module that has no secret to authenticate with. */
export function noInstallSecret(adapterType: string): Error {
  return new Error(`Remote adapter "${adapterType}" has no credential configured (credentials_id is null).`);
}
