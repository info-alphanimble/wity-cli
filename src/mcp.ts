// wity mcp serve: Wity's questions as MCP tools, for AI agents like Claude Code, Claude Desktop or Cursor.
//
// - It speaks MCP over stdin and stdout only. It opens no network port.
// - stdout carries MCP messages and nothing else. Logs and notices go to stderr.
// - It uses the saved key (or WITY_API_KEY). The key is never a tool input or part of any tool output,
//   and no tool can set, show or remove keys.
// - `--max-spend` stops paid calls after a set amount per session, in case an agent gets stuck in a loop.

import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { GenerateRequest, Reasoning, SystemOneRequest, SystemOneResponse } from "wity";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { explain, makeClient } from "./api.ts";
import { PRICE_PER_MILLION_INPUT_USD } from "./config.ts";
import type { Ctx } from "./context.ts";
import type { FoundKey } from "./credentials.ts";
import { CliError, EXIT, type ExitCode } from "./exit.ts";
import { MAX_STATE_CHARS } from "./input.ts";
import { clean, cost, pct } from "./output.ts";
import { checkStateLength, questionSchema } from "./schema.ts";
import { requireKey } from "./send.ts";

const UNCALIBRATED = "Probabilities rank how sure Wity is. They aren't calibrated odds.";

const text = z
  .string()
  .min(1)
  .max(MAX_STATE_CHARS)
  .describe("The text to judge: an email, a ticket, a diff, a document…");
const reasoning = z
  .enum(["off", "auto", "always"])
  .optional()
  .describe("off is fastest. auto (the default) thinks only when a question needs it. always thinks first.");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const done = (summary: string, data: unknown): ToolResult => ({
  content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data)}` }],
});

const failed = (err: unknown): ToolResult => {
  const message = err instanceof CliError ? [err.message, err.hint].filter(Boolean).join(" ") : "Something went wrong.";
  return { isError: true, content: [{ type: "text", text: message }] };
};

const usage = (res: { usage: { input_tokens: number } }) =>
  `${res.usage.input_tokens.toLocaleString("en")} input tokens ≈ ${cost(res.usage.input_tokens)}`;

/** One line about an answer, for the agent to read before the JSON. */
const summarize = (res: SystemOneResponse): string =>
  Object.entries(res.answers)
    .map(([name, answer]) => {
      if (answer.type === "noul") return `${name}: yes ${pct(answer.noul)}`;
      if (answer.type === "score") return `${name}: score ${answer.score.toFixed(2)}`;
      return `${name}: ${clean(answer.choice)} (${pct(answer.probabilities[answer.choice] ?? 0)})`;
    })
    .join(" · ");

export const createMcpServer = (ctx: Ctx, found: FoundKey, opts: { maxSpendUsd?: number }): McpServer => {
  const server = new McpServer({ name: "wity", version: pkg.version });
  const client = makeClient(found.key, ctx.baseURL, ctx.io);
  let spentTokens = 0;

  /** Refuse once the session has spent --max-spend. Checked before each paid call. */
  const guard = () => {
    const spent = (spentTokens * PRICE_PER_MILLION_INPUT_USD) / 1_000_000;
    if (opts.maxSpendUsd !== undefined && spent >= opts.maxSpendUsd) {
      throw new CliError(
        `This session reached its spending cap of $${opts.maxSpendUsd}.`,
        EXIT.error,
        "Restart the MCP server to reset it, or raise --max-spend.",
      );
    }
  };

  const systemOne = async (request: SystemOneRequest): Promise<ToolResult> => {
    try {
      guard();
      checkStateLength(request.state);
      const res = await client.systemOne(request, { signal: ctx.io.signal });
      spentTokens += res.usage.input_tokens;
      return done(`${summarize(res)} · ${usage(res)}. ${UNCALIBRATED}`, res);
    } catch (err) {
      return failed(err instanceof CliError ? err : explain(err, found));
    }
  };

  const request = (
    state: string,
    question: SystemOneRequest["questions"][string],
    mode?: Reasoning,
  ): SystemOneRequest => ({
    state,
    questions: { answer: question },
    ...(mode && { reasoning: mode }),
  });

  const readOnly = { readOnlyHint: true, openWorldHint: true };

  server.registerTool(
    "wity_noul",
    {
      title: "Yes or no, with a probability",
      description: `Ask Wity a yes-or-no question about a text. Returns the probability of yes, from 0 to 1. ${UNCALIBRATED} Billed per input token (a few hundred tokens cost well under a cent).`,
      inputSchema: {
        text,
        question: z.string().min(1).describe("A yes-or-no question, like 'Is this email a phishing attempt?'"),
        yes_means: z.string().min(1).optional().describe("What yes means. Give no_means too."),
        no_means: z.string().min(1).optional().describe("What no means. Give yes_means too."),
        reasoning,
      },
      annotations: readOnly,
    },
    async ({ text: state, question, yes_means, no_means, reasoning: mode }) => {
      if ((yes_means === undefined) !== (no_means === undefined)) {
        return failed(new CliError("Give both yes_means and no_means, or neither.", EXIT.usage));
      }
      const criteria = yes_means && no_means ? { true: yes_means, false: no_means } : undefined;
      return systemOne(request(state, { type: "noul", instructions: question, ...(criteria && { criteria }) }, mode));
    },
  );

  server.registerTool(
    "wity_choice",
    {
      title: "Pick one option, with probabilities",
      description: `Ask Wity to pick one of 2 to 256 options for a text, like routing a ticket or labelling an email. Returns the winner and a probability for every option. ${UNCALIBRATED}`,
      inputSchema: {
        text,
        question: z.string().min(1).describe("What to decide, like 'Which team should handle this ticket?'"),
        options: z
          .record(z.string().min(1), z.string())
          .refine((o) => Object.keys(o).length >= 2 && Object.keys(o).length <= 256, "needs 2 to 256 options")
          .describe('Option ids mapped to what each one means, like {"billing": "Payments and refunds"}.'),
        reasoning,
      },
      annotations: readOnly,
    },
    async ({ text: state, question, options, reasoning: mode }) =>
      systemOne(request(state, { type: "choice", instructions: question, criteria: options }, mode)),
  );

  server.registerTool(
    "wity_score",
    {
      title: "Place a text on a scale",
      description: `Ask Wity to place a text on a scale of 2 to 10 levels, lowest first. Returns the expected level (it can fall between levels) and a probability per level. ${UNCALIBRATED}`,
      inputSchema: {
        text,
        question: z.string().min(1).describe("What to rate, like 'How upset is the customer?'"),
        levels: z
          .array(z.string().min(1))
          .min(2)
          .max(10)
          .describe("The levels, lowest first, like ['Calm', 'Annoyed', 'Angry']."),
        reasoning,
      },
      annotations: readOnly,
    },
    async ({ text: state, question, levels, reasoning: mode }) =>
      systemOne(request(state, { type: "score", instructions: question, criteria: levels }, mode)),
  );

  server.registerTool(
    "wity_ask",
    {
      title: "Several questions in one call",
      description: `Ask Wity several named questions about one text in one call. Each question is {type: "noul" | "choice" | "score", instructions, criteria}. criteria is {true, false} descriptions (optional) for noul, an object of option ids to descriptions for choice, and a list of levels (lowest first) for score. ${UNCALIBRATED}`,
      inputSchema: {
        text,
        questions: z
          .record(z.string().min(1).max(64), questionSchema)
          .describe("Questions by name. Answers come back under the same names."),
        reasoning,
      },
      annotations: readOnly,
    },
    async ({ text: state, questions, reasoning: mode }) => {
      if (Object.keys(questions).length === 0) return failed(new CliError("Give at least one question.", EXIT.usage));
      return systemOne({ state, questions, ...(mode && { reasoning: mode }) });
    },
  );

  server.registerTool(
    "wity_generate",
    {
      title: "Write short text or JSON",
      description:
        "Ask Wity to write short text from a text (up to 512 tokens), like a one-line reply or a value read off a document. With a JSON Schema shape, the output matches it. Check generated text before acting on it: it can say things that aren't in the input. If the answer is one of a known set, use wity_choice instead.",
      inputSchema: {
        instructions: z.string().min(1).describe("What to write, like 'The one-line reply to send to this customer'."),
        text: text.optional(),
        shape: z.record(z.string(), z.unknown()).optional().describe('A JSON Schema with "type": "object" at the top.'),
        max_tokens: z.number().int().min(1).max(512).optional().describe("The most tokens to write. Default 128."),
      },
      annotations: readOnly,
    },
    async ({ instructions, text: state, shape, max_tokens }) => {
      try {
        guard();
        if (shape && shape.type !== "object")
          throw new CliError('The shape needs "type": "object" at the top.', EXIT.usage);
        const req: GenerateRequest = {
          instructions,
          ...(state !== undefined && { state }),
          ...(shape && { shape }),
          ...(max_tokens !== undefined && { max_tokens }),
        };
        const res = await client.generate(req, { signal: ctx.io.signal });
        spentTokens += res.usage.input_tokens;
        const cut = res.finish_reason === "length" ? " Cut off at max_tokens: raise it for the rest." : "";
        return done(`Wrote ${res.usage.output_tokens} tokens · ${usage(res)}.${cut}`, res);
      } catch (err) {
        return failed(err instanceof CliError ? err : explain(err, found));
      }
    },
  );

  return server;
};

export const serveMcp = async (ctx: Ctx, opts: { maxSpend?: number }): Promise<ExitCode> => {
  const { io } = ctx;
  if (opts.maxSpend !== undefined && !(opts.maxSpend > 0))
    throw new CliError("--max-spend is a dollar amount above 0.", EXIT.usage);
  const found = await requireKey(ctx);
  if (io.stdin.isTTY) {
    io.stderr.write(
      "wity mcp serve talks MCP over stdin and stdout, so an AI app should start it.\n" +
        "For example: claude mcp add wity -- wity mcp serve\n" +
        "Waiting for MCP messages. Press Ctrl+C to stop.\n",
    );
  }

  const server = createMcpServer(ctx, found, { maxSpendUsd: opts.maxSpend });
  const transport = new StdioServerTransport(io.stdin as unknown as Readable, io.stdout as unknown as Writable);
  await server.connect(transport);
  // Stop when the app closes our stdin, or on Ctrl+C.
  await new Promise<void>((resolve) => {
    io.stdin.once("end", resolve);
    io.stdin.once("close", resolve);
    io.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await server.close();
  return EXIT.ok;
};
