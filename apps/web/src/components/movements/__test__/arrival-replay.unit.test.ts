import { replayForces } from "../arrival-replay";

describe("replaying an arrival from the activity list", () => {
  it("forces only an arrival that started a run before", () => {
    expect(replayForces("ran")).toBe(true);
    expect(replayForces("run_failed")).toBe(true);
    expect(replayForces("not_judged")).toBe(false);
  });

  it("does not force an arrival its listen waits on: it never ran", () => {
    expect(replayForces("waiting_for_host")).toBe(false);
  });

  it("does not force an arrival a carried version's gate stopped: it never ran", () => {
    expect(replayForces("does_not_fire")).toBe(false);
  });
});
