// The one Google service account this deployment has, as Google's models are
// called with it: the account read from its four variables, the region models
// are addressed in, and the account as `google-auth-library` wants it.
//
// Read straight from the environment rather than through `getEnvVar`, because
// "no Google credentials" has to be expressible without throwing: image
// generation falls back to another vendor when they are absent, and the model
// route asks whether they are there before deciding anything.

import type { GoogleAuth } from 'google-auth-library';

import { missingGoogleServiceAccountVars } from 'movement-engine/public/models';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Where image generation and OCR address Google. Claude's endpoint is chosen
 *  separately (`GOOGLE_MODEL_REGION`) — it wants the global one, not a region. */
const DEFAULT_PROJECT_LOCATION = 'europe-west1';

export interface GoogleServiceAccount {
  privateKey: string;
  clientEmail: string;
  projectId: string;
  projectLocation: string;
}

/**
 * A PEM private key carried in an environment variable usually arrives with its
 * line breaks escaped — one `\n` per line, as two characters. Unescaping is a
 * no-op for a key that already has real newlines, so it is safe either way.
 */
function unescapeNewlines(key: string): string {
  return key.replace(/\\n/g, '\n');
}

export function googleServiceAccount(env: NodeJS.ProcessEnv = process.env): GoogleServiceAccount {
  const missing = missingGoogleServiceAccountVars(env);
  if (missing.length > 0) {
    throw new Error(`Google Cloud credentials are not configured — set ${missing.join(', ')}.`);
  }
  return {
    privateKey: unescapeNewlines(env.GOOGLE_PRIVATE_KEY ?? ''),
    clientEmail: env.GOOGLE_CLIENT_EMAIL ?? '',
    projectId: env.GOOGLE_PROJECT_ID ?? '',
    projectLocation: env.GOOGLE_PROJECT_LOCATION || DEFAULT_PROJECT_LOCATION,
  };
}

/** The service account as `google-auth-library` wants it, scoped for every
 *  Google Cloud API this deployment reaches. The library is an optional peer
 *  of this package, loaded on first use. */
export function googleAuth(env: NodeJS.ProcessEnv = process.env): GoogleAuth {
  const { privateKey, clientEmail } = googleServiceAccount(env);
  const library: typeof import('google-auth-library') = require('google-auth-library');
  return new library.GoogleAuth({
    credentials: {
      type: 'service_account',
      private_key: privateKey,
      client_email: clientEmail,
    },
    scopes: [CLOUD_PLATFORM_SCOPE],
  });
}

/**
 * Where this deployment addresses Google's MODELS. The global endpoint is the
 * recommended one and the only one without a regional price premium —
 * deliberately NOT {@link GoogleServiceAccount.projectLocation}, which is a real
 * region that OCR and image generation need.
 */
export function googleModelRegion(env: NodeJS.ProcessEnv = process.env): string {
  return env.GOOGLE_MODEL_REGION || 'global';
}
