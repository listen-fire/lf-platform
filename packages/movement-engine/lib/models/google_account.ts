// Whether this deployment has a Google service account, read as presence of
// its variables only: the model map asks before routing a name to Google.
// Building credentials from them is the provider module's
// (@listen-fire/model-providers), so the engine carries no Google library.

/** The variables that must carry a value for the account to exist at all.
 *  `GOOGLE_PROJECT_LOCATION` is not among them: it has a default. */
const REQUIRED_VARS = ['GOOGLE_PRIVATE_KEY', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PROJECT_ID'] as const;

export function isGoogleServiceAccountConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return REQUIRED_VARS.every((name) => Boolean(env[name]));
}

/** The variables a caller still has to set. Empty when the account is complete. */
export function missingGoogleServiceAccountVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_VARS.filter((name) => !env[name]);
}
