// Why the server refused connecting the team to Telegram, read from the code
// the refusal carries and never from its text. The text is written for
// agents; the page says each reason in its own words. The codes are the
// server's (`TELEGRAM_TEAM_REFUSED`, views/connections.ts); each belongs to one
// refusal only, so none is confused with a malformed request.

export const TELEGRAM_NOT_USABLE =
  "Your team's Telegram connection exists, but you may not use it. Ask someone who may use it to share it with you.";

/** What connecting the team to Telegram does next when the server refused it. */
export type TelegramStep =
  /** The team has no connection yet: ask who may use the one this creates. */
  | { step: "ask_use" }
  /** A use list was sent for a connection that has since appeared: connect without one. */
  | { step: "connect_without_use" }
  | { step: "say"; sentence: string }
  /** Not a refusal the page can name. */
  | { step: "other" };

/** The code an error from the server carries, if it carries one. */
function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const { data } = error;
  if (typeof data !== "object" || data === null || !("code" in data)) return null;
  return typeof data.code === "string" ? data.code : null;
}

export function telegramStepAfter(error: unknown): TelegramStep {
  switch (codeOf(error)) {
    case "PRECONDITION_FAILED":
      return { step: "ask_use" };
    case "UNPROCESSABLE_CONTENT":
      return { step: "connect_without_use" };
    case "CONFLICT":
      return { step: "say", sentence: TELEGRAM_NOT_USABLE };
    default:
      return { step: "other" };
  }
}
