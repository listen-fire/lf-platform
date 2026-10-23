import type { Completions, Definition, HoverCard } from "movement-lang";

import {
  askDefinition,
  askHover,
  completionEdit,
  completionResultOf,
  definitionTargetOf,
  importPathTarget,
  latest,
  navTokenAt,
  presentationOf,
  type LanguageRemote,
} from "../editor-language";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A remote that records every call and answers what the test queues. */
function fakeRemote(answers: {
  complete?: Completions;
  hover?: HoverCard | null;
  definition?: Definition | null;
} = {}) {
  const calls: Array<{ method: keyof LanguageRemote; source: string; offset: number; signal: AbortSignal }> = [];
  const remote: LanguageRemote = {
    complete: async (source, offset, signal) => {
      calls.push({ method: "complete", source, offset, signal });
      return answers.complete ?? { from: offset, to: offset, items: [] };
    },
    hover: async (source, offset, signal) => {
      calls.push({ method: "hover", source, offset, signal });
      return answers.hover ?? null;
    },
    definition: async (source, offset, signal) => {
      calls.push({ method: "definition", source, offset, signal });
      return answers.definition ?? null;
    },
  };
  return { remote, calls };
}

describe("latest", () => {
  it("a superseded request is aborted and its answer dropped", async () => {
    const requests = latest();
    const first = deferred<string>();
    const second = deferred<string>();
    const signals: AbortSignal[] = [];

    const firstAsked = requests.ask((signal) => {
      signals.push(signal);
      return first.promise;
    });
    const secondAsked = requests.ask((signal) => {
      signals.push(signal);
      return second.promise;
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    // The stale answer lands after the fresh request went out: dropped.
    first.resolve("stale");
    second.resolve("fresh");
    await expect(firstAsked).resolves.toBeNull();
    await expect(secondAsked).resolves.toEqual({ answer: "fresh" });
  });

  it("a superseded hover asks the server twice and shows only the second card", async () => {
    const { remote, calls } = fakeRemote();
    const answers = [deferred<HoverCard | null>(), deferred<HoverCard | null>()];
    let n = 0;
    const slow: LanguageRemote = {
      ...remote,
      hover: (source, offset, signal) => {
        void remote.hover(source, offset, signal);
        return answers[n++]!.promise;
      },
    };
    const requests = latest();
    const stale = askHover(slow, requests, "a = 1", 0);
    const fresh = askHover(slow, requests, "a = 1", 4);
    answers[0]!.resolve({ from: 0, to: 1, markdown: "stale" });
    answers[1]!.resolve({ from: 4, to: 5, markdown: "fresh" });

    await expect(stale).resolves.toBeNull();
    await expect(fresh).resolves.toEqual({ from: 4, to: 5, markdown: "fresh" });
    expect(calls.map((c) => c.method)).toEqual(["hover", "hover"]);
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it("a failure of a superseded request is dropped; the live one's is the caller's", async () => {
    const requests = latest();
    const first = requests.ask(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const second = requests.ask(async () => {
      throw new Error("server down");
    });
    await expect(first).resolves.toBeNull();
    await expect(second).rejects.toThrow("server down");
  });

  it("cancel aborts the request in flight", async () => {
    const requests = latest();
    const pending = deferred<number>();
    let seen: AbortSignal | undefined;
    const asked = requests.ask((signal) => {
      seen = signal;
      return pending.promise;
    });
    requests.cancel();
    pending.resolve(1);
    expect(seen?.aborted).toBe(true);
    await expect(asked).resolves.toBeNull();
  });
});

describe("hover", () => {
  it("hover is markdown", async () => {
    const markdown = "```movement\nname: Text\n```\n\nThe company's **legal** name.";
    const { remote, calls } = fakeRemote({ hover: { from: 10, to: 14, markdown } });
    const card = await askHover(remote, latest(), "x = crm.name", 12);
    // The card is the server's markdown, whole: not split into plain lines.
    expect(card).toEqual({ from: 10, to: 14, markdown });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "hover", source: "x = crm.name", offset: 12 });
  });

  it("no card where the server has none", async () => {
    const { remote } = fakeRemote({ hover: null });
    await expect(askHover(remote, latest(), "x", 0)).resolves.toBeNull();
  });
});

describe("definition", () => {
  it("definitions map to DefinitionTarget, in-file inert", async () => {
    expect(definitionTargetOf({ file: "lib/helpers", from: 3, to: 9 })).toEqual({
      kind: "file",
      name: "lib/helpers",
    });
    expect(definitionTargetOf({ module: { namespace: "adapters", name: "attio" } })).toEqual({
      kind: "adapters",
      name: "attio",
    });
    expect(definitionTargetOf({ module: { namespace: "credentials", name: "AttioCred" } })).toEqual({
      kind: "credentials",
      name: "AttioCred",
    });
    expect(definitionTargetOf({ module: { namespace: "plugins", name: "summarise" } })).toEqual({
      kind: "plugins",
      name: "summarise",
    });
    expect(definitionTargetOf({ file: null, from: 0, to: 3 })).toBeUndefined();
    expect(definitionTargetOf(null)).toBeUndefined();

    const inFile = fakeRemote({ definition: { file: null, from: 0, to: 3 } });
    await expect(askDefinition(inFile.remote, latest(), "crm = attio()", 0)).resolves.toEqual({
      target: undefined,
    });
    const imported = fakeRemote({ definition: { module: { namespace: "adapters", name: "attio" } } });
    await expect(askDefinition(imported.remote, latest(), "crm = attio()", 7)).resolves.toEqual({
      target: { kind: "adapters", name: "attio" },
    });
    expect(imported.calls).toHaveLength(1);
  });

  it("an import line's quoted path is resolved lexically", () => {
    const doc = 'import { Shared } from "lib/helpers"\nx = Shared\n';
    const inPath = doc.indexOf("helpers");
    expect(importPathTarget(doc, inPath)).toEqual({
      from: doc.indexOf("lib"),
      to: doc.indexOf('"\n'),
      target: { kind: "file", name: "lib/helpers" },
    });
    // The token is the whole path, not the word under the pointer.
    expect(navTokenAt(doc, inPath)).toEqual({ from: doc.indexOf("lib"), to: doc.indexOf('"\n') });
    // Off the path, and off an import line, there is nothing lexical.
    expect(importPathTarget(doc, doc.indexOf("Shared"))).toBeUndefined();
    expect(importPathTarget(doc, doc.lastIndexOf("Shared"))).toBeUndefined();
    expect(navTokenAt(doc, doc.lastIndexOf("Shared") + 2)).toEqual({
      from: doc.lastIndexOf("Shared"),
      to: doc.lastIndexOf("Shared") + "Shared".length,
    });
  });
});

describe("the route", () => {
  it("the legacy route never calls the remote", () => {
    const { remote, calls } = fakeRemote();
    const legacy = presentationOf({ kind: "legacy" }, "4", remote);
    expect(legacy).toEqual({ kind: "legacy", options: { languageVersion: "4" } });
    expect(legacy !== null && "remote" in legacy).toBe(false);

    expect(presentationOf({ kind: "refused" }, "0.13.0", remote)).toBeNull();
    // A legacy route without its pin has no dialect to present under.
    expect(presentationOf({ kind: "legacy" }, undefined, remote)).toBeNull();

    const installed = presentationOf({ kind: "installed" }, undefined, remote);
    expect(installed).toEqual({ kind: "installed", remote });
    expect(calls).toHaveLength(0);
  });
});

describe("completionResultOf", () => {
  const answer: Completions = {
    from: 8,
    to: 10,
    items: [
      { label: "name", kind: "field", detail: "Text", from: 8, to: 10 },
      { label: "Company", kind: "type", from: 8, to: 10 },
      { label: "attio", kind: "module", from: 8, to: 10 },
      { label: "AttioCred", kind: "credential", from: 8, to: 10 },
      { label: "summarise", kind: "function", insert: "summarise()", from: 8, to: 10 },
      { label: "-[:company]->", kind: "edge", from: 7, to: 10 },
      {
        label: "+ connect Attio",
        kind: "credential",
        from: 8,
        to: 10,
        connectAction: { kind: "oauth", adapter: "attio" },
      },
    ],
  };
  const at = { pos: 10, explicit: false, before: "a" };

  it("maps the language service's kinds onto CodeMirror's, in the server's order", () => {
    const result = completionResultOf(answer, at);
    expect(result?.from).toBe(8);
    expect(result?.options.map((o) => [o.label, o.type])).toEqual([
      ["name", "property"],
      ["Company", "type"],
      ["attio", "namespace"],
      ["AttioCred", "constant"],
      ["summarise", "function"],
      ["-[:company]->", "property"],
      ["+ connect Attio", "constant"],
    ]);
    expect(result?.options[0]?.detail).toBe("Text");
    expect(result?.options[4]?.apply).toBe("summarise()");
    expect(result?.options[1]?.apply).toBeUndefined();
  });

  it("an item with its own range replaces that range, stretched by what was typed since", () => {
    const result = completionResultOf(answer, at);
    expect(typeof result?.options[5]?.apply).toBe("function");
    const edge = answer.items[5]!;
    expect(completionEdit(edge, answer, 10)).toEqual({ from: 7, to: 10, insert: "-[:company]->" });
    expect(completionEdit(edge, answer, 12)).toEqual({ from: 7, to: 12, insert: "-[:company]->" });
  });

  it("a connect item inserts nothing itself: it hands off", () => {
    const result = completionResultOf(answer, at);
    expect(typeof result?.options[6]?.apply).toBe("function");
  });

  it("pops up unprompted only after a word or trigger character", () => {
    const atStart = { pos: 8, explicit: false };
    const empty: Completions = { ...answer, from: 8, to: 8 };
    expect(completionResultOf(empty, { ...atStart, before: "." })).not.toBeNull();
    expect(completionResultOf(empty, { ...atStart, before: " " })).toBeNull();
    expect(completionResultOf(empty, { ...atStart, before: "=" })).toBeNull();
    expect(completionResultOf(empty, { ...atStart, before: "=", explicit: true })).not.toBeNull();
    expect(completionResultOf({ ...answer, items: [] }, { ...at, explicit: true })).toBeNull();
  });
});
