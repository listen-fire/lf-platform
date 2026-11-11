import { REFUSED_REPLAY_QUESTION, replayForces, replayQuestion, type ArrivalStatus } from "../arrival-replay";

describe("replaying an arrival from the activity list", () => {
  it("asks once before running an arrival its fire list refused, and nothing before any other", () => {
    expect(replayQuestion("refused")).toBe("This was refused by its fire list. Run it anyway?");
    expect(REFUSED_REPLAY_QUESTION).toBe(replayQuestion("refused"));
    const others: ArrivalStatus[] = ["ran", "run_failed", "not_judged"];
    for (const status of others) expect(replayQuestion(status)).toBeNull();
  });

  it("forces only an arrival that started a run before", () => {
    expect(replayForces("ran")).toBe(true);
    expect(replayForces("run_failed")).toBe(true);
    expect(replayForces("not_judged")).toBe(false);
    expect(replayForces("refused")).toBe(false);
  });
});
