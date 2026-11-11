import { TELEGRAM_NOT_USABLE, telegramStepAfter } from "../connection-refusal";

describe("connecting the team to Telegram without saying who may use it", () => {
  it("asks who may use the connection only when the server says it needs the answer", () => {
    expect(telegramStepAfter("needs_use")).toEqual({ step: "ask_use" });
  });

  it("tells a member who may not use the team's connection so in the page's words, not the server's", () => {
    expect(telegramStepAfter("not_usable")).toEqual({ step: "say", sentence: TELEGRAM_NOT_USABLE });
    expect(TELEGRAM_NOT_USABLE).toBe(
      "Your team's Telegram connection exists, but you may not use it. Ask someone who may use it to share it with you.",
    );
  });

  it("connects again without a list when the connection appeared after the question was asked", () => {
    expect(telegramStepAfter("given_for_existing")).toEqual({ step: "connect_without_use" });
  });
});
