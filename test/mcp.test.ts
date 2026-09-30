// The MCP server, through a real MCP client over the SDK's in-memory transport, against the fake Wity server.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCtx } from "../src/context.ts";
import type { FoundKey } from "../src/credentials.ts";
import { createMcpServer } from "../src/mcp.ts";
import { fakeWity, fixture, GOOD_KEY } from "./helpers.ts";

let wity: Awaited<ReturnType<typeof fakeWity>>;

beforeEach(async () => {
  wity = await fakeWity();
});

afterEach(async () => {
  await wity.close();
});

const connect = async (opts: { maxSpendUsd?: number; key?: string } = {}) => {
  let stdout = "";
  const io = {
    env: { WITY_BASE_URL: wity.url },
    stdin: process.stdin,
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: () => true },
    signal: new AbortController().signal,
  };
  const found: FoundKey = { key: opts.key ?? GOOD_KEY, source: "file", location: "test" };
  const server = createMcpServer(makeCtx(io, undefined), found, { maxSpendUsd: opts.maxSpendUsd });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: res.isError ?? false, text: res.content[0]?.text ?? "" };
  };
  return { client, call, stdout: () => stdout };
};

describe("mcp", () => {
  it("lists the five tools, all marked read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "wity_ask",
      "wity_choice",
      "wity_generate",
      "wity_noul",
      "wity_score",
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    // No tool takes a key, or can set or remove one.
    expect(JSON.stringify(tools)).not.toMatch(/api_key|apiKey|login|logout/i);
  });

  it("answers a noul question with a summary and the full response", async () => {
    const { call } = await connect();
    const res = await call("wity_noul", { text: "Refund me today", question: "Is it urgent?", reasoning: "off" });
    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/^answer: yes 99\.99% · 123 input tokens/);
    expect(res.text).toContain("aren't calibrated odds");
    expect(JSON.parse(res.text.split("\n\n")[1] ?? "").answers.answer.noul).toBeCloseTo(0.99988, 4);
    expect(wity.seen.at(-1)?.body).toEqual({
      state: "Refund me today",
      questions: { answer: { type: "noul", instructions: "Is it urgent?" } },
      reasoning: "off",
    });
    expect(res.text).not.toContain(GOOD_KEY);
  });

  it("sends choice options and score levels in the API's shape", async () => {
    const { call } = await connect();
    wity.reply(fixture("choice"));
    const choice = await call("wity_choice", {
      text: "Charged twice",
      question: "Which team?",
      options: { billing: "Payments", technical: "Bugs", other: "Anything else" },
    });
    expect(choice.text).toMatch(/^answer: billing \(>99\.99%\)/);

    wity.reply(fixture("score"));
    await call("wity_score", { text: "x", question: "How upset?", levels: ["Calm", "Annoyed", "Angry"] });
    expect(wity.seen.at(-1)?.body).toMatchObject({
      questions: { answer: { type: "score", criteria: ["Calm", "Annoyed", "Angry"] } },
    });
  });

  it("asks several questions at once", async () => {
    const { call } = await connect();
    wity.reply(fixture("multi-auto"));
    const res = await call("wity_ask", {
      text: "Charged twice, refund today",
      questions: {
        team: {
          type: "choice",
          instructions: "Which team?",
          criteria: { billing: "Payments", technical: "Bugs", other: "Else" },
        },
        urgent: { type: "noul", instructions: "Urgent?" },
      },
    });
    expect(res.text).toMatch(/^team: billing .* · urgent: yes/);
  });

  it("rejects bad input before calling Wity", async () => {
    const { call } = await connect();
    const res = await call("wity_choice", { text: "x", question: "Q?", options: { only: "one" } });
    expect(res.isError).toBe(true);
    expect(wity.seen).toHaveLength(0);
  });

  it("turns a refused key into a tool error, without the key", async () => {
    const { call } = await connect({ key: "wity_revoked_000000000000000000000000000000000" });
    const res = await call("wity_noul", { text: "x", question: "Q?" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Wity refused the API key.");
    expect(res.text).not.toContain("wity_revoked");
  });

  it("stops paid calls at --max-spend", async () => {
    // 123 input tokens cost $0.000005166. A cap of $0.00001 allows two calls.
    const { call } = await connect({ maxSpendUsd: 0.00001 });
    expect((await call("wity_noul", { text: "x", question: "Q?" })).isError).toBe(false);
    expect((await call("wity_noul", { text: "x", question: "Q?" })).isError).toBe(false);
    const third = await call("wity_noul", { text: "x", question: "Q?" });
    expect(third.isError).toBe(true);
    expect(third.text).toContain("spending cap");
    expect(wity.seen.filter((r) => r.path === "/v1/systemone")).toHaveLength(2);
  });

  it("generates text", async () => {
    const { call } = await connect();
    const res = await call("wity_generate", { instructions: "Reply", text: "Charged twice" });
    expect(res.text).toMatch(/^Wrote \d+ tokens/);
  });

  it("never writes to stdout itself", async () => {
    const { call, stdout } = await connect();
    await call("wity_noul", { text: "x", question: "Q?" });
    expect(stdout()).toBe("");
  });
});
