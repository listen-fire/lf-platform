// Every carried version other than the current one is wired everywhere the
// registry's header says it must be. A line forgotten here builds and
// type-checks, and would otherwise fail only at the version's first `load()`
// in a deployed image.

import fs from 'node:fs';
import path from 'node:path';

import { carriedVersions, currentVersion } from '..';

const REPO = path.resolve(__dirname, '../../..');

function manifest(file: string): { name: string; version: string; main?: string; files?: string[]; dependencies?: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
}

const others = carriedVersions().filter((version) => version !== currentVersion());

describe.each(others.map((version) => [version.key, version] as const))('carried version %s', (key, version) => {
  const name = `@listen-fire/lang-${key}`;
  const dir = `packages/lang-${key}`;

  it(`is the package ${name} in ${dir}, at its release`, () => {
    expect(manifest(`${dir}/package.json`)).toMatchObject({ name, version: version.release });
  });

  it('resolves to its sources here and to its compiled JavaScript where the image installs it', () => {
    // An extensionless main is `index.ts` to the compiler and jest, and
    // `index.js` to Node in the image, where the build compiled it beside its
    // release's packages and `files` let the deploy carry it.
    const { main, files } = manifest(`${dir}/package.json`);
    expect(main).toBe('index');
    expect(files).toEqual(['**/*.js']);
    expect(fs.existsSync(path.join(REPO, dir, 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(REPO, dir, 'index.js'))).toBe(false);
  });

  it('is what its entry loads', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const required: object = require(name);
    expect(await version.load()).toEqual(expect.objectContaining(required));
  });

  it('is what its carried checker loads, when it checks', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const required: object = require(name);
    const { check } = version.provides;
    switch (check.kind) {
      case 'carried':
        expect(await check.lane()).toEqual(expect.objectContaining(required));
        break;
      case 'current':
      case 'held':
        break;
      default: {
        const unknown: never = check;
        throw new Error(`unknown check capability ${JSON.stringify(unknown)}`);
      }
    }
  });

  it('is a dependency of the registry and of the api', () => {
    expect(manifest('packages/language-versions/package.json').dependencies?.[name]).toBe('workspace:*');
    expect(manifest('apps/api/package.json').dependencies?.[name]).toBe('workspace:*');
  });

  it("is gathered into the image by the Dockerfile's version package glob", () => {
    const dockerfile = fs.readFileSync(path.join(REPO, 'deploy/Dockerfile'), 'utf8');
    const globs = [...dockerfile.matchAll(/packages\/([\w.-]*\*[\w.-]*)/g)].map((match) => match[1] ?? '');
    const matches = (glob: string) => new RegExp(`^${glob.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`).test(path.basename(dir));
    expect(globs.some(matches)).toBe(true);
  });
});

it('carries at least one version besides the current one, so the checks above ran', () => {
  expect(others.length).toBeGreaterThan(0);
});
