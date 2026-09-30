// `wity ask`, `wity generate` and `--code`, against the fake Wity server.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.ts";
import { fakeWity, fixture, GOOD_KEY, run, tempConfig } from "./helpers.ts";

let wity: Awaited<ReturnType<typeof fakeWity>>;
let env: Record<string, string>;
let dir: string;

beforeEach(async () => {
  wity = await fakeWity();
  env = { ...tempConfig(), WITY_BASE_URL: wity.url };
  dir = env.XDG_CONFIG_HOME as string;
  expect((await run(["api-key", "set", "--stdin"], { env, stdin: GOOD_KEY })).code).toBe(EXIT.ok);
});

afterEach(async () => {
  await wity.close();
});

const write = (name: string, content: string): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

const QUESTIONS = `
questions:
  team:
    type: choice
    instructions: Which team should handle this ticket?
    criteria:
      billing: Payments, charges and refunds
      technical: Bugs, errors and outages
      other: Anything else
  urgent:
    type: noul
    instructions: Does the customer need this soon?
  severity:
    type: score
    instructions: How upset is the customer?
    criteria: [Not at all, A little, A lot]
`;

describe("ask", () => {
  it("sends every question in one call, in the API's shape", async () => {
    wity.reply(fixture("multi-auto"));
    const file = write("q.yaml", QUESTIONS);
    const res = await run(["ask", file, "--reasoning", "auto"], { env, stdin: "Charged twice, refund me today!" });
    expect(res.code).toBe(EXIT.ok);
    const sent = wity.seen.at(-1)?.body as { questions: Record<string, { type: string }>; reasoning: string };
    expect(Object.keys(sent.questions)).toEqual(["team", "urgent", "severity"]);
    expect(sent.questions.severity?.type).toBe("score");
    expect(sent.reasoning).toBe("auto");
    expect(JSON.parse(res.stdout).answers.team.choice).toBe("billing");
  });

  it("uses the file's state, and refuses a second one", async () => {
    const file = write("q.yaml", `state: {customer: Ada, message: Refund please}\n${QUESTIONS}`);
    const dry = await run(["ask", file, "--dry-run"], { env });
    expect(JSON.parse(dry.stdout).state).toEqual({ customer: "Ada", message: "Refund please" });
    const both = await run(["ask", file, "--text", "x"], { env });
    expect(both.code).toBe(EXIT.usage);
  });

  it("draws every answer under its name on a terminal", async () => {
    wity.reply(fixture("multi-auto"));
    const file = write("q.yaml", QUESTIONS);
    const res = await run(["ask", file, "--text", "x"], { env, stdoutTTY: true });
    const text = plain(res.stdout);
    expect(text).toContain("team  Which team should handle this ticket?");
    expect(text).toContain("urgent  Does the customer need this soon?");
    expect(text).toMatch(/● 2 {2}A lot/);
  });

  it("prints one value with --field name.path", async () => {
    wity.reply(fixture("multi-auto"));
    const file = write("q.yaml", QUESTIONS);
    const res = await run(["ask", file, "--text", "x", "--field", "team.choice"], { env });
    expect(res.stdout).toBe("billing\n");
    const missing = await run(["ask", file, "--text", "x", "--field", "nope.choice"], { env });
    expect(missing.code).toBe(EXIT.usage);
  });

  it("lists every problem in a bad file, and sends nothing", async () => {
    const before = wity.seen.length;
    const file = write(
      "bad.yaml",
      "questions:\n  a: {type: choice, instructions: '', criteria: {x: y}}\n  b: {type: maybe}\ntypo: 1\n",
    );
    const res = await run(["ask", file, "--text", "x"], { env });
    expect(res.code).toBe(EXIT.usage);
    expect(res.stderr).toContain("questions.a.instructions: can't be empty");
    expect(res.stderr).toContain("questions.a.criteria: needs 2 to 256 options");
    expect(res.stderr).toContain('Unrecognized key: "typo"');
    expect(wity.seen).toHaveLength(before);
  });

  it("refuses a file that isn't YAML or JSON", async () => {
    const file = write("bad.yaml", "questions: [unclosed");
    expect((await run(["ask", file, "--text", "x"], { env })).code).toBe(EXIT.usage);
  });
});

describe("generate", () => {
  it("prints just the text when piped", async () => {
    const res = await run(["generate", "Reply to the customer", "--text", "Charged twice"], { env });
    expect(res.code).toBe(EXIT.ok);
    expect(res.stdout).toMatch(/^Thank you for bringing this to our attention/);
    expect(wity.seen.at(-1)?.body).toEqual({ state: "Charged twice", instructions: "Reply to the customer" });
  });

  it("sends a shape and prints the parsed value as JSON", async () => {
    wity.generateReply(fixture("generate-shape"));
    const shape = write("shape.json", JSON.stringify({ type: "object", properties: { city: { type: "string" } } }));
    const res = await run(["generate", "Origin city", "--text", "LIS -> BER", "--shape", shape, "--max-tokens", "40"], {
      env,
    });
    expect(res.stdout).toBe('{"city":"Lisbon"}\n');
    expect(wity.seen.at(-1)?.body).toMatchObject({ max_tokens: 40, shape: { type: "object" } });
  });

  it("exits 1 when the JSON was cut off", async () => {
    wity.generateReply(fixture("generate-cut-off"));
    const shape = write("shape.yaml", "type: object\nproperties:\n  city: {type: string}\n");
    const res = await run(["generate", "Origin city", "--text", "x", "--shape", shape], { env });
    expect(res.code).toBe(EXIT.error);
    expect(res.stderr).toContain("--max-tokens");
  });

  it("strips escape codes from generated text", async () => {
    const reply = fixture("generate-text");
    reply.body.text = "line one\n\x1b[2Jline two\x1b]0;title\x07";
    wity.generateReply(reply);
    const res = await run(["generate", "Say it", "--text", "x"], { env });
    expect(res.stdout).toBe("line one\nline two\n");
  });

  it("works without any text", async () => {
    const res = await run(["generate", "Write a haiku about typed decisions"], { env });
    expect(res.code).toBe(EXIT.ok);
    expect(wity.seen.at(-1)?.body).toEqual({ instructions: "Write a haiku about typed decisions" });
  });

  it("checks the shape and --max-tokens before sending", async () => {
    const before = wity.seen.length;
    const notObject = write("shape.json", '{"type": "string"}');
    expect((await run(["generate", "x", "--shape", notObject], { env })).code).toBe(EXIT.usage);
    expect((await run(["generate", "x", "--max-tokens", "999"], { env })).code).toBe(EXIT.usage);
    expect(wity.seen).toHaveLength(before);
  });
});

describe("--code", () => {
  it("prints SDK code and curl, with $WITY_API_KEY and never the key, and sends nothing", async () => {
    const before = wity.seen.length;
    const res = await run(
      [
        "choice",
        "Which team?",
        "-o",
        "billing=Payments",
        "-o",
        "tech support=Bugs",
        "--text",
        'He said "hi"',
        "--code",
      ],
      {
        env,
      },
    );
    expect(res.code).toBe(EXIT.ok);
    expect(res.stdout).toContain('import { WityClient, choice } from "wity";');
    expect(res.stdout).toContain('"tech support": "Bugs",');
    expect(res.stdout).toContain('state: "He said \\"hi\\"",');
    expect(res.stdout).toContain(`const client = new WityClient({ baseURL: "${wity.url}" });`);
    expect(res.stdout).toContain('-H "Authorization: Bearer $WITY_API_KEY"');
    expect(res.stdout).toContain("<<'JSON'");
    expect(res.stdout).not.toContain(GOOD_KEY);
    expect(wity.seen).toHaveLength(before);
  });

  it("prints only one language when asked", async () => {
    const res = await run(["generate", "Say hi", "--code", "curl"], { env });
    expect(res.stdout).toMatch(/^curl /);
    expect(res.stdout).not.toContain("import");
    expect((await run(["generate", "Say hi", "--code", "python"], { env })).code).toBe(EXIT.usage);
  });

  it("writes code that type-checks against the SDK", async () => {
    const res = await run(["ask", write("q.yaml", QUESTIONS), "--text", "x", "--code", "ts"], { env });
    // Compiled inside the project, so the SDK import resolves to the same SDK the CLI uses.
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync } = await import("node:fs");
    const folder = join(process.cwd(), "node_modules", ".cache", "wity-cli-test");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "snippet.mts");
    writeFileSync(file, res.stdout);
    const tsc = join(process.cwd(), "node_modules", ".bin", "tsc");
    const args = [
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "nodenext",
      "--target",
      "es2022",
      "--types",
      "node",
      file,
    ];
    execFileSync(tsc, args, { cwd: process.cwd() });
  }, 20_000);
});
