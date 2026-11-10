// A credential the modal adds always goes with who may use it: the server
// creates nothing without that statement, and the person chose it first.

import type { Grantee } from "@/components/access/grantees";

export function newCredential<P extends object>(params: P, use: Grantee[] | null): P & { use: Grantee[] } {
  if (use === null) throw new Error("A new credential is added only once who may use it is chosen.");
  return { ...params, use };
}
