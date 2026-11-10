import { newCredential } from "../new-credential";

describe("adding a credential from the modal", () => {
  it("carries who may use it beside everything else it adds", () => {
    expect(newCredential({ name: "Finance", type: "AFFINITY", credentials: { apiKey: "k" } }, [{ kind: "team" }])).toEqual({
      name: "Finance",
      type: "AFFINITY",
      credentials: { apiKey: "k" },
      use: [{ kind: "team" }],
    });
  });

  it("adds nothing before the person has chosen who may use it", () => {
    expect(() => newCredential({ name: "Finance" }, null)).toThrow("only once who may use it is chosen");
  });
});
