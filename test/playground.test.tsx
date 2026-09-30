// The playground, driven by typed keys, against the fake Wity server.

import { stripVTControlCharacters as plain } from "node:util";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCtx } from "../src/context.ts";
import type { FoundKey } from "../src/credentials.ts";
import { painter } from "../src/output.ts";
import { Playground } from "../src/playground.tsx";
import { fakeWity, fixture, GOOD_KEY } from "./helpers.ts";

const KEYS = { tab: "\t", enter: "\r", ctrlT: "\x14", right: "\x1b[C" };

let wity: Awaited<ReturnType<typeof fakeWity>>;

beforeEach(async () => {
  wity = await fakeWity();
});

afterEach(async () => {
  await wity.close();
});

const open = (initialText = "") => {
  const io = {
    env: { WITY_BASE_URL: wity.url },
    stdin: process.stdin,
    stdout: { write: () => true },
    stderr: { write: () => true },
    signal: new AbortController().signal,
  };
  const found: FoundKey = { key: GOOD_KEY, source: "file", location: "test" };
  const app = render(
    <Playground ctx={makeCtx(io, undefined)} found={found} initialText={initialText} paint={painter(false)} />,
  );
  const frame = () => plain(app.lastFrame() ?? "");
  /** Type keys one at a time, letting Ink handle each. */
  const type = async (...keys: string[]) => {
    for (const key of keys) {
      app.stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const waitFor = async (text: string) => {
    for (let i = 0; i < 200 && !frame().includes(text); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(frame()).toContain(text);
  };
  return { app, frame, type, waitFor };
};

describe("playground", () => {
  it("shows the fields and the key's prefix, never the key", () => {
    const { frame, app } = open();
    expect(frame()).toContain("wity playground");
    expect(frame()).toContain("wity_Test…");
    expect(frame()).toContain("Question");
    expect(frame()).not.toContain(GOOD_KEY);
    app.unmount();
  });

  it("asks a yes or no question and draws the answer", async () => {
    const { type, waitFor, app } = open("Refund me today!");
    // The text was given, so the question box has focus.
    await type(..."Is it urgent?".split(""), KEYS.enter);
    await waitFor("● yes");
    await waitFor("99.99%");
    await waitFor("123 input tokens");
    expect(wity.seen.at(-1)?.body).toMatchObject({
      state: "Refund me today!",
      questions: { answer: { type: "noul", instructions: "Is it urgent?" } },
      reasoning: "auto",
    });
    app.unmount();
  });

  it("switches to a choice with options, and sends them", async () => {
    wity.reply(fixture("choice"));
    const { type, waitFor, app } = open("Charged twice");
    await type(KEYS.tab, KEYS.tab, KEYS.tab, KEYS.right); // question → options (hidden for noul) → reasoning → text → type
    await waitFor("Options");
    await type(
      KEYS.tab,
      ..."Which team?".split(""),
      KEYS.tab,
      ..."billing=Payments; technical=Bugs; other".split(""),
      KEYS.enter,
    );
    await waitFor("billing");
    await waitFor("confidence");
    const sent = wity.seen.at(-1)?.body as { questions: { answer: { type: string; criteria: object } } };
    expect(sent.questions.answer).toEqual({
      type: "choice",
      instructions: "Which team?",
      criteria: { billing: "Payments", technical: "Bugs", other: "other" },
    });
    app.unmount();
  });

  it("says what's missing instead of sending", async () => {
    const { type, waitFor, app } = open();
    await type(KEYS.enter);
    await waitFor("Type or paste the text to judge first.");
    expect(wity.seen).toHaveLength(0);
    app.unmount();
  });

  it("shows the request as code with ctrl+t, without sending it", async () => {
    const { type, waitFor, app } = open("Hello");
    await type(..."Is it spam?".split(""), KEYS.ctrlT);
    await waitFor('import { WityClient, noul } from "wity-sdk";');
    await waitFor('noul("Is it spam?")');
    expect(wity.seen).toHaveLength(0);
    app.unmount();
  });

  it("ignores ctrl combinations in text boxes", async () => {
    const { type, frame, app } = open("x");
    await type("a", KEYS.ctrlT, KEYS.ctrlT, "b");
    expect(frame()).toContain("ab");
    expect(frame()).not.toContain("atb");
    app.unmount();
  });
});
