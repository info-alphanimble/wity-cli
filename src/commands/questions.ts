// wity choice, wity noul, wity score: one question about one text.

import {
  type ChoiceAnswer,
  choice,
  type NoulAnswer,
  noul,
  type Question,
  type Reasoning,
  type ScoreAnswer,
  type SystemOneRequest,
  score,
} from "wity-sdk";
import { codeLangs, curl, printCode, systemOneTs } from "../code.ts";
import type { Ctx } from "../context.ts";
import { CliError, EXIT, type ExitCode } from "../exit.ts";
import { readState, type StateFlags } from "../input.ts";
import { clean, pct, writeJson } from "../output.ts";
import { renderAnswer, renderFooter } from "../render.ts";
import { sendSystemOne } from "../send.ts";

/** Flags every question command takes. */
export interface AskFlags extends StateFlags {
  reasoning?: Reasoning;
  maxLatency?: number;
  json?: boolean;
  field?: string;
  failUnder?: number;
  dryRun?: boolean;
  /** --code, --code ts or --code curl. */
  code?: string | boolean;
}

/** Answers come back under the question's name. A single question is always called this. */
const NAME = "answer";

type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

// ---------------------------------------------------------------------------
// Building the question from flags. Every limit is checked here, so a bad question costs nothing.
// ---------------------------------------------------------------------------

const needText = (value: string, what: string): string => {
  if (value.trim() === "") throw new CliError(`The ${what} is empty.`, EXIT.usage);
  return value;
};

/** `--option id=description`, or just `--option id` when the id says enough. */
export const choiceQuestion = (instructions: string, options: string[]) => {
  if (options.length < 2 || options.length > 256) {
    throw new CliError(
      `A choice needs 2 to 256 options. You gave ${options.length}.`,
      EXIT.usage,
      'Add each with --option id="description".',
    );
  }
  const criteria: Record<string, string> = {};
  for (const option of options) {
    const at = option.indexOf("=");
    const id = (at === -1 ? option : option.slice(0, at)).trim();
    const description = (at === -1 ? option : option.slice(at + 1)).trim();
    if (!id) throw new CliError(`The option "${clean(option)}" has no id before the =.`, EXIT.usage);
    if (id in criteria) throw new CliError(`The option id "${clean(id)}" is used twice.`, EXIT.usage);
    criteria[id] = description || id;
  }
  return choice(needText(instructions, "question"), criteria);
};

export const noulQuestion = (instructions: string, yes: string | undefined, no: string | undefined) => {
  if ((yes === undefined) !== (no === undefined)) {
    throw new CliError("Describe both answers, with --yes and --no, or neither.", EXIT.usage);
  }
  const text = needText(instructions, "question");
  return yes !== undefined && no !== undefined ? noul(text, { true: yes, false: no }) : noul(text);
};

export const scoreQuestion = (instructions: string, levels: string[]) => {
  if (levels.length < 2 || levels.length > 10) {
    throw new CliError(
      `A score needs 2 to 10 levels. You gave ${levels.length}.`,
      EXIT.usage,
      "Add each with --level, lowest first.",
    );
  }
  levels.forEach((level) => {
    needText(level, "level");
  });
  return score(needText(instructions, "question"), levels);
};

// ---------------------------------------------------------------------------
// Gates: turn an answer into pass or fail for scripts
// ---------------------------------------------------------------------------

export interface Gate {
  failUnder?: number;
  /** Choice only: the option that should win. */
  expect?: string;
}

/** Checked before the call, so a mistake costs nothing. */
const checkGate = (question: Question, gate: Gate): void => {
  const { failUnder, expect } = gate;
  if (expect !== undefined && question.type === "choice" && !(expect in question.criteria)) {
    throw new CliError(`--expect "${clean(expect)}" isn't one of the options.`, EXIT.usage);
  }
  if (failUnder === undefined) return;
  if (question.type === "score") {
    const top = question.criteria.length - 1;
    if (failUnder < 0 || failUnder > top)
      throw new CliError(`For a score, --fail-under is a level from 0 to ${top}.`, EXIT.usage);
  } else if (failUnder < 0 || failUnder > 1) {
    throw new CliError("--fail-under is a probability from 0 to 1.", EXIT.usage);
  }
};

/** `undefined` when it passes, or the reason it failed. */
export const failedGate = (answer: Answer, gate: Gate): string | undefined => {
  const { failUnder, expect } = gate;
  if (answer.type === "noul") {
    if (failUnder !== undefined && answer.noul < failUnder)
      return `yes is ${pct(answer.noul)}, under --fail-under ${failUnder}.`;
    return undefined;
  }
  if (answer.type === "score") {
    if (failUnder !== undefined && answer.score < failUnder) {
      return `The score is ${answer.score.toFixed(2)}, under --fail-under ${failUnder}.`;
    }
    return undefined;
  }
  const option = expect ?? answer.choice;
  const p = answer.probabilities[option] ?? 0;
  if (failUnder !== undefined) {
    return p < failUnder ? `${clean(option)} is ${pct(p)}, under --fail-under ${failUnder}.` : undefined;
  }
  if (expect !== undefined && answer.choice !== expect)
    return `Wity chose ${clean(answer.choice)}, not ${clean(expect)}.`;
  return undefined;
};

// ---------------------------------------------------------------------------
// --field
// ---------------------------------------------------------------------------

/** A value inside the answer, by dotted path: `noul`, `choice`, `probabilities.billing`, `reasoning.thought`. */
export const pickField = (answer: Answer, path: string): string => {
  let value: unknown = answer;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, part)) {
      const fields = Object.keys(answer).join(", ");
      throw new CliError(`The answer has no field "${clean(path)}".`, EXIT.usage, `Fields: ${fields}`);
    }
    value = (value as Record<string, unknown>)[part];
  }
  if (typeof value === "string") return clean(value);
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
};

// ---------------------------------------------------------------------------
// Running a question
// ---------------------------------------------------------------------------

export const ask = async (ctx: Ctx, question: Question, flags: AskFlags, gate: Gate = {}): Promise<ExitCode> => {
  const { io } = ctx;
  if (
    flags.maxLatency !== undefined &&
    (!Number.isInteger(flags.maxLatency) || flags.maxLatency < 200 || flags.maxLatency > 120_000)
  ) {
    throw new CliError("--max-latency is a whole number of milliseconds, from 200 to 120000.", EXIT.usage);
  }
  checkGate(question, { failUnder: flags.failUnder, ...gate });
  const allGates: Gate = { failUnder: flags.failUnder, ...gate };

  const state = await readState(flags, io);
  const request: SystemOneRequest = {
    state,
    questions: { [NAME]: question },
    ...(flags.reasoning && { reasoning: flags.reasoning }),
    ...(flags.maxLatency !== undefined && { max_latency_ms: flags.maxLatency }),
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

  const answer = res.answers[NAME] as Answer | undefined;
  if (!answer) throw new CliError("Wity's answer was missing the question. Try again.", EXIT.error);

  if (flags.field !== undefined) {
    io.stdout.write(`${pickField(answer, flags.field)}\n`);
  } else if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
  } else {
    const p = ctx.out;
    const lines = [
      "",
      `  ${p("bold", clean(question.instructions))}`,
      "",
      ...renderAnswer(answer, p, io.stdout.columns),
      "",
      renderFooter(res, totalMs, p),
      "",
    ];
    io.stdout.write(`${lines.join("\n")}\n`);
  }

  const failed = failedGate(answer, allGates);
  if (failed) {
    io.stderr.write(`  ${ctx.err("red", "✗")} ${failed}\n`);
    return EXIT.gate;
  }
  return EXIT.ok;
};
