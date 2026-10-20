/* eslint-disable local-rules/bottom-exports */
/*
Keep *exported* constants here to import from a type free module and avoid
importing unwanted modules across the codebase, e.g. importing setup.ts into
production which won't have testing types installed
*/

export const TESTING_TEAM_NAME = 'Testing';
export const TESTING_USER_EMAIL = 'testing@listen-fire.local';

export const HEALTH_CHECK_ENDPOINT = '/.well-known/health-check';

// The release this build is, baked into the image at build time
// (`--build-arg LISTEN_FIRE_VERSION`, which the release workflow sets from the
// git tag). A tree nobody tagged is named by the commit the platform built it
// from when one is known (Render sets RENDER_GIT_COMMIT; other hosts set
// SOURCE_COMMIT), as `dev+<short sha>`, so two source builds are two releases
// — the deploy check runs once per release, and a fixed `dev` would run it
// once ever. With no commit to hand the honest answer is `dev`.
const sourceCommit = process.env.RENDER_GIT_COMMIT || process.env.SOURCE_COMMIT;
export const LISTEN_FIRE_VERSION =
  process.env.LISTEN_FIRE_VERSION && process.env.LISTEN_FIRE_VERSION !== 'dev'
    ? process.env.LISTEN_FIRE_VERSION
    : sourceCommit
      ? `dev+${sourceCommit.slice(0, 7)}`
      : 'dev';

// Worker liveness per mounted product. Separate from the probe above, whose
// 201-with-no-body is a deploy platform's contract.
export const WORKERS_HEALTH_ENDPOINT = '/healthz/workers';

// One second in milliseconds. Following the convention of singular for unit names
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

// default prisma transaction timeout in ms
export const DEFAULT_TRANSACTION_TIMEOUT =
  process.env.NODE_ENV === 'development' ? String(5 * MINUTE) : String(1 * MINUTE);

export const ADMIN_EMAIL = 'admin@listen-fire.local';

const KB = 1024;
export const MB = 1024 * KB;

export const OCR_START_PAGE_TAG = '>>PAGE_START<<';

export const HASHIDS_SALT = 'jgfGyPBtlMRP4R5FEDlykJVhGcSmWdHw';

export const isProd = process.env.NODE_ENV === 'production';


export const AUTH_COOKIE = 'listen_fire_token';
export const IMPERSONATE_COOKIE = 'listen_fire_impersonate';

// How long a sign-in link lives. ONE number, because it governs two things that
// have to agree: the `expires_at` on the magic_link_token row, and the `exp` of
// the JWT stored in that row. They used to disagree — 5h on the row, 1h on the
// JWT — and the verify path checks the row first, so a link in between passed
// the row check and then threw out of `verify()` as a 500 rather than as the
// "Invalid or expired token" every other rejection returns.
export const MAGIC_LINK_EXPIRY = 1 * HOUR;

export const ADVISORY_LOCK_SCOPES = {
  LISTEN_FIRE_API_APPLICATION: 1,
} as const;

export const ADVISORY_LOCK_IDS = {
  LISTEN_FIRE_API_APPLICATION_BACKGROUND_PROCESSING: 1,
} as const;
