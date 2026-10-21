// The shapes of a linked file: what a file import resolves to.

import type { MovementDeclaration, Program, ShapeDeclaration } from '../parser/ast';


export interface FileResolution {
  source: string;
}


/** Host-injected path resolution. `undefined` = no such file. */
export type ResolveFile = (path: string) => FileResolution | undefined;


export type LinkedExport =
  | { kind: 'movement'; name: string; declaration: MovementDeclaration; file: LinkedFile }
  | { kind: 'shape'; name: string; declaration: ShapeDeclaration; file: LinkedFile };


export interface LinkedFile {
  path: string;
  program: Program;
  /** This file's OWN file-imported names: local name → resolved export. */
  imports: Map<string, LinkedExport>;
}
