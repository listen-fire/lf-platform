import { askableEvents, eventCountLine, firedLine } from "../delivery-lines";

describe("a connection's recent delivery, as its list reads it", () => {
  it("says when it set nothing off", () => {
    expect(firedLine([])).toBe("Set nothing off you can read");
  });

  it("names each automation it set off once", () => {
    const listen = (automationName: string, listen: string) => ({ automationId: automationName, automationName, listen });
    expect(firedLine([listen("deals", "l1"), listen("deals", "l2"), listen("alerts", "l3")])).toBe("Set off deals, alerts");
  });

  it("offers each event it brought to be asked about, and the first when it does not say how many", () => {
    expect(askableEvents(3)).toEqual([0, 1, 2]);
    expect(askableEvents(0)).toEqual([]);
    expect(askableEvents(null)).toEqual([0]);
    expect(eventCountLine(1)).toBe("1 event");
    expect(eventCountLine(null)).toBe("events not counted");
  });
});
