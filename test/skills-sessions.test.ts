// `wity skills` and `wity sessions`, against the fake Wity server.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.ts";
import { fakeWity, fixture, GOOD_KEY, run, tempConfig } from "./helpers.ts";
import { decision, emailSkill, eventLog, examplesReply, notFound, session, skillList, urgentSkill } from "./replies.ts";

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

const last = () => wity.seen.at(-1);

describe("skills", () => {
  it("lists skills in a table, and as JSON when piped", async () => {
    wity.on("GET /v1/skills", { status: 200, body: skillList });
    const res = await run(["skills", "list", "--limit", "5"], { env, stdoutTTY: true });
    expect(res.code).toBe(EXIT.ok);
    expect(last()?.path).toBe("/v1/skills?limit=5");
    const text = plain(res.stdout);
    expect(text).toMatch(/name +kind +status +examples/);
    expect(text).toMatch(/urgent-ticket +decision +ready +12 +3 +examples +Does this ticket need/);
    expect(text).toMatch(/email-thread +split .* one item per email/);
    const piped = await run(["skills", "list"], { env });
    expect(JSON.parse(piped.stdout).data).toHaveLength(2);
    expect((await run(["skills", "list", "--limit", "500"], { env })).code).toBe(EXIT.usage);
  });

  it("shows one skill with its quality", async () => {
    wity.on("GET /v1/skills/urgent-ticket", { status: 200, body: urgentSkill });
    const res = await run(["skills", "show", "urgent-ticket"], { env, stdoutTTY: true });
    const text = plain(res.stdout);
    expect(text).toContain("decision · noul");
    expect(text).toContain("ready · 12 examples · version 3");
    expect(text).toContain("92.00% right, 75.00% without the skill, on 4 held-back examples");
  });

  it("makes a decision skill from a file", async () => {
    wity.on("POST /v1/skills", {
      status: 200,
      body: { ...urgentSkill, usage: { input_tokens: 80, output_tokens: 0 } },
    });
    const file = write(
      "skill.yaml",
      `name: urgent-ticket
question:
  type: noul
  instructions: Does this ticket need a reply within the hour?
examples:
  - {state: Checkout is down for every customer., answer: yes}
  - {state: Can you change my invoice address?, answer: no}
`,
    );
    const res = await run(["skills", "add", file], { env, stdoutTTY: true });
    expect(res.code).toBe(EXIT.ok);
    expect(last()?.body).toMatchObject({ name: "urgent-ticket", question: { type: "noul" } });
    expect(last()?.body).toHaveProperty("examples.length", 2);
    const text = plain(res.stdout);
    expect(text).toContain("Made the decision skill urgent-ticket");
    expect(text).toContain("80 input tokens for the examples");
    expect(text).toContain('wity skills try urgent-ticket --text "..."');
  });

  it("makes a split skill from a file", async () => {
    wity.on("POST /v1/skills", { status: 200, body: { ...emailSkill, usage: { input_tokens: 0, output_tokens: 0 } } });
    const file = write("split.yaml", "name: email-thread\nsplit: {unit: email, starts_at: ['a From: line']}\n");
    const res = await run(["skills", "add", file], { env, stdoutTTY: true });
    expect(last()?.body).toEqual({ name: "email-thread", split: { unit: "email", starts_at: ["a From: line"] } });
    expect(plain(res.stdout)).toContain("wity split --skill email-thread");
  });

  it("lists every problem in a skill file, and sends nothing", async () => {
    const before = wity.seen.length;
    const bad = write("bad.yaml", "name: ''\nquestion: {type: score, instructions: x, criteria: [a, b]}\n");
    const res = await run(["skills", "add", bad], { env });
    expect(res.code).toBe(EXIT.usage);
    expect(res.stderr).toContain("name: can't be empty");
    expect(res.stderr).toContain("question.type");
    const both = write("both.yaml", "name: x\nquestion: {type: noul, instructions: x}\nsplit: one per line\n");
    expect((await run(["skills", "add", both], { env })).stderr).toContain("a question or a split, not both");
    expect(wity.seen).toHaveLength(before);
  });

  it("says when a name is taken", async () => {
    wity.on("POST /v1/skills", { status: 409, body: { error: "a skill named 'urgent-ticket' already exists" } });
    const file = write("s.yaml", "name: urgent-ticket\nquestion: {type: noul, instructions: Urgent?}\n");
    const res = await run(["skills", "add", file], { env });
    expect(res.code).toBe(EXIT.usage);
    expect(res.stderr).toContain("That name is taken: a skill named 'urgent-ticket' already exists.");
  });

  it("edits with flags and a file, flags winning, as a PATCH", async () => {
    wity.on("PATCH /v1/skills/urgent-ticket", { status: 200, body: { ...urgentSkill, version: 4 } });
    const file = write("changes.yaml", "description: from the file\nparts: null\n");
    const res = await run(["skills", "edit", "urgent-ticket", file, "--description", "from the flag"], { env });
    expect(res.code).toBe(EXIT.ok);
    expect(last()?.method).toBe("PATCH");
    expect(last()?.body).toEqual({ description: "from the flag", parts: null });
    expect((await run(["skills", "edit", "urgent-ticket"], { env })).code).toBe(EXIT.usage);
  });

  it("deletes only with --yes when there's no terminal", async () => {
    wity.on("DELETE /v1/skills/urgent-ticket", {
      status: 200,
      body: { id: "sk_4f1c9e", object: "skill", deleted: true },
    });
    const refused = await run(["skills", "delete", "urgent-ticket"], { env });
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.stderr).toContain("needs --yes");
    expect(wity.seen.some((r) => r.method === "DELETE")).toBe(false);
    const res = await run(["skills", "delete", "urgent-ticket", "--yes"], { env });
    expect(res.code).toBe(EXIT.ok);
    expect(last()?.method).toBe("DELETE");
  });

  it("asks before deleting on a terminal", async () => {
    wity.on("DELETE /v1/skills/urgent-ticket", {
      status: 200,
      body: { id: "sk_4f1c9e", object: "skill", deleted: true },
    });
    const no = await run(["skills", "delete", "urgent-ticket"], { env, tty: { keys: ["n\n"] } });
    expect(no.code).toBe(EXIT.cancelled);
    expect(no.stderr).toContain("Delete the skill urgent-ticket and all its examples? This can't be undone. [y/N]");
    expect(no.stderr).toContain("Nothing was deleted.");
    expect(wity.seen.some((r) => r.method === "DELETE")).toBe(false);
    const yes = await run(["skills", "delete", "urgent-ticket"], { env, tty: { keys: ["y\n"] } });
    expect(yes.code).toBe(EXIT.ok);
    expect(last()?.method).toBe("DELETE");
  });

  it("adds, lists and deletes examples", async () => {
    wity.on("POST /v1/skills/urgent-ticket/examples", { status: 200, body: examplesReply });
    const list = write("examples.yaml", "- {state: Checkout is down for every customer., answer: yes}\n");
    const added = await run(["skills", "examples", "add", "urgent-ticket", list], { env, stdoutTTY: true });
    expect(last()?.body).toEqual({ examples: [{ state: "Checkout is down for every customer.", answer: "yes" }] });
    expect(plain(added.stdout)).toContain("Added 1 example to urgent-ticket");
    expect(plain(added.stdout)).toContain("13 examples now · learning");

    // A skill file's examples work too.
    const inFile = write("in-file.yaml", "examples:\n  - {state: x, answer: no}\n");
    await run(["skills", "examples", "add", "urgent-ticket", inFile], { env });
    expect(last()?.body).toEqual({ examples: [{ state: "x", answer: "no" }] });
    expect((await run(["skills", "examples", "add", "urgent-ticket", write("e.yaml", "[]")], { env })).code).toBe(
      EXIT.usage,
    );

    wity.on("GET /v1/skills/urgent-ticket/examples", {
      status: 200,
      body: { object: "list", data: examplesReply.data, has_more: false },
    });
    const listed = await run(["skills", "examples", "list", "urgent-ticket"], { env, stdoutTTY: true });
    expect(plain(listed.stdout)).toMatch(/ex_1 +yes +api +Checkout is down/);

    wity.on("DELETE /v1/skills/urgent-ticket/examples/ex_1", {
      status: 200,
      body: { id: "ex_1", object: "skill.example", deleted: true },
    });
    expect((await run(["skills", "examples", "delete", "urgent-ticket", "ex_1"], { env })).code).toBe(EXIT.usage);
    expect((await run(["skills", "examples", "delete", "urgent-ticket", "ex_1", "-y"], { env })).code).toBe(EXIT.ok);
  });

  it("tries a skill with systemOne and a skill question", async () => {
    wity.reply({
      status: 200,
      body: { ...fixture("noul").body, answers: { answer: decision.answers["urgent-ticket"] } },
    });
    const res = await run(["skills", "try", "urgent-ticket", "--text", "Checkout is down"], { env, stdoutTTY: true });
    expect(res.code).toBe(EXIT.ok);
    expect(last()?.body).toEqual({ state: "Checkout is down", questions: { answer: { skill: "urgent-ticket" } } });
    const text = plain(res.stdout);
    expect(text).toContain("skill urgent-ticket");
    expect(text).toContain("97.00%");
    expect(text).toContain("skill urgent-ticket · version 3 · answered by examples");

    const field = await run(["skills", "try", "urgent-ticket", "-t", "x", "--field", "skill.version"], { env });
    expect(field.stdout).toBe("3\n");
  });

  it("names a missing skill in plain words", async () => {
    wity.on("GET /v1/skills/nope", notFound("no skill 'nope'"));
    const res = await run(["skills", "show", "nope"], { env });
    expect(res.code).toBe(EXIT.usage);
    expect(res.stderr).toContain("Not found: no skill 'nope'.");
  });

  it("tells a wrong API address apart from a missing skill", async () => {
    // The fake server answers unknown routes with a plain 404, like a wrong address would.
    const res = await run(["skills", "show", "anything"], { env });
    expect(res.code).toBe(EXIT.error);
    expect(res.stderr).toContain("The API address may have changed.");
  });
});

describe("sessions", () => {
  it("starts a session with a state, skills and an expiry", async () => {
    wity.on("POST /v1/sessions", { status: 200, body: session });
    const res = await run(
      [
        "sessions",
        "add",
        "--text",
        "Ticket #5120",
        "--skill",
        "urgent-ticket",
        "--skill",
        "team",
        "--expires-in",
        "12h",
      ],
      { env, stdoutTTY: true },
    );
    expect(res.code).toBe(EXIT.ok);
    expect(last()?.body).toEqual({ state: "Ticket #5120", skills: ["urgent-ticket", "team"], expires_in: 43_200 });
    expect(plain(res.stdout)).toContain("Started the session ses_9a41c0");
    expect(plain(res.stdout)).toContain("1 skill · expires");
    expect(plain(res.stdout)).toContain('wity sessions event ses_9a41c0 --update "..."');
  });

  it("starts an empty session, and checks --expires-in", async () => {
    wity.on("POST /v1/sessions", { status: 200, body: session });
    await run(["sessions", "add"], { env });
    expect(last()?.body).toEqual({});
    const before = wity.seen.length;
    for (const bad of ["30", "91d", "soon"]) {
      expect((await run(["sessions", "add", "--expires-in", bad], { env })).code).toBe(EXIT.usage);
    }
    expect(wity.seen).toHaveLength(before);
  });

  it("lists and shows sessions", async () => {
    wity.on("GET /v1/sessions", { status: 200, body: { object: "list", data: [session], has_more: true } });
    const list = await run(["sessions", "list"], { env, stdoutTTY: true });
    expect(plain(list.stdout)).toMatch(/ses_9a41c0 +1 +0 +2026-/);
    expect(plain(list.stdout)).toContain("More with --after ses_9a41c0");

    wity.on("GET /v1/sessions/ses_9a41c0", { status: 200, body: session });
    const show = await run(["sessions", "show", "ses_9a41c0"], { env, stdoutTTY: true });
    expect(plain(show.stdout)).toMatch(/state\n\s+Ticket #5120 from Northwind Foods\./);
  });

  it("edits skills and expiry", async () => {
    wity.on("PATCH /v1/sessions/ses_9a41c0", { status: 200, body: session });
    await run(["sessions", "edit", "ses_9a41c0", "--skill", "urgent-ticket", "--expires-in", "30d"], { env });
    expect(last()?.body).toEqual({ skills: ["urgent-ticket"], expires_in: 2_592_000 });
    expect((await run(["sessions", "edit", "ses_9a41c0"], { env })).code).toBe(EXIT.usage);
  });

  it("adds one event at a time", async () => {
    wity.on("POST /v1/sessions/ses_9a41c0/events", {
      status: 200,
      body: { object: "list", data: [], session: { ...session, events: 1 } },
    });
    const update = await run(["sessions", "event", "ses_9a41c0", "--update", "Checkout still fails"], {
      env,
      stdoutTTY: true,
    });
    expect(last()?.body).toEqual({ events: [{ type: "update", content: "Checkout still fails" }] });
    expect(plain(update.stdout)).toContain("Added the update. 1 events in ses_9a41c0");

    await run(["sessions", "event", "ses_9a41c0", "--state", ""], { env });
    expect(last()?.body).toEqual({ events: [{ type: "state", content: "" }] });

    await run(["sessions", "event", "ses_9a41c0", "--feedback", "ev_3", "--answer", "no", "--question", "urgent"], {
      env,
    });
    expect(last()?.body).toEqual({
      events: [{ type: "feedback", decision_id: "ev_3", answer: "no", question: "urgent" }],
    });

    const before = wity.seen.length;
    for (const bad of [
      [],
      ["--update", "a", "--note", "b"],
      ["--note", " "],
      ["--feedback", "ev_3"],
      ["--update", "a", "--answer", "no"],
    ]) {
      expect((await run(["sessions", "event", "ses_9a41c0", ...bad], { env })).code, bad.join(" ")).toBe(EXIT.usage);
    }
    expect(wity.seen).toHaveLength(before);
  });

  it("decides with the session's skills", async () => {
    wity.on("POST /v1/sessions/ses_9a41c0/decide", { status: 200, body: decision });
    const res = await run(["sessions", "decide", "ses_9a41c0", "--remember"], { env, stdoutTTY: true });
    expect(res.code).toBe(EXIT.ok);
    expect(last()?.body).toEqual({ remember: true });
    const text = plain(res.stdout);
    expect(text).toContain("urgent-ticket  skill urgent-ticket");
    expect(text).toContain("decision ev_3 · read 2 updates");
    expect(text).toContain("wity sessions event ses_9a41c0 --feedback ev_3 --answer <right answer>");
  });

  it("decides with a questions file, and says when the answer is a repeat", async () => {
    wity.on("POST /v1/sessions/ses_9a41c0/decide", {
      status: 200,
      body: {
        ...decision,
        answers: { urgent: { type: "noul", noul: 0.2 } },
        cached: true,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    const file = write("q.yaml", "questions:\n  urgent: {type: noul, instructions: Is it urgent?}\nreasoning: auto\n");
    const res = await run(["sessions", "decide", "ses_9a41c0", file, "-r", "always"], { env, stdoutTTY: true });
    expect(last()?.body).toEqual({
      questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
      reasoning: "always",
    });
    expect(plain(res.stdout)).toContain("same answer, 0 tokens");

    const withState = write("s.yaml", "state: x\nquestions:\n  u: {skill: urgent-ticket}\n");
    expect((await run(["sessions", "decide", "ses_9a41c0", withState], { env })).code).toBe(EXIT.usage);
  });

  it("shows the log in plain words", async () => {
    wity.on("GET /v1/sessions/ses_9a41c0/events", { status: 200, body: eventLog });
    const res = await run(["sessions", "log", "ses_9a41c0"], { env, stdoutTTY: true });
    const text = plain(res.stdout);
    expect(text).toMatch(/update +ev_1 +Customer: checkout still fails\./);
    expect(text).toMatch(/decision +ev_3 +urgent-ticket: yes 97\.00%\n/);
    expect(text).toMatch(/feedback +ev_4 +ev_3 → urgent-ticket: no/);
  });

  it("deletes only with --yes when there's no terminal", async () => {
    wity.on("DELETE /v1/sessions/ses_9a41c0", {
      status: 200,
      body: { id: "ses_9a41c0", object: "session", deleted: true },
    });
    expect((await run(["sessions", "delete", "ses_9a41c0"], { env })).code).toBe(EXIT.usage);
    expect((await run(["sessions", "delete", "ses_9a41c0", "--yes"], { env })).code).toBe(EXIT.ok);
  });
});

describe("ask with skill questions", () => {
  const QUESTIONS = `
questions:
  urgent: {skill: urgent-ticket}
  team:
    type: choice
    instructions: Which team?
    criteria: {billing: Payments, technical: Bugs}
`;

  it("sends { skill } questions and draws them", async () => {
    wity.reply({
      status: 200,
      body: { ...fixture("noul").body, answers: { urgent: decision.answers["urgent-ticket"] } },
    });
    const file = write("q.yaml", QUESTIONS);
    const res = await run(["ask", file, "--text", "x"], { env, stdoutTTY: true });
    expect(res.code).toBe(EXIT.ok);
    expect(last()?.body).toMatchObject({ questions: { urgent: { skill: "urgent-ticket" } } });
    expect(plain(res.stdout)).toContain("urgent  skill urgent-ticket");
  });

  it("refuses a question with both skill and type", async () => {
    const file = write("bad.yaml", "questions:\n  u: {skill: x, type: noul, instructions: y}\n");
    const res = await run(["ask", file, "--text", "x"], { env });
    expect(res.code).toBe(EXIT.usage);
    expect(res.stderr).toContain('Unrecognized key: "skill"');
  });

  it("writes code with skill()", async () => {
    const res = await run(["ask", write("q.yaml", QUESTIONS), "--text", "x", "--code", "ts"], { env });
    expect(res.stdout).toContain('import { WityClient, choice, skill } from "wity-sdk";');
    expect(res.stdout).toContain('urgent: skill("urgent-ticket"),');
    expect(res.stdout).toContain("console.log(res.answers.urgent);");
  });
});
