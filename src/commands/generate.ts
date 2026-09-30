// wity generate: short text, or JSON in a shape you define.

import type { GenerateRequest, GenerateResponse } from "wity-sdk";
import { codeLangs, curl, generateTs, printCode } from "../code.ts";
import type { Ctx } from "../context.ts";
import { CliError, EXIT, type ExitCode } from "../exit.ts";
import { readState, readStdin, type StateFlags } from "../input.ts";
import { clean, cleanBlock, cost, ms, type Paint, writeJson } from "../output.ts";
import { checkStateLength } from "../schema.ts";
import { sendGenerate } from "../send.ts";
import { readDataFile } from "./ask.ts";

export interface GenerateFlags extends StateFlags {
  shape?: string;
  maxTokens?: number;
  json?: boolean;
  dryRun?: boolean;
  code?: string | boolean;
}

/** State is optional here: some instructions need no input. Empty stdin means none. */
const readOptionalState = async (flags: StateFlags, ctx: Ctx): Promise<string | undefined> => {
  if (flags.text !== undefined || flags.file !== undefined) return readState(flags, ctx.io);
  if (ctx.io.stdin.isTTY) return undefined;
  const piped = await readStdin(ctx.io.stdin);
  if (piped.trim() === "") return undefined;
  checkStateLength(piped);
  return piped;
};

const footer = (res: GenerateResponse, totalMs: number, paint: Paint): string =>
  `  ${paint(
    "dim",
    [
      clean(res.model),
      `${ms(res.metadata.elapsed_ms)} on Wity`,
      `${ms(totalMs)} total`,
      `${res.usage.input_tokens.toLocaleString("en")} input tokens`,
      `${res.usage.output_tokens.toLocaleString("en")} written (free)`,
      `≈ ${cost(res.usage.input_tokens)}`,
    ].join(" · "),
  )}`;

export const generate = async (ctx: Ctx, instructions: string, flags: GenerateFlags): Promise<ExitCode> => {
  const { io } = ctx;
  if (instructions.trim() === "") throw new CliError("The instructions are empty.", EXIT.usage);
  if (
    flags.maxTokens !== undefined &&
    (!Number.isInteger(flags.maxTokens) || flags.maxTokens < 1 || flags.maxTokens > 512)
  ) {
    throw new CliError("--max-tokens is a whole number from 1 to 512.", EXIT.usage);
  }

  let shape: object | undefined;
  if (flags.shape !== undefined) {
    const data = await readDataFile(flags.shape, "shape file");
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      (data as { type?: unknown }).type !== "object"
    ) {
      throw new CliError('The shape must be a JSON Schema with "type": "object" at the top.', EXIT.usage);
    }
    shape = data;
  }

  const state = await readOptionalState(flags, ctx);
  const request: GenerateRequest = {
    ...(state !== undefined && { state }),
    instructions,
    ...(shape && { shape }),
    ...(flags.maxTokens !== undefined && { max_tokens: flags.maxTokens }),
  };

  if (flags.dryRun) {
    writeJson(io, request);
    if (io.stderr.isTTY) io.stderr.write(`  ${ctx.err("dim", "Dry run: nothing was sent.")}\n`);
    return EXIT.ok;
  }
  const langs = codeLangs(flags.code);
  if (langs) {
    printCode(ctx, langs, generateTs(request, ctx.baseURL), curl("/v1/generate", request, ctx.baseURL));
    return EXIT.ok;
  }

  const { res, totalMs } = await sendGenerate(ctx, request);
  const cutOff = res.finish_reason === "length";

  if (flags.json) {
    writeJson(io, res);
  } else if (!io.stdout.isTTY) {
    // Piped: just the output, so `wity generate ... > reply.txt` gets the text.
    if (shape) {
      if (res.value == null)
        throw new CliError("Wity was cut off before the JSON was complete.", EXIT.error, "Raise --max-tokens.");
      io.stdout.write(`${JSON.stringify(res.value)}\n`);
    } else {
      io.stdout.write(`${cleanBlock(res.text)}\n`);
    }
  } else {
    const p = ctx.out;
    const body = shape && res.value != null ? JSON.stringify(res.value, null, 2) : cleanBlock(res.text);
    const lines = ["", ...body.split("\n").map((line) => `  ${line}`), ""];
    if (cutOff)
      lines.push(
        `  ${p("yellow", `▲ Cut off at ${flags.maxTokens ?? 128} tokens. Raise --max-tokens for the rest.`)}`,
        "",
      );
    lines.push(footer(res, totalMs, p), "");
    io.stdout.write(`${lines.join("\n")}\n`);
  }

  if (cutOff && !flags.json && !io.stdout.isTTY) {
    io.stderr.write(`  ${ctx.err("yellow", "▲")} Cut off at max tokens. Raise --max-tokens for the rest.\n`);
  }
  if (cutOff && shape && res.value == null) return EXIT.error;
  return EXIT.ok;
};
