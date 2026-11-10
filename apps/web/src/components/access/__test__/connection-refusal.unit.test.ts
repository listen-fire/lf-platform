import { TELEGRAM_NOT_USABLE, telegramStepAfter } from "../connection-refusal";

/** An error as the tRPC client raises it: the server's text, and the code beside it. */
const refused = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });

describe("connecting the team to Telegram without saying who may use it", () => {
  it("asks who may use the connection only when the server says it needs the answer", () => {
    expect(telegramStepAfter(refused("PRECONDITION_FAILED", "text"))).toEqual({ step: "ask_use" });
  });

  it("tells a member who may not use the team's connection so in the page's words, not the server's", () => {
    const step = telegramStepAfter(refused("CONFLICT", "The team's Telegram connection is one you may not use."));
    expect(step).toEqual({ step: "say", sentence: TELEGRAM_NOT_USABLE });
    expect(TELEGRAM_NOT_USABLE).toBe(
      "Your team's Telegram connection exists, but you may not use it. Ask someone who may use it to share it with you.",
    );
  });

  it("connects again without a list when the connection appeared after the question was asked", () => {
    expect(telegramStepAfter(refused("UNPROCESSABLE_CONTENT", "…change who may use it with setAccess."))).toEqual({
      step: "connect_without_use",
    });
  });

  it("reads the code and never the text: a malformed request, or text that merely sounds like a refusal, is not one", () => {
    expect(telegramStepAfter(refused("BAD_REQUEST", "exists already, may not use, on the team"))).toEqual({ step: "other" });
    expect(telegramStepAfter(new Error("exists already, may not use, on the team"))).toEqual({ step: "other" });
    expect(telegramStepAfter(null)).toEqual({ step: "other" });
  });
});
