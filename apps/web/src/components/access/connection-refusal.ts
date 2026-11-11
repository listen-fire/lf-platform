// Why the server refused connecting the team to Telegram, read from the reason
// its answer carries and never from text. The text is written for agents; the
// page says each reason in its own words. The reasons are the server's
// (`TelegramTeamConnect`, views/connections.ts).

export const TELEGRAM_NOT_USABLE =
  "Your team's Telegram connection exists, but you may not use it. Ask someone who may use it to share it with you.";

/** Why connecting the team to Telegram was refused. */
export type TelegramRefusal = "needs_use" | "not_usable" | "given_for_existing";

/** What connecting the team to Telegram does next when the server refused it. */
export type TelegramStep =
  /** The team has no connection yet: ask who may use the one this creates. */
  | { step: "ask_use" }
  /** A use list was sent for a connection that has since appeared: connect without one. */
  | { step: "connect_without_use" }
  | { step: "say"; sentence: string };

export function telegramStepAfter(reason: TelegramRefusal): TelegramStep {
  switch (reason) {
    case "needs_use":
      return { step: "ask_use" };
    case "given_for_existing":
      return { step: "connect_without_use" };
    case "not_usable":
      return { step: "say", sentence: TELEGRAM_NOT_USABLE };
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}
