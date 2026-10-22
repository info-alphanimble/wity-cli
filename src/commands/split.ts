// wity split: cut a document into whole items, like emails from a thread or clauses from a contract.

import type { SplitRequest, SplitResponse, SplitSpec } from "wity-sdk";
import { codeLangs, curl, printCode, splitTs } from "../code.ts";
import type { Ctx } from "../context.ts";
import { CliError, EXIT, type ExitCode } from "../exit.ts";
import { MAX_DOC_CHARS, readState, type StateFlags } from "../input.ts";
import { clean, cost, ms, type Paint, truncate, writeJson } from "../output.ts";
import { send } from "../send.ts";

export interface SplitFlags extends StateFlags {
  by?: string;
  unit?: string;
  startsAt?: string[];
  keepTogether?: string[];
  neverSplit?: string[];
  skill?: string;
  json?: boolean;
  jsonl?: boolean;
  dryRun?: boolean;
  code?: string | boolean;
}

/** Each item shows this many lines on a terminal. --json has the rest. */
const PREVIEW_LINES = 4;

/** `--by`, a spec from `--unit` and friends, or `--skill`. Checked before anything is sent. */
const splitOf = (flags: SplitFlags): Pick<SplitRequest, "split" | "skill"> => {
  const specFlags = [flags.unit, flags.startsAt, flags.keepTogether, flags.neverSplit].some((v) => v !== undefined);
  if (flags.skill !== undefined) {
    if (flags.by !== undefined || specFlags) {
      throw new CliError(
        "A split skill brings its own way to split.",
        EXIT.usage,
        "Leave out --by, --unit, --starts-at, --keep-together and --never-split when you use --skill.",
      );
    }
    if (flags.skill.trim() === "") throw new CliError("--skill is empty.", EXIT.usage);
    return { skill: flags.skill };
  }
  if (flags.by !== undefined && specFlags) {
    throw new CliError("Give --by, or --unit with its options, not both.", EXIT.usage);
  }
  if (flags.by !== undefined) {
    const length = flags.by.trim().length;
    if (length < 3 || length > 300) throw new CliError("--by is 3 to 300 characters.", EXIT.usage);
    return { split: flags.by };
  }
  if (!specFlags) return {};
  if (flags.unit === undefined) {
    throw new CliError(
      "--starts-at, --keep-together and --never-split need --unit.",
      EXIT.usage,
      'Say what one item is, like --unit "clause".',
    );
  }
  const unit = flags.unit.trim().length;
  if (unit < 2 || unit > 80) throw new CliError("--unit is 2 to 80 characters.", EXIT.usage);
  const spec: SplitSpec = { unit: flags.unit };
  for (const [flag, key] of [
    ["--starts-at", "startsAt"],
    ["--keep-together", "keepTogether"],
    ["--never-split", "neverSplit"],
  ] as const) {
    const values = flags[key];
    if (values === undefined) continue;
    if (values.length > 8) throw new CliError(`${flag} can be given at most 8 times.`, EXIT.usage);
    if (values.some((v) => v.trim() === "" || v.length > 300)) {
      throw new CliError(`Each ${flag} is 1 to 300 characters.`, EXIT.usage);
    }
  }
  if (flags.startsAt) spec.starts_at = flags.startsAt;
  if (flags.keepTogether) spec.keep_together = flags.keepTogether;
  if (flags.neverSplit) spec.never_split = flags.neverSplit;
  return { split: spec };
};

const footer = (res: SplitResponse, totalMs: number, paint: Paint): string =>
  `  ${paint(
    "dim",
    [
      `${ms(res.timing_ms.total)} on Wity`,
      `${ms(totalMs)} total`,
      `${res.usage.input_tokens.toLocaleString("en")} input tokens`,
      `≈ ${cost(res.usage.input_tokens)}`,
    ].join(" · "),
  )}`;

const how = (res: SplitResponse): string => {
  if (res.skill) return `with the skill ${clean(res.skill.name)} (version ${res.skill.version})`;
  if (res.how.startsWith("rule:")) return `by rule, one ${clean(res.how.slice(5))} each`;
  return "by the model";
};

export const split = async (ctx: Ctx, flags: SplitFlags): Promise<ExitCode> => {
  const { io } = ctx;
  if (flags.json && flags.jsonl) throw new CliError("Give --json or --jsonl, not both.", EXIT.usage);
  const way = splitOf(flags);
  const text = await readState(flags, io, MAX_DOC_CHARS);
  const request = { text, ...way } as SplitRequest;

  if (flags.dryRun) {
    writeJson(io, request);
    if (io.stderr.isTTY) io.stderr.write(`  ${ctx.err("dim", "Dry run: nothing was sent.")}\n`);
    return EXIT.ok;
  }
  const langs = codeLangs(flags.code);
  if (langs) {
    printCode(ctx, langs, splitTs(request, ctx.baseURL), curl("/v1/split", request, ctx.baseURL));
    return EXIT.ok;
  }

  const { res, totalMs } = await send(ctx, "Splitting…", (client, signal) => client.split(request, { signal }));

  if (flags.jsonl) {
    // One item per line, for `while read` loops and jq.
    for (const item of res.items) io.stdout.write(`${JSON.stringify(item)}\n`);
  } else if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
  } else {
    const p = ctx.out;
    const count = res.items.length;
    const width = Math.max(20, (io.stdout.columns ?? 80) - 8);
    const lines = ["", `  ${p("bold", `${count} item${count === 1 ? "" : "s"}`)}  ${p("dim", `cut ${how(res)}`)}`, ""];
    const numberWidth = String(count).length;
    res.items.forEach((item, i) => {
      // Item text came from the document: clean each line so it can't act on the terminal.
      const itemLines = item.text
        .split(/\r\n?|\n/)
        .map(clean)
        .filter(Boolean);
      lines.push(`  ${p("bold", String(i + 1).padStart(numberWidth))}  ${p("dim", `${item.start}–${item.end}`)}`);
      for (const line of itemLines.slice(0, PREVIEW_LINES)) {
        lines.push(`  ${" ".repeat(numberWidth)}  ${truncate(line, width)}`);
      }
      const more = itemLines.length - PREVIEW_LINES;
      if (more > 0)
        lines.push(`  ${" ".repeat(numberWidth)}  ${p("dim", `… ${more} more line${more === 1 ? "" : "s"}`)}`);
      lines.push("");
    });
    lines.push(footer(res, totalMs, p), "");
    io.stdout.write(`${lines.join("\n")}\n`);
  }
  return EXIT.ok;
};
