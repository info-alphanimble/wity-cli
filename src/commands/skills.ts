// wity skills: make, teach, check and remove saved skills. Reading and managing skills is free.
// Adding examples is billed once, on their tokens.

import {
  type CreateDecisionSkill,
  type CreateSplitSkill,
  type DecisionExampleInput,
  type Skill,
  type SkillExample,
  type SplitExampleInput,
  type SystemOneRequest,
  skill as skillQuestion,
  type UpdateDecisionSkill,
  type UpdateSplitSkill,
} from "wity-sdk";
import { codeLangs, curl, printCode, systemOneTs } from "../code.ts";
import type { Ctx } from "../context.ts";
import { CliError, EXIT, type ExitCode } from "../exit.ts";
import { confirmDelete, readState, type StateFlags } from "../input.ts";
import { clean, cost, pct, plural, table, truncate, when, writeJson } from "../output.ts";
import { renderAnswer, renderFooter } from "../render.ts";
import { decisionSkillFileSchema, describeIssues, skillChangesSchema, splitSkillFileSchema } from "../schema.ts";
import { send } from "../send.ts";
import { readDataFile } from "./ask.ts";
import { pickField } from "./questions.ts";

export interface ListFlags {
  limit?: number;
  after?: string;
  json?: boolean;
}

/** --limit is 1 to 100, like the API. */
export const checkLimit = (limit: number | undefined): void => {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new CliError("--limit is a whole number from 1 to 100.", EXIT.usage);
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a skill decides or splits, in one line. */
const summary = (skill: Skill): string => {
  if (skill.kind === "split") return typeof skill.split === "string" ? skill.split : `one item per ${skill.split.unit}`;
  return skill.question.instructions;
};

const tokensLine = (tokens: number): string =>
  `${tokens.toLocaleString("en")} input tokens for the examples ≈ ${cost(tokens)}`;

// ---------------------------------------------------------------------------
// list, show
// ---------------------------------------------------------------------------

export const listSkills = async (ctx: Ctx, flags: ListFlags): Promise<ExitCode> => {
  const { io } = ctx;
  checkLimit(flags.limit);
  const { res } = await send(ctx, "Loading skills…", (client, signal) =>
    client.skills.list({ limit: flags.limit, after: flags.after, signal }),
  );
  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }
  const p = ctx.out;
  if (res.data.length === 0) {
    io.stdout.write(`\n  No skills yet. Make one with ${p("bold", "wity skills add skill.yaml")}\n\n`);
    return EXIT.ok;
  }
  const rows = [
    ["name", "kind", "status", "examples", "version", "answered by", "question or split"],
    ...res.data.map((skill) => [
      clean(skill.name),
      skill.kind,
      clean(skill.status),
      String(skill.examples),
      String(skill.version),
      clean(skill.answered_by),
      truncate(clean(summary(skill)), 50),
    ]),
  ];
  const lines = ["", ...table(rows, p), ""];
  const last = res.data.at(-1);
  if (res.has_more && last) lines.push(`  ${p("dim", `More with --after ${clean(last.id)}`)}`, "");
  io.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
};

/** A skill, field by field, for the terminal. */
const describeSkill = (skill: Skill, ctx: Ctx): string[] => {
  const p = ctx.out;
  const row = (label: string, value: string) => `  ${p("dim", label.padEnd(13))}${value}`;
  const lines = ["", `  ${p("bold", clean(skill.name))}  ${p("dim", clean(skill.id))}`, ""];
  if (skill.kind === "decision") {
    lines.push(row("kind", `decision · ${skill.question.type}`), row("question", clean(skill.question.instructions)));
    if (skill.question.type === "choice") {
      for (const [id, description] of Object.entries(skill.question.criteria)) {
        lines.push(row("", `${p("bold", clean(id))}  ${clean(description)}`));
      }
    } else if (skill.question.criteria) {
      lines.push(
        row("", `yes: ${clean(skill.question.criteria.true)}`),
        row("", `no: ${clean(skill.question.criteria.false)}`),
      );
    }
    for (const [name, part] of Object.entries(skill.parts ?? {})) {
      lines.push(row("part", `${p("bold", clean(name))}  ${clean(part.instructions)}`));
    }
    if (skill.combine) lines.push(row("combine", clean(skill.combine)));
  } else {
    lines.push(row("kind", "split"));
    if (typeof skill.split === "string") {
      lines.push(row("split", clean(skill.split)));
    } else {
      lines.push(row("unit", clean(skill.split.unit)));
      for (const value of skill.split.starts_at ?? []) lines.push(row("starts at", clean(value)));
      for (const value of skill.split.keep_together ?? []) lines.push(row("keep together", clean(value)));
      for (const value of skill.split.never_split ?? []) lines.push(row("never split", clean(value)));
    }
  }
  lines.push(
    row("status", `${clean(skill.status)} · ${plural(skill.examples, "example")} · version ${skill.version}`),
    row("answered by", `${clean(skill.answered_by)}${skill.active ? " · uses what it learned" : ""}`),
  );
  if (skill.quality) {
    const { accuracy, accuracy_without_skill, checked_on } = skill.quality;
    lines.push(
      row(
        "quality",
        `${pct(accuracy)} right, ${pct(accuracy_without_skill)} without the skill, on ${checked_on} held-back examples`,
      ),
    );
  }
  if (skill.description) lines.push(row("description", clean(skill.description)));
  lines.push(row("updated", when(skill.updated_at)), "");
  return lines;
};

export const showSkill = async (ctx: Ctx, name: string, flags: { json?: boolean }): Promise<ExitCode> => {
  const { io } = ctx;
  const { res } = await send(ctx, "Loading the skill…", (client, signal) => client.skills.get(name, { signal }));
  if (flags.json || !io.stdout.isTTY) writeJson(io, res);
  else io.stdout.write(`${describeSkill(res, ctx).join("\n")}\n`);
  return EXIT.ok;
};

// ---------------------------------------------------------------------------
// add, edit, delete
// ---------------------------------------------------------------------------

/** A skills file: a decision skill has `question`, a split skill has `split`. */
const readSkillFile = async (path: string): Promise<CreateDecisionSkill | CreateSplitSkill> => {
  const data = await readDataFile(path, "skill file");
  if (isObject(data) && "question" in data && "split" in data) {
    throw new CliError("A skill has a question or a split, not both.", EXIT.usage);
  }
  const schema = isObject(data) && "split" in data ? splitSkillFileSchema : decisionSkillFileSchema;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new CliError(`The skill file has problems:\n    ${describeIssues(parsed.error)}`, EXIT.usage);
  }
  return parsed.data as CreateDecisionSkill | CreateSplitSkill;
};

export const addSkill = async (ctx: Ctx, path: string, flags: { json?: boolean }): Promise<ExitCode> => {
  const { io } = ctx;
  const request = await readSkillFile(path);
  const { res } = await send(ctx, "Making the skill…", (client, signal) => client.skills.create(request, { signal }));
  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }
  const p = ctx.out;
  const name = clean(res.name);
  const lines = [
    "",
    `  ${p("green", "✓")} Made the ${res.kind} skill ${p("bold", name)} ${p("dim", clean(res.id))}`,
    `    ${plural(res.examples, "example")} · ${clean(res.status)}`,
  ];
  if (res.usage.input_tokens > 0) lines.push(`    ${p("dim", tokensLine(res.usage.input_tokens))}`);
  const next =
    res.kind === "split" ? `wity split --skill ${name} --file document.txt` : `wity skills try ${name} --text "..."`;
  lines.push("", `  ${p("dim", "Try it:")} ${next}`, "");
  io.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
};

export interface EditFlags {
  name?: string;
  description?: string;
  json?: boolean;
}

export const editSkill = async (
  ctx: Ctx,
  name: string,
  path: string | undefined,
  flags: EditFlags,
): Promise<ExitCode> => {
  const { io } = ctx;
  // Either kind's fields. Wity says if one doesn't fit the skill.
  let changes: UpdateDecisionSkill & UpdateSplitSkill = {};
  if (path !== undefined) {
    const parsed = skillChangesSchema.safeParse(await readDataFile(path, "changes file"));
    if (!parsed.success) {
      throw new CliError(`The changes file has problems:\n    ${describeIssues(parsed.error)}`, EXIT.usage);
    }
    changes = parsed.data as UpdateDecisionSkill & UpdateSplitSkill;
  }
  // Flags win over the file.
  if (flags.name !== undefined) {
    if (flags.name.trim() === "") throw new CliError("--name is empty.", EXIT.usage);
    changes.name = flags.name;
  }
  if (flags.description !== undefined) changes.description = flags.description;
  if (Object.keys(changes).length === 0) {
    throw new CliError(
      "Nothing to change.",
      EXIT.usage,
      "Give --name, --description, or a file with the fields to change, like question or split.",
    );
  }

  const { res } = await send(ctx, "Saving…", (client, signal) => client.skills.update(name, changes, { signal }));
  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }
  const p = ctx.out;
  io.stdout.write(
    `\n  ${p("green", "✓")} Saved ${p("bold", clean(res.name))}. Version ${res.version} · ${clean(res.status)}\n\n`,
  );
  return EXIT.ok;
};

export const deleteSkill = async (ctx: Ctx, name: string, flags: { yes?: boolean }): Promise<ExitCode> => {
  const { io } = ctx;
  if (!(await confirmDelete(io, `the skill ${clean(name)} and all its examples`, flags.yes))) {
    io.stderr.write(`  ${ctx.err("dim", "Nothing was deleted.")}\n`);
    return EXIT.cancelled;
  }
  await send(ctx, "Deleting…", (client, signal) => client.skills.delete(name, { signal }));
  io.stderr.write(`  ${ctx.err("green", "✓")} Deleted the skill ${clean(name)}.\n`);
  return EXIT.ok;
};

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

/** A list of examples, or `{ examples: [...] }` like in a skill file. Wity checks each one. */
const readExamples = async (path: string): Promise<DecisionExampleInput[] | SplitExampleInput[]> => {
  const data = await readDataFile(path, "examples file");
  const examples = isObject(data) ? data.examples : data;
  if (!Array.isArray(examples) || examples.length < 1 || examples.length > 1000) {
    throw new CliError(
      "The examples file needs a list of 1 to 1,000 examples.",
      EXIT.usage,
      "Decision skills take {state, answer}. Split skills take {text, items} or {text, starts}.",
    );
  }
  if (!examples.every(isObject)) throw new CliError("Each example must be an object.", EXIT.usage);
  return examples as DecisionExampleInput[] | SplitExampleInput[];
};

export const addExamples = async (
  ctx: Ctx,
  name: string,
  path: string,
  flags: { json?: boolean },
): Promise<ExitCode> => {
  const { io } = ctx;
  const examples = await readExamples(path);
  const { res } = await send(ctx, "Adding examples…", (client, signal) =>
    client.skills.examples.add(name, examples, { signal }),
  );
  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }
  const p = ctx.out;
  const lines = [
    "",
    `  ${p("green", "✓")} Added ${plural(res.data.length, "example")} to ${p("bold", clean(res.skill.name))}`,
    `    ${plural(res.skill.examples, "example")} now · ${clean(res.skill.status)}`,
    `    ${p("dim", tokensLine(res.usage.input_tokens))}`,
    "",
  ];
  io.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
};

const exampleRow = (example: SkillExample): string[] =>
  "starts" in example
    ? [clean(example.id), `${example.items.length} items`, example.source, truncate(clean(example.text), 60)]
    : [clean(example.id), truncate(clean(example.answer), 20), example.source, truncate(clean(example.state), 60)];

export const listExamples = async (ctx: Ctx, name: string, flags: ListFlags): Promise<ExitCode> => {
  const { io } = ctx;
  checkLimit(flags.limit);
  const { res } = await send(ctx, "Loading examples…", (client, signal) =>
    client.skills.examples.list(name, { limit: flags.limit, after: flags.after, signal }),
  );
  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }
  const p = ctx.out;
  if (res.data.length === 0) {
    io.stdout.write(
      `\n  No examples yet. Add some with ${p("bold", `wity skills examples add ${clean(name)} examples.yaml`)}\n\n`,
    );
    return EXIT.ok;
  }
  const lines = ["", ...table([["id", "answer", "source", "text"], ...res.data.map(exampleRow)], p), ""];
  const last = res.data.at(-1);
  if (res.has_more && last) lines.push(`  ${p("dim", `More with --after ${clean(last.id)}`)}`, "");
  io.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
};

export const deleteExample = async (
  ctx: Ctx,
  name: string,
  id: string,
  flags: { yes?: boolean },
): Promise<ExitCode> => {
  const { io } = ctx;
  if (!(await confirmDelete(io, `the example ${clean(id)}`, flags.yes))) {
    io.stderr.write(`  ${ctx.err("dim", "Nothing was deleted.")}\n`);
    return EXIT.cancelled;
  }
  await send(ctx, "Deleting…", (client, signal) => client.skills.examples.delete(name, id, { signal }));
  io.stderr.write(`  ${ctx.err("green", "✓")} Deleted the example ${clean(id)}.\n`);
  return EXIT.ok;
};

// ---------------------------------------------------------------------------
// try
// ---------------------------------------------------------------------------

export interface TryFlags extends StateFlags {
  field?: string;
  json?: boolean;
  dryRun?: boolean;
  code?: string | boolean;
}

/** Ask a saved skill's question about a text. Billed like any question. */
export const trySkill = async (ctx: Ctx, name: string, flags: TryFlags): Promise<ExitCode> => {
  const { io } = ctx;
  if (name.trim() === "") throw new CliError("The skill name is empty.", EXIT.usage);
  const state = await readState(flags, io);
  const request: SystemOneRequest = { state, questions: { answer: skillQuestion(name) } };

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

  const { res, totalMs } = await send(ctx, "Asking Wity…", (client, signal) => client.systemOne(request, { signal }));
  const answer = res.answers.answer;
  if (!answer) throw new CliError("Wity's answer was missing the question. Try again.", EXIT.error);

  if (flags.field !== undefined) {
    io.stdout.write(`${pickField(answer, flags.field)}\n`);
  } else if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
  } else {
    const p = ctx.out;
    const lines = [
      "",
      `  ${p("bold", `skill ${clean(name)}`)}`,
      "",
      ...renderAnswer(answer, p, io.stdout.columns),
      "",
      renderFooter(res, totalMs, p),
      "",
    ];
    io.stdout.write(`${lines.join("\n")}\n`);
  }
  return EXIT.ok;
};
