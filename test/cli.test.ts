// End-to-end: `wity <args>` run in-process against a fake Wity server on localhost.

import { stripVTControlCharacters as plain } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.ts";
import { BAD_KEY, fakeWity, fixture, GOOD_KEY, run, tempConfig } from "./helpers.ts";

let wity: Awaited<ReturnType<typeof fakeWity>>;
let env: Record<string, string>;

beforeEach(async () => {
  wity = await fakeWity();
  env = { ...tempConfig(), WITY_BASE_URL: wity.url };
});

afterEach(async () => {
  await wity.close();
});

/** Nothing the CLI prints may contain the key. */
const expectNoKey = (...outputs: string[]) => {
  for (const output of outputs) {
    expect(output).not.toContain(GOOD_KEY);
    expect(output).not.toContain(GOOD_KEY.slice(9));
  }
};

const keySaved = async () => {
  const res = await run(["api-key", "set", "--stdin"], { env, stdin: `${GOOD_KEY}\n` });
  expect(res.code).toBe(EXIT.ok);
};

describe("api-key set", () => {
  it("checks the key with the free /v1/models call, then saves it", async () => {
    const res = await run(["api-key", "set", "--stdin"], { env, stdin: `${GOOD_KEY}\n` });
    expect(res.code).toBe(EXIT.ok);
    expect(res.stderr).toContain("Saved.");
    expect(res.stderr).toContain("wity_Test…");
    expect(res.stdout).toBe("");
    expectNoKey(res.stdout, res.stderr);
    expect(wity.seen.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/models"]);
  });

  it("reads a typed key from a hidden prompt without echoing it", async () => {
    const res = await run(["api-key", "set"], { env, tty: { keys: [GOOD_KEY, "\r"] } });
    expect(res.code).toBe(EXIT.ok);
    expect(res.stderr).toContain("wity.alphanimble.com/console/keys");
    expectNoKey(res.stdout, res.stderr);
    expect((await run(["api-key", "show", "--json"], { env })).code).toBe(EXIT.ok);
  });

  it("skips bracketed-paste markers around a pasted key", async () => {
    const res = await run(["api-key", "set"], { env, tty: { keys: [`\x1b[200~${GOOD_KEY}\x1b[201~`, "\r"] } });
    expect(res.code).toBe(EXIT.ok);
  });

  it("cancels on Ctrl+C and saves nothing", async () => {
    const res = await run(["api-key", "set"], { env, tty: { keys: ["wity_abc", "\x03"] } });
    expect(res.code).toBe(EXIT.cancelled);
    expect(wity.seen).toHaveLength(0);
  });

  it("refuses a key Wity rejects, and saves nothing", async () => {
    const res = await run(["api-key", "set", "--stdin"], { env, stdin: BAD_KEY });
    expect(res.code).toBe(EXIT.auth);
    expect(res.stderr).toContain("Wity refused this key.");
    expect((await run(["api-key", "show"], { env })).code).toBe(EXIT.auth);
  });

  it("refuses a key with spaces before sending it anywhere", async () => {
    const res = await run(["api-key", "set", "--stdin"], { env, stdin: "wity_abc def" });
    expect(res.code).toBe(EXIT.usage);
    expect(wity.seen).toHaveLength(0);
  });

  it("never follows a redirect, so the key only goes to the address it was meant for", async () => {
    const elsewhere = await fakeWity();
    wity.models({ status: 302, headers: { location: `${elsewhere.url}/v1/models` } });
    const res = await run(["api-key", "set", "--stdin"], { env, stdin: GOOD_KEY });
    expect(res.code).toBe(EXIT.error);
    expect(elsewhere.seen).toHaveLength(0);
    await elsewhere.close();
  });

  it("refuses plain http for anything but localhost", async () => {
    const res = await run(["api-key", "set", "--stdin", "--base-url", "http://example.com"], { env, stdin: GOOD_KEY });
    expect(res.code).toBe(EXIT.usage);
    expect(res.stderr).toContain("https://");
  });
  it("replaces a key saved before", async () => {
    await keySaved();
    const second = "wity_SecondKey0123456789abcdefghijklmnopqrstuvwx";
    wity.models({ status: 200, body: { object: "list", data: [] } });
    expect((await run(["api-key", "set", "--stdin"], { env, stdin: second })).code).toBe(EXIT.ok);
    expect(JSON.parse((await run(["api-key", "show"], { env })).stdout).key).toBe("wity_Seco…");
  });

  it("takes the key on the command line, checks it, and saves it", async () => {
    const res = await run(["api-key", "set", GOOD_KEY], { env });
    expect(res.code).toBe(EXIT.ok);
    expect(res.stderr).toContain("Saved.");
    expectNoKey(res.stdout, res.stderr);
    expect(wity.seen.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/models"]);
    expect(JSON.parse((await run(["api-key", "show"], { env })).stdout).works).toBe(true);
  });

  it("refuses a command-line key that Wity rejects, and saves nothing", async () => {
    const res = await run(["api-key", "set", BAD_KEY], { env });
    expect(res.code).toBe(EXIT.auth);
    expect((await run(["api-key", "show"], { env })).code).toBe(EXIT.auth);
  });

  it("refuses extra values and unknown options, and never prints them back", async () => {
    for (const args of [
      ["api-key", "set", GOOD_KEY, "extra"],
      ["api-key", "set", GOOD_KEY, "--stdin"],
      ["api-key", "set", "--api-key", GOOD_KEY],
      ["api-key", "set", `--api-key=${GOOD_KEY}`],
      ["api-key", GOOD_KEY],
      ["api-key", `--api-key=${GOOD_KEY}`],
    ]) {
      const res = await run(args, { env });
      expect(res.code, args.join(" ")).toBe(EXIT.usage);
      expectNoKey(res.stdout, res.stderr);
    }
    expect(wity.seen).toHaveLength(0);
  });
});

describe("api-key show and api-key remove", () => {
  it("shows the key's prefix and source, never the key", async () => {
    await keySaved();
    const res = await run(["api-key", "show"], { env });
    expect(res.code).toBe(EXIT.ok);
    const info = JSON.parse(res.stdout);
    expect(info).toMatchObject({ api: wity.url, key: "wity_Test…", source: "file", works: true });
    expectNoKey(res.stdout, res.stderr);
  });

  it("says when the key comes from WITY_API_KEY", async () => {
    const res = await run(["api-key", "show"], { env: { ...env, WITY_API_KEY: GOOD_KEY } });
    expect(JSON.parse(res.stdout).source).toBe("env");
  });

  it("exits 3 when the saved key is refused", async () => {
    await keySaved();
    wity.models({ status: 401, body: { detail: "invalid API key" } });
    const res = await run(["api-key", "show"], { env });
    expect(res.code).toBe(EXIT.auth);
    expect(JSON.parse(res.stdout).works).toBe(false);
  });

  it("api-key remove deletes the saved key, and says it still works until revoked", async () => {
    await keySaved();
    const res = await run(["api-key", "remove"], { env });
    expect(res.code).toBe(EXIT.ok);
    expect(res.stderr).toContain("still works until you revoke it");
    expect((await run(["api-key", "show"], { env })).code).toBe(EXIT.auth);
  });

  it("warns that WITY_API_KEY still applies after api-key remove", async () => {
    const res = await run(["api-key", "remove"], { env: { ...env, WITY_API_KEY: GOOD_KEY } });
    expect(res.stderr).toContain("unset WITY_API_KEY");
  });

  it("doesn't use a key saved for a different API address", async () => {
    await keySaved();
    const other = await fakeWity();
    const res = await run(["--base-url", other.url, "noul", "Is it?", "--text", "hi"], { env });
    expect(res.code).toBe(EXIT.auth);
    expect(other.seen).toHaveLength(0);
    await other.close();
  });
});

describe("doctor", () => {
  it("passes every check with a saved key", async () => {
    await keySaved();
    const res = await run(["doctor"], { env });
    const report = JSON.parse(res.stdout);
    expect(res.code).toBe(EXIT.ok);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c: { name: string }) => c.name)).toEqual([
      "Node.js",
      "API address",
      "Key storage",
      "Wity reachable",
      "API key",
      "Key accepted",
    ]);
    expectNoKey(res.stdout);
  });

  it("exits 3 with no key", async () => {
    const res = await run(["doctor"], { env });
    expect(res.code).toBe(EXIT.auth);
  });
});

describe("questions", () => {
  it("sends a noul question and prints JSON when piped", async () => {
    await keySaved();
    const res = await run(["noul", "Does the customer need this soon?", "--reasoning", "off"], {
      env,
      stdin: "Refund me today!",
    });
    expect(res.code).toBe(EXIT.ok);
    const call = wity.seen.at(-1);
    expect(call?.authorization).toBe(`Bearer ${GOOD_KEY}`);
    expect(call?.body).toEqual({
      state: "Refund me today!",
      questions: { answer: { type: "noul", instructions: "Does the customer need this soon?" } },
      reasoning: "off",
    });
    expect(JSON.parse(res.stdout).answers.answer.noul).toBeCloseTo(0.99987, 4);
  });

  it("prints bars, the winner and the cost on a terminal", async () => {
    await keySaved();
    wity.reply(fixture("choice"));
    const res = await run(
      [
        "choice",
        "Which team?",
        "-o",
        "billing=Payments",
        "-o",
        "technical=Bugs",
        "-o",
        "other",
        "--text",
        "charged twice",
      ],
      { env, stdoutTTY: true },
    );
    expect(res.code).toBe(EXIT.ok);
    const text = plain(res.stdout);
    expect(text).toContain("Which team?");
    expect(text).toMatch(/● billing\s+█+\s+>99\.99%/);
    expect(text).toContain("<0.01%");
    expect(text).toContain("confidence >0.999");
    expect(text).toContain("143 input tokens");
    expectNoKey(res.stdout, res.stderr);
  });

  it("shows when Wity thought first", async () => {
    await keySaved();
    wity.reply(fixture("noul-always"));
    const res = await run(["noul", "Urgent?", "--text", "now", "--reasoning", "always"], { env, stdoutTTY: true });
    const text = plain(res.stdout);
    expect(text).toContain("Wity thought first, because reasoning was set to always. 33 thought tokens.");
    expect(text).toContain("Before thinking: yes 99.99%");
  });

  it("strips escape codes from text the API sends back", async () => {
    await keySaved();
    const reply = fixture("score");
    (reply.body.answers as { severity: { legend: Record<string, string> } }).severity.legend["2"] =
      "\x1b[2J\x1b[31mA lot";
    wity.reply(reply);
    const res = await run(["score", "How much?", "-l", "a", "-l", "b", "-l", "c", "--text", "x"], {
      env,
      stdoutTTY: true,
    });
    expect(res.stdout).toContain("A lot");
    expect(res.stdout).not.toContain("\x1b[2J");
  });

  it("prints one field with --field", async () => {
    await keySaved();
    wity.reply(fixture("choice"));
    const res = await run(
      ["choice", "Team?", "-o", "billing", "-o", "technical", "-o", "other", "--text", "x", "--field", "choice"],
      {
        env,
      },
    );
    expect(res.stdout).toBe("billing\n");
  });

  it("exits 10 when the answer fails --fail-under", async () => {
    await keySaved();
    const pass = await run(["noul", "Urgent?", "--text", "x", "--fail-under", "0.9"], { env });
    expect(pass.code).toBe(EXIT.ok);
    const fail = await run(["noul", "Urgent?", "--text", "x", "--fail-under", "0.99999"], { env });
    expect(fail.code).toBe(EXIT.gate);
    expect(fail.stderr).toContain("under --fail-under");
  });

  it("exits 10 when --expect doesn't win", async () => {
    await keySaved();
    wity.reply(fixture("choice"));
    const res = await run(
      ["choice", "Team?", "-o", "billing", "-o", "technical", "-o", "other", "--text", "x", "--expect", "technical"],
      {
        env,
      },
    );
    expect(res.code).toBe(EXIT.gate);
  });

  it("checks --expect before sending anything", async () => {
    await keySaved();
    const before = wity.seen.length;
    const res = await run(["choice", "Team?", "-o", "a", "-o", "b", "--text", "x", "--expect", "c"], { env });
    expect(res.code).toBe(EXIT.usage);
    expect(wity.seen).toHaveLength(before);
  });

  it("maps a refused key to exit 3 with advice", async () => {
    const res = await run(["noul", "Urgent?", "--text", "x"], { env: { ...env, WITY_API_KEY: BAD_KEY } });
    expect(res.code).toBe(EXIT.auth);
    expect(res.stderr).toContain("WITY_API_KEY");
  });

  it("maps Wity's 400 to exit 2 and says nothing was billed", async () => {
    await keySaved();
    wity.reply(fixture("error-one-score-level"));
    const res = await run(["noul", "Urgent?", "--text", "x"], { env });
    expect(res.code).toBe(EXIT.usage);
    expect(res.stderr).toContain("Nothing was billed.");
  });

  it("needs no key for --dry-run, and sends nothing", async () => {
    const res = await run(["noul", "Urgent?", "--text", "x", "--dry-run"], { env });
    expect(res.code).toBe(EXIT.ok);
    expect(JSON.parse(res.stdout).questions.answer.type).toBe("noul");
    expect(wity.seen).toHaveLength(0);
  });

  it("exits 3 with advice when there's no key", async () => {
    const res = await run(["noul", "Urgent?", "--text", "x"], { env });
    expect(res.code).toBe(EXIT.auth);
    expect(res.stderr).toContain("wity api-key set");
  });

  it("checks limits before sending", async () => {
    await keySaved();
    const before = wity.seen.length;
    const cases = [
      ["noul", "Q?", "--text", "x", "--max-latency", "50"],
      ["noul", "Q?", "--text", "x", "--fail-under", "2"],
      ["noul", "Q?", "--text", "x", "--if-yes", "only one side"],
      ["noul", "Q?", "--text", "x".repeat(32_001)],
      ["score", "Q?", "-l", "only one", "--text", "x"],
      ["choice", "Q?", "-o", "a", "-o", "a=again", "--text", "x"],
      ["noul", "Q?", "--text", "x", "--file", "also.txt"],
    ];
    for (const args of cases) expect((await run(args, { env })).code, args.join(" ")).toBe(EXIT.usage);
    expect(wity.seen).toHaveLength(before);
  });
});

describe("help and errors", () => {
  it("prints help and exits 0 with no command", async () => {
    const res = await run([], { env });
    expect(res.code).toBe(EXIT.ok);
    expect(res.stdout).toContain("Usage: wity");
  });

  it("prints help with `wity help`, and a command's help with `wity help <command>`", async () => {
    const all = await run(["help"], { env });
    expect(all.code).toBe(EXIT.ok);
    expect(all.stdout).toContain("Usage: wity");
    expect(all.stdout).toContain("help [command]");

    // --base-url still works (other tests use it) but isn't advertised.
    expect(all.stdout).not.toContain("--base-url");

    const one = await run(["help", "noul"], { env });
    expect(one.code).toBe(EXIT.ok);
    expect(one.stdout).toContain("Usage: wity noul");
    expect(one.stdout).toContain("--fail-under");
  });

  it("lists the API key commands with `wity api-key`", async () => {
    const res = await run(["api-key"], { env });
    expect(res.code).toBe(EXIT.ok);
    expect(res.stdout).toMatch(/set[\s\S]*show[\s\S]*remove/);
  });

  it("never prints a key in commander's own errors", async () => {
    for (const args of [
      [GOOD_KEY],
      ["noul", "Q?", `--api-key=${GOOD_KEY}`],
      ["noul", "Q?", GOOD_KEY],
      ["noul", "Q?", "--reasoning", GOOD_KEY],
      ["mcp", GOOD_KEY],
    ]) {
      const res = await run(args, { env });
      expect(res.code, args.join(" ")).toBe(EXIT.usage);
      expect(res.stderr, args.join(" ")).toContain("error:");
      expectNoKey(res.stdout, res.stderr);
    }
    expect(wity.seen).toHaveLength(0);
  });

  it("exits 2 on an unknown command", async () => {
    const res = await run(["nope"], { env });
    expect(res.code).toBe(EXIT.usage);
  });
});
