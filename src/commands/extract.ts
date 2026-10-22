// wity extract: pull named fields out of a document, each value with where it was read and a confidence.

import type { ExtractRequest, ExtractResponse, ExtractType } from "wity-sdk";
import { codeLangs, curl, extractTs, printCode } from "../code.ts";
import type { Ctx } from "../context.ts";
import { CliError, EXIT, type ExitCode } from "../exit.ts";
import { MAX_DOC_CHARS, readState, type StateFlags } from "../input.ts";
import { clean, cost, decimal, ms, type Paint, truncate, writeJson } from "../output.ts";
import { send } from "../send.ts";

export interface ExtractFlags extends StateFlags {
  field: string[];
  type?: string[];
  json?: boolean;
  dryRun?: boolean;
  code?: string | boolean;
}

const TYPES: readonly ExtractType[] = ["date", "duration", "number"];

/** `name=what it asks for`, split at the first `=`. */
const pair = (value: string, flag: string, example: string): [string, string] => {
  const at = value.indexOf("=");
  const name = (at === -1 ? "" : value.slice(0, at)).trim();
  const rest = (at === -1 ? "" : value.slice(at + 1)).trim();
  if (!name || !rest)
    throw new CliError(`${flag} "${clean(value)}" needs a name, then =, then a value.`, EXIT.usage, example);
  return [name, rest];
};

/** Fields and types from the flags. Wity's limits are checked here, so a mistake costs nothing. */
export const extractFields = (
  fieldFlags: string[],
  typeFlags: string[] = [],
): Pick<ExtractRequest, "fields" | "types"> => {
  if (fieldFlags.length < 1 || fieldFlags.length > 16) {
    throw new CliError(
      `Extract takes 1 to 16 fields. You gave ${fieldFlags.length}.`,
      EXIT.usage,
      'Add each with -f name="what it asks for".',
    );
  }
  const fields: Record<string, string> = {};
  for (const value of fieldFlags) {
    const [name, description] = pair(value, "-f", 'Like -f party="a company that signs the agreement".');
    if (name.length > 64 || name.includes('"')) {
      throw new CliError(`The field name "${clean(name)}" is over 64 characters or has a double quote.`, EXIT.usage);
    }
    if (description.length > 300)
      throw new CliError(`What "${clean(name)}" asks for is over 300 characters.`, EXIT.usage);
    if (name in fields) throw new CliError(`The field "${clean(name)}" is given twice.`, EXIT.usage);
    fields[name] = description;
  }
  const types: Record<string, ExtractType> = {};
  for (const value of typeFlags) {
    const [name, type] = pair(value, "--type", 'Like --type "effective date"=date.');
    if (!(name in fields)) throw new CliError(`--type names "${clean(name)}", which isn't a field.`, EXIT.usage);
    if (!TYPES.includes(type as ExtractType)) {
      throw new CliError(`--type for "${clean(name)}" is ${clean(type)}. Use date, duration or number.`, EXIT.usage);
    }
    types[name] = type as ExtractType;
  }
  return { fields, ...(Object.keys(types).length > 0 && { types }) };
};

const footer = (res: ExtractResponse, totalMs: number, paint: Paint): string =>
  `  ${paint(
    "dim",
    [
      `${ms(res.timing_ms)} on Wity`,
      `${ms(totalMs)} total`,
      `${res.usage.input_tokens.toLocaleString("en")} input tokens`,
      `≈ ${cost(res.usage.input_tokens)}`,
    ].join(" · "),
  )}`;

export const extract = async (ctx: Ctx, flags: ExtractFlags): Promise<ExitCode> => {
  const { io } = ctx;
  const { fields, types } = extractFields(flags.field, flags.type);
  const text = await readState(flags, io, MAX_DOC_CHARS);
  const request: ExtractRequest = { text, fields, ...(types && { types }) };

  if (flags.dryRun) {
    writeJson(io, request);
    if (io.stderr.isTTY) io.stderr.write(`  ${ctx.err("dim", "Dry run: nothing was sent.")}\n`);
    return EXIT.ok;
  }
  const langs = codeLangs(flags.code);
  if (langs) {
    printCode(ctx, langs, extractTs(request, ctx.baseURL), curl("/v1/extract", request, ctx.baseURL));
    return EXIT.ok;
  }

  const { res, totalMs } = await send(ctx, "Reading…", (client, signal) => client.extract(request, { signal }));

  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }
  const p = ctx.out;
  const width = Math.max(20, (io.stdout.columns ?? 80) - 24);
  const lines = [""];
  for (const name of Object.keys(fields)) {
    const type = types?.[name];
    lines.push(`  ${p("bold", clean(name))}${type ? `  ${p("dim", type)}` : ""}`);
    const found = res.entities.filter((entity) => entity.field === name);
    if (found.length === 0) lines.push(`    ${p("dim", "none found")}`);
    const valueWidth = Math.min(width, Math.max(...found.map((entity) => clean(entity.text).length)));
    for (const entity of found) {
      const value = truncate(clean(entity.text), width).padEnd(valueWidth);
      lines.push(
        `    ${value}  ${p("dim", `confidence ${decimal(entity.confidence)} · at ${entity.start}–${entity.end}`)}`,
      );
    }
    lines.push("");
  }
  lines.push(`  ${p("dim", "Confidence ranks how sure Wity is. It isn't calibrated.")}`, footer(res, totalMs, p), "");
  io.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
};
