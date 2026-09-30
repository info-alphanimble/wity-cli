// wity ask <file>: several named questions about one text, in one call.

import { readFile, stat } from "node:fs/promises";
import type { Reasoning, SystemOneRequest } from "wity";
import { parse } from "yaml";
import { codeLangs, curl, printCode, systemOneTs } from "../code.ts";
import type { Ctx } from "../context.ts";
import { CliError, EXIT, type ExitCode } from "../exit.ts";
import { readState, type StateFlags } from "../input.ts";
import { clean, writeJson } from "../output.ts";
import { renderAnswer, renderFooter } from "../render.ts";
import { askFileSchema, checkStateLength, describeIssues } from "../schema.ts";
import { sendSystemOne } from "../send.ts";
import { pickField } from "./questions.ts";

/** Question files are small. Anything bigger is a mistake. */
const MAX_FILE_BYTES = 1024 * 1024;

export interface AskFileFlags extends StateFlags {
  reasoning?: Reasoning;
  maxLatency?: number;
  json?: boolean;
  field?: string;
  dryRun?: boolean;
  code?: string | boolean;
}

/** Read a YAML or JSON file (JSON is valid YAML). */
export const readDataFile = async (path: string, what: string): Promise<unknown> => {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new CliError(`Can't read the ${what} ${path}`, EXIT.usage);
  }
  if (size > MAX_FILE_BYTES) throw new CliError(`The ${what} is over 1 MB.`, EXIT.usage);
  try {
    // The yaml package runs no code from the file, and caps aliases, so a hostile file can't blow up memory.
    return parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new CliError(
      `The ${what} isn't valid YAML or JSON: ${clean((err as Error).message).slice(0, 200)}`,
      EXIT.usage,
    );
  }
};

export const askFile = async (ctx: Ctx, path: string, flags: AskFileFlags): Promise<ExitCode> => {
  const { io } = ctx;
  const parsed = askFileSchema.safeParse(await readDataFile(path, "questions file"));
  if (!parsed.success) {
    throw new CliError(`The questions file has problems:\n    ${describeIssues(parsed.error)}`, EXIT.usage);
  }
  const file = parsed.data;

  if (
    flags.maxLatency !== undefined &&
    (!Number.isInteger(flags.maxLatency) || flags.maxLatency < 200 || flags.maxLatency > 120_000)
  ) {
    throw new CliError("--max-latency is a whole number of milliseconds, from 200 to 120000.", EXIT.usage);
  }

  let state = file.state;
  if (state !== undefined && (flags.text !== undefined || flags.file !== undefined)) {
    throw new CliError(
      "The file already has a state. Leave out --text and --file, or remove state from the file.",
      EXIT.usage,
    );
  }
  state ??= await readState(flags, io);
  checkStateLength(state);

  // Flags win over the file, so one file can be run with different settings.
  const reasoning = flags.reasoning ?? file.reasoning;
  const maxLatency = flags.maxLatency ?? file.max_latency_ms;
  const request: SystemOneRequest = {
    state,
    questions: file.questions,
    ...(reasoning && { reasoning }),
    ...(maxLatency !== undefined && { max_latency_ms: maxLatency }),
  };

  if (flags.dryRun) {
    writeJson(io, request);
    if (io.stderr.isTTY) io.stderr.write(`  ${ctx.err("dim", "Dry run: nothing was sent.")}\n`);
    return EXIT.ok;
  }
  const langs = codeLangs(flags.code);
  if (langs) {
    printCode(ctx, langs, systemOneTs(request, ctx.baseURL), curl("/v1/systemone", request, ctx.baseURL));
    return EXIT.ok;
  }

  const { res, totalMs } = await sendSystemOne(ctx, request);

  if (flags.field !== undefined) {
    // "team.choice": the question's name, then a field of its answer.
    const [name = "", ...rest] = flags.field.split(".");
    const answer = res.answers[name];
    if (!answer) {
      throw new CliError(
        `There's no question named "${clean(name)}".`,
        EXIT.usage,
        `Questions: ${Object.keys(res.answers).join(", ")}`,
      );
    }
    io.stdout.write(`${rest.length > 0 ? pickField(answer, rest.join(".")) : JSON.stringify(answer)}\n`);
  } else if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
  } else {
    const p = ctx.out;
    const lines: string[] = [""];
    for (const [name, question] of Object.entries(file.questions)) {
      const answer = res.answers[name];
      if (!answer) continue;
      lines.push(`  ${p("dim", clean(name))}  ${p("bold", clean(question.instructions))}`, "");
      lines.push(...renderAnswer(answer, p, io.stdout.columns), "");
    }
    lines.push(renderFooter(res, totalMs, p), "");
    io.stdout.write(`${lines.join("\n")}\n`);
  }
  return EXIT.ok;
};
