// wity sessions: keep a state on Wity's side, add to it with events, decide on it, and correct the answers.
// Decisions are billed like questions. Events, reads and repeats are free.

import type {
  ChoiceAnswer,
  CreateSession,
  NoulAnswer,
  Reasoning,
  ScoreAnswer,
  Session,
  SessionDecideRequest,
  SessionEvent,
  SessionEventInput,
  UpdateSession,
} from "wity-sdk";
import type { Ctx } from "../context.ts";
import { CliError, EXIT, type ExitCode } from "../exit.ts";
import { confirmDelete, type StateFlags } from "../input.ts";
import { clean, cleanBlock, pct, plural, table, truncate, when, writeJson } from "../output.ts";
import { renderAnswer, renderFooter } from "../render.ts";
import { askFileSchema, describeIssues } from "../schema.ts";
import { send } from "../send.ts";
import { readDataFile } from "./ask.ts";
import { readOptionalState } from "./generate.ts";
import { checkLimit, type ListFlags } from "./skills.ts";

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** `--expires-in 3600`, `90m`, `12h` or `30d`, as seconds. Wity takes 60 s to 90 days. */
export const expiresIn = (value: string): number => {
  const match = /^(\d+)\s*([smhd]?)$/.exec(value.trim());
  const seconds = match ? Number(match[1]) * (UNITS[match[2] || "s"] ?? 1) : Number.NaN;
  if (!(seconds >= 60 && seconds <= 7_776_000)) {
    throw new CliError(
      "--expires-in is 60 seconds to 90 days.",
      EXIT.usage,
      "Give seconds, or a number with s, m, h or d, like 12h or 30d.",
    );
  }
  return seconds;
};

const checkSkills = (skills: string[] | undefined): void => {
  if (skills === undefined) return;
  if (skills.length > 64) throw new CliError("A session takes at most 64 skills.", EXIT.usage);
  if (skills.some((skill) => skill.trim() === "")) throw new CliError("A --skill is empty.", EXIT.usage);
};

// ---------------------------------------------------------------------------
// list, show
// ---------------------------------------------------------------------------

export const listSessions = async (ctx: Ctx, flags: ListFlags): Promise<ExitCode> => {
  const { io } = ctx;
  checkLimit(flags.limit);
  const { res } = await send(ctx, "Loading sessions…", (client, signal) =>
    client.sessions.list({ limit: flags.limit, after: flags.after, signal }),
  );
  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }
  const p = ctx.out;
  if (res.data.length === 0) {
    io.stdout.write(`\n  No sessions. Start one with ${p("bold", 'wity sessions add --text "..."')}\n\n`);
    return EXIT.ok;
  }
  const rows = [
    ["id", "skills", "events", "updated", "expires"],
    ...res.data.map((session) => [
      clean(session.id),
      String(session.skills.length),
      String(session.events),
      when(session.updated_at),
      when(session.expires_at),
    ]),
  ];
  const lines = ["", ...table(rows, p), ""];
  const last = res.data.at(-1);
  if (res.has_more && last) lines.push(`  ${p("dim", `More with --after ${clean(last.id)}`)}`, "");
  io.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
};

const describeSession = (session: Session, ctx: Ctx): string[] => {
  const p = ctx.out;
  const row = (label: string, value: string) => `  ${p("dim", label.padEnd(10))}${value}`;
  const lines = [
    "",
    `  ${p("bold", clean(session.id))}`,
    "",
    row("skills", session.skills.length > 0 ? session.skills.map(clean).join(", ") : p("dim", "none")),
    row("events", String(session.events)),
    row("updated", when(session.updated_at)),
    row("expires", when(session.expires_at)),
  ];
  if (Object.keys(session.metadata).length > 0) lines.push(row("metadata", clean(JSON.stringify(session.metadata))));
  lines.push("", `  ${p("dim", "state")}`);
  const state = cleanBlock(session.state).trim();
  lines.push(...(state ? state.split("\n").map((line) => `    ${line}`) : [`    ${p("dim", "empty")}`]), "");
  return lines;
};

export const showSession = async (ctx: Ctx, id: string, flags: { json?: boolean }): Promise<ExitCode> => {
  const { io } = ctx;
  const { res } = await send(ctx, "Loading the session…", (client, signal) => client.sessions.get(id, { signal }));
  if (flags.json || !io.stdout.isTTY) writeJson(io, res);
  else io.stdout.write(`${describeSession(res, ctx).join("\n")}\n`);
  return EXIT.ok;
};

// ---------------------------------------------------------------------------
// add, edit, delete
// ---------------------------------------------------------------------------

export interface AddSessionFlags extends StateFlags {
  skill?: string[];
  expiresIn?: string;
  json?: boolean;
}

export const addSession = async (ctx: Ctx, flags: AddSessionFlags): Promise<ExitCode> => {
  const { io } = ctx;
  checkSkills(flags.skill);
  const expires = flags.expiresIn !== undefined ? expiresIn(flags.expiresIn) : undefined;
  const state = await readOptionalState(flags, ctx);
  const request: CreateSession = {
    ...(state !== undefined && { state }),
    ...(flags.skill && { skills: flags.skill }),
    ...(expires !== undefined && { expires_in: expires }),
  };
  const { res } = await send(ctx, "Starting the session…", (client, signal) =>
    client.sessions.create(request, { signal }),
  );
  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }
  const p = ctx.out;
  const id = clean(res.id);
  const lines = [
    "",
    `  ${p("green", "✓")} Started the session ${p("bold", id)}`,
    `    ${plural(res.skills.length, "skill")} · expires ${when(res.expires_at)}`,
    "",
    `  ${p("dim", "Add to it:")} wity sessions event ${id} --update "..."`,
    `  ${p("dim", "Decide:")}    wity sessions decide ${id}`,
    "",
  ];
  io.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
};

export const editSession = async (
  ctx: Ctx,
  id: string,
  flags: { skill?: string[]; expiresIn?: string; json?: boolean },
): Promise<ExitCode> => {
  const { io } = ctx;
  checkSkills(flags.skill);
  const changes: UpdateSession = {
    ...(flags.skill && { skills: flags.skill }),
    ...(flags.expiresIn !== undefined && { expires_in: expiresIn(flags.expiresIn) }),
  };
  if (Object.keys(changes).length === 0) {
    throw new CliError(
      "Nothing to change.",
      EXIT.usage,
      "Give --skill (repeat for each) or --expires-in. The state changes only through events.",
    );
  }
  const { res } = await send(ctx, "Saving…", (client, signal) => client.sessions.update(id, changes, { signal }));
  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }
  const p = ctx.out;
  io.stdout.write(
    `\n  ${p("green", "✓")} Saved ${p("bold", clean(res.id))}. ${plural(res.skills.length, "skill")} · expires ${when(res.expires_at)}\n\n`,
  );
  return EXIT.ok;
};

export const deleteSession = async (ctx: Ctx, id: string, flags: { yes?: boolean }): Promise<ExitCode> => {
  const { io } = ctx;
  if (!(await confirmDelete(io, `the session ${clean(id)} and its log`, flags.yes))) {
    io.stderr.write(`  ${ctx.err("dim", "Nothing was deleted.")}\n`);
    return EXIT.cancelled;
  }
  await send(ctx, "Deleting…", (client, signal) => client.sessions.delete(id, { signal }));
  io.stderr.write(`  ${ctx.err("green", "✓")} Deleted the session ${clean(id)}.\n`);
  return EXIT.ok;
};

// ---------------------------------------------------------------------------
// event
// ---------------------------------------------------------------------------

export interface EventFlags {
  update?: string;
  state?: string;
  note?: string;
  feedback?: string;
  answer?: string;
  question?: string;
  json?: boolean;
}

/** One event from the flags. Exactly one kind per call. */
const eventOf = (flags: EventFlags): SessionEventInput => {
  const given = (["update", "state", "note", "feedback"] as const).filter((kind) => flags[kind] !== undefined);
  if (given.length !== 1) {
    throw new CliError(
      given.length === 0 ? "Say what happened." : "Give one event at a time.",
      EXIT.usage,
      "Use --update, --state or --note with text, or --feedback <decision_id> --answer <answer>.",
    );
  }
  if ((flags.answer !== undefined || flags.question !== undefined) && flags.feedback === undefined) {
    throw new CliError("--answer and --question go with --feedback.", EXIT.usage);
  }
  if (flags.feedback !== undefined) {
    if (flags.answer === undefined || flags.answer.trim() === "") {
      throw new CliError(
        "--feedback needs --answer: the right answer.",
        EXIT.usage,
        "yes or no for a yes-or-no skill, or an option id for a choice.",
      );
    }
    return {
      type: "feedback",
      decision_id: flags.feedback,
      answer: flags.answer,
      ...(flags.question !== undefined && { question: flags.question }),
    };
  }
  const type = given[0] as "update" | "state" | "note";
  const content = flags[type] ?? "";
  // Only a state event may be empty: it clears what Wity reads.
  if (type !== "state" && content.trim() === "") throw new CliError(`--${type} is empty.`, EXIT.usage);
  return { type, content };
};

const EVENT_DONE: Record<SessionEventInput["type"], string> = {
  update: "Added the update.",
  state: "Replaced the state. Later decisions read from here on.",
  note: "Added the note. Decisions don't read notes.",
  feedback: "Saved the right answer. It's now an example of the skill.",
};

export const addEvent = async (ctx: Ctx, id: string, flags: EventFlags): Promise<ExitCode> => {
  const { io } = ctx;
  const event = eventOf(flags);
  const { res } = await send(ctx, "Adding…", (client, signal) => client.sessions.addEvents(id, [event], { signal }));
  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }
  const p = ctx.out;
  io.stdout.write(
    `\n  ${p("green", "✓")} ${EVENT_DONE[event.type]} ${p("dim", `${res.session.events} events in ${clean(res.session.id)}`)}\n\n`,
  );
  return EXIT.ok;
};

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

export interface DecideFlags {
  reasoning?: Reasoning;
  remember?: boolean;
  json?: boolean;
}

export const decide = async (ctx: Ctx, id: string, path: string | undefined, flags: DecideFlags): Promise<ExitCode> => {
  const { io } = ctx;
  let request: SessionDecideRequest = {};
  if (path !== undefined) {
    const parsed = askFileSchema.safeParse(await readDataFile(path, "questions file"));
    if (!parsed.success) {
      throw new CliError(`The questions file has problems:\n    ${describeIssues(parsed.error)}`, EXIT.usage);
    }
    if (parsed.data.state !== undefined) {
      throw new CliError("A session decides on its own state. Remove state from the file.", EXIT.usage);
    }
    const { questions, reasoning, max_latency_ms } = parsed.data;
    request = { questions, ...(reasoning && { reasoning }), ...(max_latency_ms !== undefined && { max_latency_ms }) };
  }
  // Flags win over the file.
  if (flags.reasoning) request.reasoning = flags.reasoning;
  if (flags.remember) request.remember = true;

  const { res, totalMs } = await send(ctx, "Deciding…", (client, signal) =>
    client.sessions.decide(id, request, { signal }),
  );
  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }

  const p = ctx.out;
  const lines: string[] = [""];
  for (const [name, answer] of Object.entries(res.answers)) {
    const question = request.questions?.[name];
    // Without a file, the session's skills answer, each under its own name.
    const title = !question ? `skill ${name}` : "skill" in question ? `skill ${question.skill}` : question.instructions;
    lines.push(`  ${p("dim", clean(name))}  ${p("bold", clean(title))}`, "");
    lines.push(...renderAnswer(answer, p, io.stdout.columns), "");
  }
  const { updates_read, updates_left_out } = res.context;
  const read = `read ${updates_read} update${updates_read === 1 ? "" : "s"}${updates_left_out > 0 ? `, left out the ${updates_left_out} oldest to fit` : ""}`;
  lines.push(`  ${p("dim", `decision ${clean(res.decision_id)} · ${read}`)}`);
  if (res.cached)
    lines.push(`  ${p("dim", "Answered before with the same contents and questions: same answer, 0 tokens.")}`);
  lines.push(renderFooter(res, totalMs, p), "");
  lines.push(
    `  ${p("dim", "Wrong?")} wity sessions event ${clean(res.session_id)} --feedback ${clean(res.decision_id)} --answer <right answer>`,
    "",
  );
  io.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
};

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

/** An answer in a few words: "yes 93.82%", "billing 87.00%" or "score 1.97". */
const answerText = (answer: ChoiceAnswer | NoulAnswer | ScoreAnswer): string => {
  if (answer.type === "noul") return answer.noul >= 0.5 ? `yes ${pct(answer.noul)}` : `no ${pct(1 - answer.noul)}`;
  if (answer.type === "choice") return `${answer.choice} ${pct(answer.probabilities[answer.choice] ?? 0)}`;
  return `score ${answer.score.toFixed(2)}`;
};

/** What an event says, in one line. Contents follow the server: text events keep it under `content`. */
const eventText = (event: SessionEvent): string => {
  const { content } = event;
  if (event.type === "decision") {
    // The answers first, like "urgent: yes 93.82%", so a cut-off row still shows them.
    const answers = content.answers as Record<string, ChoiceAnswer | NoulAnswer | ScoreAnswer> | undefined;
    if (answers && typeof answers === "object") {
      return Object.entries(answers)
        .map(([name, answer]) => `${name}: ${answerText(answer)}`)
        .join(" · ");
    }
    if (typeof content.rendered === "string") return content.rendered.replace(/\n/g, " · ");
  }
  if (event.type === "feedback") {
    const question = typeof content.question === "string" ? `${content.question}: ` : "";
    return `${String(content.decision_id ?? "")} → ${question}${String(content.answer ?? "")}`;
  }
  if (typeof content.content === "string") return content.content;
  return JSON.stringify(content);
};

export const showLog = async (ctx: Ctx, id: string, flags: ListFlags): Promise<ExitCode> => {
  const { io } = ctx;
  checkLimit(flags.limit);
  const { res } = await send(ctx, "Loading the log…", (client, signal) =>
    client.sessions.events(id, { limit: flags.limit, after: flags.after, signal }),
  );
  if (flags.json || !io.stdout.isTTY) {
    writeJson(io, res);
    return EXIT.ok;
  }
  const p = ctx.out;
  if (res.data.length === 0) {
    io.stdout.write(`\n  ${p("dim", "The log is empty.")}\n\n`);
    return EXIT.ok;
  }
  const width = Math.max(20, (io.stdout.columns ?? 100) - 48);
  const rows = [
    ["time", "type", "id", "what"],
    ...res.data.map((event) => [
      when(event.created_at),
      event.type,
      clean(event.id),
      truncate(clean(eventText(event)), width),
    ]),
  ];
  const lines = ["", ...table(rows, p), ""];
  const last = res.data.at(-1);
  if (res.has_more && last) lines.push(`  ${p("dim", `More with --after ${clean(last.id)}`)}`, "");
  io.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
};
