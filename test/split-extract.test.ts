// `wity split` and `wity extract`, against the fake Wity server.

import { stripVTControlCharacters as plain } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.ts";
import { fakeWity, GOOD_KEY, run, tempConfig } from "./helpers.ts";
import { extractReply, splitReply, THREAD } from "./replies.ts";

let wity: Awaited<ReturnType<typeof fakeWity>>;
let env: Record<string, string>;

beforeEach(async () => {
  wity = await fakeWity();
  env = { ...tempConfig(), WITY_BASE_URL: wity.url };
  expect((await run(["api-key", "set", "--stdin"], { env, stdin: GOOD_KEY })).code).toBe(EXIT.ok);
  wity.on("POST /v1/split", { status: 200, body: splitReply });
  wity.on("POST /v1/extract", { status: 200, body: extractReply });
});

afterEach(async () => {
  await wity.close();
});

describe("split", () => {
  it("sends plain words, and prints the full response when piped", async () => {
    const res = await run(["split", "--by", "one item per email"], { env, stdin: THREAD });
    expect(res.code).toBe(EXIT.ok);
    expect(wity.seen.at(-1)?.body).toEqual({ text: THREAD, split: "one item per email" });
    expect(JSON.parse(res.stdout).items).toHaveLength(2);
  });

  it("builds a spec from --unit and its options", async () => {
    await run(
      ["split", "-t", THREAD, "--unit", "email", "--starts-at", "a From: line", "--starts-at", "a Subject: line"],
      { env },
    );
    expect(wity.seen.at(-1)?.body).toEqual({
      text: THREAD,
      split: { unit: "email", starts_at: ["a From: line", "a Subject: line"] },
    });
  });

  it("splits with a skill", async () => {
    await run(["split", "-t", THREAD, "--skill", "email-thread"], { env });
    expect(wity.seen.at(-1)?.body).toEqual({ text: THREAD, skill: "email-thread" });
  });

  it("prints one item per line with --jsonl", async () => {
    const res = await run(["split", "-t", THREAD, "--jsonl"], { env });
    const lines = res.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "")).toEqual(splitReply.items[1]);
  });

  it("numbers the items with their offsets on a terminal", async () => {
    const res = await run(["split", "-t", THREAD], { env, stdoutTTY: true });
    const text = plain(res.stdout);
    expect(text).toContain("2 items  cut by the model");
    expect(text).toMatch(/1 {2}0–40\n\s+From: dana@example.com\n\s+Seal test failed\./);
    expect(text).toContain("412 input tokens");
  });

  it("refuses --skill with split options, and other bad flags, before sending", async () => {
    const before = wity.seen.length;
    for (const args of [
      ["--skill", "x", "--by", "one item per email"],
      ["--skill", "x", "--unit", "email"],
      ["--by", "one item per email", "--unit", "email"],
      ["--starts-at", "a From: line"],
      ["--by", "no"],
      ["--json", "--jsonl"],
    ]) {
      const res = await run(["split", "-t", THREAD, ...args], { env });
      expect(res.code, args.join(" ")).toBe(EXIT.usage);
    }
    expect(wity.seen).toHaveLength(before);
  });

  it("takes up to 60,000 characters", async () => {
    expect((await run(["split", "-t", "a".repeat(40_000), "--dry-run"], { env })).code).toBe(EXIT.ok);
    expect((await run(["split", "-t", "a".repeat(60_001), "--dry-run"], { env })).code).toBe(EXIT.usage);
  });

  it("prints the request with --dry-run and code with --code, and sends nothing", async () => {
    const before = wity.seen.length;
    const dry = await run(["split", "-t", "a\n\nb", "--by", "one item per paragraph", "--dry-run"], { env });
    expect(JSON.parse(dry.stdout)).toEqual({ text: "a\n\nb", split: "one item per paragraph" });
    const code = await run(["split", "-t", "a\n\nb", "--skill", "email-thread", "--code"], { env });
    expect(code.stdout).toContain("await client.split({");
    expect(code.stdout).toContain('skill: "email-thread"');
    expect(code.stdout).toContain(`curl ${wity.url}/v1/split`);
    expect(wity.seen).toHaveLength(before);
  });

  it("names a missing split skill in plain words", async () => {
    wity.on("POST /v1/split", { status: 404, body: { error: "no skill 'nope'", code: "not_found" } });
    const res = await run(["split", "-t", THREAD, "--skill", "nope"], { env });
    expect(res.code).toBe(EXIT.usage);
    expect(res.stderr).toContain("Not found: no skill 'nope'.");
    expect(res.stderr).toContain("wity skills list");
  });
});

describe("extract", () => {
  const args = [
    "extract",
    "-t",
    "This agreement between Kestrel Foods Ltd. and Brightmart Inc. takes effect on 14 March 2025.",
    "-f",
    "party=a company that signs the agreement",
    "-f",
    "effective date=when it takes effect",
    "-f",
    "court=the court that hears disputes",
    "--type",
    "effective date=date",
  ];

  it("sends fields and types in the API's shape", async () => {
    const res = await run(args, { env });
    expect(res.code).toBe(EXIT.ok);
    expect(wity.seen.at(-1)?.body).toMatchObject({
      fields: {
        party: "a company that signs the agreement",
        "effective date": "when it takes effect",
        court: "the court that hears disputes",
      },
      types: { "effective date": "date" },
    });
    expect(JSON.parse(res.stdout).fields.party).toEqual(["Kestrel Foods Ltd.", "Brightmart Inc."]);
  });

  it("prints each field's values with confidence, and says it isn't calibrated", async () => {
    const res = await run(args, { env, stdoutTTY: true });
    const text = plain(res.stdout);
    expect(text).toMatch(/party\n\s+Kestrel Foods Ltd\. {2}confidence 0\.980 · at 10–28/);
    // Never rounded up to 1.
    expect(text).toContain("confidence >0.999");
    expect(text).toMatch(/effective date {2}date\n\s+2025-03-14/);
    expect(text).toMatch(/court\n\s+none found/);
    expect(text).toContain("It isn't calibrated.");
  });

  it("checks fields and types before sending", async () => {
    const before = wity.seen.length;
    const tooMany = Array.from({ length: 17 }, (_, i) => ["-f", `f${i}=thing ${i}`]).flat();
    for (const bad of [
      ["-f", "party"],
      ["-f", "=no name"],
      ["-f", "a=x", "-f", "a=y"],
      ["-f", "a=x", "--type", "b=date"],
      ["-f", "a=x", "--type", "a=money"],
      tooMany,
    ]) {
      const res = await run(["extract", "-t", "x", ...bad], { env });
      expect(res.code, bad.join(" ")).toBe(EXIT.usage);
    }
    expect(wity.seen).toHaveLength(before);
  });

  it("prints code that calls extract", async () => {
    const res = await run([...args, "--code", "ts"], { env });
    expect(res.stdout).toContain("await client.extract({");
    expect(res.stdout).toContain('"effective date": "date"');
  });
});
