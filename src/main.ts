// The `wity` command: flags, subcommands and error handling.
// `main` never calls process.exit. It returns the exit code, so tests can run it in-process.

import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import pkg from "../package.json" with { type: "json" };
import { removeKey, type SetKeyOptions, setKey, showKey } from "./commands/api-key.ts";
import { type AskFileFlags, askFile } from "./commands/ask.ts";
import { doctor } from "./commands/doctor.ts";
import { type ExtractFlags, extract } from "./commands/extract.ts";
import { type GenerateFlags, generate } from "./commands/generate.ts";
import { type AskFlags, ask, choiceQuestion, noulQuestion, scoreQuestion } from "./commands/questions.ts";
import {
  type AddSessionFlags,
  addEvent,
  addSession,
  type DecideFlags,
  decide,
  deleteSession,
  type EventFlags,
  editSession,
  listSessions,
  showLog,
  showSession,
} from "./commands/sessions.ts";
import {
  addExamples,
  addSkill,
  deleteExample,
  deleteSkill,
  type EditFlags,
  editSkill,
  type ListFlags,
  listExamples,
  listSkills,
  showSkill,
  type TryFlags,
  trySkill,
} from "./commands/skills.ts";
import { type SplitFlags, split } from "./commands/split.ts";
import { makeCtx } from "./context.ts";
import { CliError, EXIT } from "./exit.ts";
import { readState, type StateFlags } from "./input.ts";
import type { Io } from "./io.ts";
import { clean, painter, shouldColor } from "./output.ts";

const number = (value: string): number => {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) throw new InvalidArgumentError("Not a number.");
  return parsed;
};

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

const askOptions = (command: Command): Command =>
  command
    .option("-t, --text <text>", "the text to judge")
    .option("--file <path>", "read the text from a file (- for stdin)")
    .addOption(
      new Option("-r, --reasoning <mode>", "when Wity thinks before answering").choices(["off", "auto", "always"]),
    )
    .option("--max-latency <ms>", "cap the time per request, 200 to 120000 ms", number)
    .option("--fail-under <n>", "exit with code 10 if the answer is under n", number)
    .option("--field <path>", "print one field of the answer, like noul or probabilities.billing")
    .option("--json", "print the full response as JSON (the default when piped)")
    .option("--dry-run", "print the request without sending it")
    .option("--code [lang]", "print the request as TypeScript and curl (or only ts, or curl) instead of sending it");

const EXAMPLES = `
Examples:
  cat email.txt | wity noul "Is this spam?"
  wity choice "Which team handles this?" -o billing="Payments and refunds" -o tech="Bugs" --file ticket.txt
  wity score "How upset is the customer?" -l Calm -l Annoyed -l Angry --text "Where is my order?!"
  wity noul "Is this safe to merge?" --file diff.txt --fail-under 0.8 && git merge
  wity ask questions.yaml --file ticket.txt
  wity generate "A one-line reply to this customer" --file ticket.txt
  wity split --file thread.txt --by "one item per email" --jsonl
  wity extract -f party="a company that signs it" -f start="when it takes effect" --type start=date --file contract.txt
  wity skills add urgent-ticket.yaml && wity skills try urgent-ticket --file ticket.txt
  wity sessions add --text "Ticket #5120 from Northwind" --skill urgent-ticket

Exit codes:
  0 ok · 1 API or network error · 2 bad input (not billed) · 3 no API key, or the key was refused
  10 answered, but failed --fail-under or --expect · 130 cancelled
`;

export const main = async (argv: string[], io: Io): Promise<number> => {
  let code: number = EXIT.ok;
  const program = new Command("wity");
  const ctx = () => makeCtx(io, program.opts<{ baseUrl?: string }>().baseUrl);

  program
    .description("Ask Wity typed questions about any text, and get a probability for every answer.")
    .version(pkg.version, "-v, --version", "print the version")
    .helpOption("-h, --help", "show help")
    // Commander leaves out `wity help` when the root command has its own action (the playground), so add it.
    .helpCommand("help [command]", "show help for a command")
    // Works, but stays out of help: it's for testing against another API address, not everyday use.
    .addOption(new Option("--base-url <url>", "API address (default: WITY_BASE_URL, then the Wity API)").hideHelp())
    .addHelpText("after", EXAMPLES)
    .showHelpAfterError("(add --help for usage)")
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
      // Commander repeats what was typed in its errors, like `unknown option '--api-key=wity_…'`. Hide keys.
      outputError: (text, write) => write(text.replace(/wity_[\w-]{16,}/g, "wity_…")),
    })
    .exitOverride()
    // On a terminal, `wity` alone opens the playground. Anywhere else it prints help.
    .action(async () => {
      if (!io.stdin.isTTY || !io.stdout.isTTY) program.help();
      const { playground } = await import("./playground.tsx");
      code = await playground(ctx(), "");
    });

  const setHint = "Run `wity api-key set <key>`, or `wity api-key set` to paste it at a hidden prompt.";

  // Extra words and unknown options come through to the actions instead of commander's own error, which would
  // print them back. People type `wity api-key wity_…` or `wity api-key set --key=wity_…`, and that must never
  // echo the key.
  const keyCommand = program
    .command("api-key")
    .description("save, show or remove your Wity API key")
    .allowExcessArguments()
    .allowUnknownOption()
    .action((_opts: object, command: Command) => {
      if (command.args.length > 0) throw new CliError("`wity api-key` takes set, show or remove.", EXIT.usage, setHint);
      command.help();
    });

  keyCommand
    .command("set")
    .description("save an API key: give it here, or paste it at a hidden prompt")
    .argument("[key]", "the API key (leave out to paste it at a prompt)")
    .option("--stdin", "read the key from stdin, for CI and scripts")
    .allowExcessArguments()
    .allowUnknownOption()
    // Read from command.args, not commander's parsed argument, so an unknown option is never taken as the key.
    .action(async (_key: string | undefined, opts: SetKeyOptions, command: Command) => {
      const [key, ...rest] = command.args;
      if (rest.length > 0 || key?.startsWith("-")) {
        throw new CliError("`wity api-key set` takes only the key.", EXIT.usage, setHint);
      }
      code = await setKey(ctx(), opts, key);
    });

  keyCommand
    .command("show")
    .description("show which key is in use, and check that it works")
    .option("--json", "print as JSON")
    .action(async (opts: { json?: boolean }) => {
      code = await showKey(ctx(), opts);
    });

  keyCommand
    .command("remove")
    .description("remove the saved key from this computer")
    .action(async () => {
      code = await removeKey(ctx());
    });

  program
    .command("doctor")
    .description("check the setup: key, storage, and the connection to Wity")
    .option("--json", "print as JSON")
    .action(async (opts: { json?: boolean }) => {
      code = await doctor(ctx(), opts);
    });

  askOptions(
    program
      .command("noul")
      .description("ask a yes or no question. Prints the probability of yes")
      .argument("<question>", 'the question, like "Is this spam?"')
      .option("--if-yes <text>", "what yes means (use with --if-no)")
      .option("--if-no <text>", "what no means (use with --if-yes)"),
  ).action(async (question: string, opts: AskFlags & { ifYes?: string; ifNo?: string }) => {
    code = await ask(ctx(), noulQuestion(question, opts.ifYes, opts.ifNo), opts);
  });

  askOptions(
    program
      .command("choice")
      .description("pick one of several options. Prints a probability for each")
      .argument("<question>", 'the question, like "Which team should handle this?"')
      .requiredOption("-o, --option <id=description>", "an option, repeat for each (2 to 256)", collect)
      .option("--expect <id>", "exit with code 10 unless this option wins (or, with --fail-under, is at least n)"),
  ).action(async (question: string, opts: AskFlags & { option: string[]; expect?: string }) => {
    code = await ask(ctx(), choiceQuestion(question, opts.option), opts, { expect: opts.expect });
  });

  askOptions(
    program
      .command("score")
      .description("place the text on a scale of 2 to 10 levels")
      .argument("<question>", 'the question, like "How upset is the customer?"')
      .requiredOption("-l, --level <text>", "a level, lowest first, repeat for each (2 to 10)", collect),
  ).action(async (question: string, opts: AskFlags & { level: string[] }) => {
    code = await ask(ctx(), scoreQuestion(question, opts.level), opts);
  });

  program
    .command("ask")
    .description("ask several named questions about one text, from a YAML or JSON file")
    .argument("<questions-file>", "the questions, in the API's shape (see README)")
    .option("-t, --text <text>", "the text to judge (unless the file has a state)")
    .option("--file <path>", "read the text from a file (- for stdin)")
    .addOption(
      new Option("-r, --reasoning <mode>", "when Wity thinks before answering").choices(["off", "auto", "always"]),
    )
    .option("--max-latency <ms>", "cap the time per request, 200 to 120000 ms", number)
    .option("--field <path>", "print one value, like team.choice or urgent.noul")
    .option("--json", "print the full response as JSON (the default when piped)")
    .option("--dry-run", "print the request without sending it")
    .option("--code [lang]", "print the request as TypeScript and curl (or only ts, or curl) instead of sending it")
    .action(async (path: string, opts: AskFileFlags) => {
      code = await askFile(ctx(), path, opts);
    });

  program
    .command("generate")
    .description("write short text, or JSON that matches a shape")
    .argument("<instructions>", 'what to write, like "A one-line reply to this customer"')
    .option("-t, --text <text>", "the text to write from (optional)")
    .option("--file <path>", "read the text from a file (- for stdin)")
    .option("--shape <file>", "a JSON Schema (JSON or YAML) the output must match")
    .option("--max-tokens <n>", "the most tokens to write, 1 to 512 (default 128)", number)
    .option("--json", "print the full response as JSON")
    .option("--dry-run", "print the request without sending it")
    .option("--code [lang]", "print the request as TypeScript and curl (or only ts, or curl) instead of sending it")
    .action(async (instructions: string, opts: GenerateFlags) => {
      code = await generate(ctx(), instructions, opts);
    });

  program
    .command("split")
    .description("cut a document into whole items, like emails from a thread or clauses from a contract")
    .option("-t, --text <text>", "the document")
    .option("--file <path>", "read the document from a file (- for stdin)")
    .option("--by <words>", 'what one item is, in plain words, like "one item per email"')
    .option("--unit <unit>", 'what one item is, in a word or two, like "clause"')
    .option("--starts-at <text>", "what a new item starts with, repeat for each (up to 8)", collect)
    .option("--keep-together <text>", "what stays inside one item, repeat for each (up to 8)", collect)
    .option("--never-split <text>", "where an item never starts, repeat for each (up to 8)", collect)
    .option("--skill <name>", "split the way a split skill was taught")
    .option("--json", "print the full response as JSON (the default when piped)")
    .option("--jsonl", "print one item per line as JSON, for scripts")
    .option("--dry-run", "print the request without sending it")
    .option("--code [lang]", "print the request as TypeScript and curl (or only ts, or curl) instead of sending it")
    .action(async (opts: SplitFlags) => {
      code = await split(ctx(), opts);
    });

  program
    .command("extract")
    .description("pull named fields out of a document, each value with a confidence")
    .requiredOption(
      "-f, --field <name=description>",
      "a field and what it asks for, repeat for each (1 to 16)",
      collect,
    )
    .option("--type <name=type>", "make a field come back as a date, duration or number, repeat for each", collect)
    .option("-t, --text <text>", "the document")
    .option("--file <path>", "read the document from a file (- for stdin)")
    .option("--json", "print the full response as JSON (the default when piped)")
    .option("--dry-run", "print the request without sending it")
    .option("--code [lang]", "print the request as TypeScript and curl (or only ts, or curl) instead of sending it")
    .action(async (opts: ExtractFlags) => {
      code = await extract(ctx(), opts);
    });

  const listOptions = (command: Command): Command =>
    command
      .option("--limit <n>", "how many to show, 1 to 100", number)
      .option("--after <id>", "start after this id, for the next page")
      .option("--json", "print as JSON (the default when piped)");

  const skills = program
    .command("skills")
    .description("make, teach and use saved skills (reading and managing them is free)");

  listOptions(skills.command("list").description("list your skills, newest first")).action(async (opts: ListFlags) => {
    code = await listSkills(ctx(), opts);
  });

  skills
    .command("show")
    .description("show one skill: its question or split, examples, status and quality")
    .argument("<skill>", "the skill's name or id")
    .option("--json", "print as JSON (the default when piped)")
    .action(async (name: string, opts: { json?: boolean }) => {
      code = await showSkill(ctx(), name, opts);
    });

  skills
    .command("add")
    .description("make a skill from a YAML or JSON file (see README). Examples in it are billed")
    .argument("<file>", "the skill: a name, and a question (decision skill) or a split (split skill)")
    .option("--json", "print as JSON (the default when piped)")
    .action(async (path: string, opts: { json?: boolean }) => {
      code = await addSkill(ctx(), path, opts);
    });

  skills
    .command("edit")
    .description("change a skill. A new question, parts or rule makes it learn again")
    .argument("<skill>", "the skill's name or id")
    .argument("[file]", "a YAML or JSON file with only the fields to change")
    .option("--name <name>", "a new name")
    .option("--description <text>", "a new description")
    .option("--json", "print as JSON (the default when piped)")
    .action(async (name: string, path: string | undefined, opts: EditFlags) => {
      code = await editSkill(ctx(), name, path, opts);
    });

  skills
    .command("delete")
    .description("delete a skill and its examples")
    .argument("<skill>", "the skill's name or id")
    .option("-y, --yes", "don't ask first (needed in scripts)")
    .action(async (name: string, opts: { yes?: boolean }) => {
      code = await deleteSkill(ctx(), name, opts);
    });

  skills
    .command("try")
    .description("ask a decision skill's question about a text (billed like any question)")
    .argument("<skill>", "the skill's name or id")
    .option("-t, --text <text>", "the text to judge")
    .option("--file <path>", "read the text from a file (- for stdin)")
    .option("--field <path>", "print one field of the answer, like noul, choice or skill.version")
    .option("--json", "print the full response as JSON (the default when piped)")
    .option("--dry-run", "print the request without sending it")
    .option("--code [lang]", "print the request as TypeScript and curl (or only ts, or curl) instead of sending it")
    .action(async (name: string, opts: TryFlags) => {
      code = await trySkill(ctx(), name, opts);
    });

  const examples = skills.command("examples").description("teach a skill with labelled examples");

  examples
    .command("add")
    .description("add examples from a YAML or JSON list (billed once, on their tokens)")
    .argument("<skill>", "the skill's name or id")
    .argument("<file>", "decision skills: {state, answer} each. Split skills: {text, items} or {text, starts}")
    .option("--json", "print as JSON (the default when piped)")
    .action(async (name: string, path: string, opts: { json?: boolean }) => {
      code = await addExamples(ctx(), name, path, opts);
    });

  listOptions(
    examples
      .command("list")
      .description("list a skill's examples, newest first")
      .argument("<skill>", "the skill's name or id"),
  ).action(async (name: string, opts: ListFlags) => {
    code = await listExamples(ctx(), name, opts);
  });

  examples
    .command("delete")
    .description("remove one example")
    .argument("<skill>", "the skill's name or id")
    .argument("<id>", "the example's id")
    .option("-y, --yes", "don't ask first (needed in scripts)")
    .action(async (name: string, id: string, opts: { yes?: boolean }) => {
      code = await deleteExample(ctx(), name, id, opts);
    });

  const sessions = program
    .command("sessions")
    .description("keep a state on Wity's side, add to it as things happen, and decide on it");

  listOptions(sessions.command("list").description("list your sessions, newest first")).action(
    async (opts: ListFlags) => {
      code = await listSessions(ctx(), opts);
    },
  );

  sessions
    .command("show")
    .description("show one session: its state, skills and when it expires")
    .argument("<id>", "the session's id")
    .option("--json", "print as JSON (the default when piped)")
    .action(async (id: string, opts: { json?: boolean }) => {
      code = await showSession(ctx(), id, opts);
    });

  sessions
    .command("add")
    .description("start a session")
    .option("-t, --text <text>", "the state Wity reads first (optional)")
    .option("--file <path>", "read the state from a file (- for stdin)")
    .option("--skill <name>", "a skill the session decides with, repeat for each", collect)
    .option("--expires-in <time>", "delete it after this long, like 12h or 30d (default 7 days)")
    .option("--json", "print as JSON (the default when piped)")
    .action(async (opts: AddSessionFlags) => {
      code = await addSession(ctx(), opts);
    });

  sessions
    .command("edit")
    .description("change a session's skills or expiry. The state changes only through events")
    .argument("<id>", "the session's id")
    .option("--skill <name>", "the skills to decide with, repeat for each (replaces the list)", collect)
    .option("--expires-in <time>", "delete it this long from now, like 12h or 30d")
    .option("--json", "print as JSON (the default when piped)")
    .action(async (id: string, opts: { skill?: string[]; expiresIn?: string; json?: boolean }) => {
      code = await editSession(ctx(), id, opts);
    });

  sessions
    .command("delete")
    .description("delete a session and its log")
    .argument("<id>", "the session's id")
    .option("-y, --yes", "don't ask first (needed in scripts)")
    .action(async (id: string, opts: { yes?: boolean }) => {
      code = await deleteSession(ctx(), id, opts);
    });

  sessions
    .command("event")
    .description("add what happened to a session, or correct an earlier decision (free)")
    .argument("<id>", "the session's id")
    .option("--update <text>", "add this to what Wity reads")
    .option("--state <text>", "replace what Wity reads from here on")
    .option("--note <text>", "keep this in the log. Decisions don't read it")
    .option("--feedback <decision_id>", "correct this decision (use with --answer)")
    .option("--answer <answer>", "the right answer: yes or no, or an option id")
    .option("--question <name>", "which question, if the decision had more than one skill")
    .option("--json", "print as JSON (the default when piped)")
    .action(async (id: string, opts: EventFlags) => {
      code = await addEvent(ctx(), id, opts);
    });

  sessions
    .command("decide")
    .description("decide on what the session holds now, with its skills or a questions file")
    .argument("<id>", "the session's id")
    .argument("[questions-file]", "questions like `wity ask` takes, without a state (default: the session's skills)")
    .addOption(
      new Option("-r, --reasoning <mode>", "when Wity thinks before answering (default off)").choices([
        "off",
        "auto",
        "always",
      ]),
    )
    .option("--remember", "add these answers to what later decisions read")
    .option("--json", "print the full response as JSON (the default when piped)")
    .action(async (id: string, path: string | undefined, opts: DecideFlags) => {
      code = await decide(ctx(), id, path, opts);
    });

  listOptions(
    sessions.command("log").description("show a session's events, oldest first").argument("<id>", "the session's id"),
  ).action(async (id: string, opts: ListFlags) => {
    code = await showLog(ctx(), id, opts);
  });

  program
    .command("playground")
    .description("try questions live in the terminal (also: wity with no arguments)")
    .option("-t, --text <text>", "start with this text")
    .option("--file <path>", "start with the text of this file")
    .action(async (opts: StateFlags) => {
      const text = opts.text !== undefined || opts.file !== undefined ? await readState(opts, io) : "";
      const { playground } = await import("./playground.tsx");
      code = await playground(ctx(), text);
    });

  program
    .command("mcp")
    .description("run Wity as an MCP server for AI agents")
    .command("serve")
    .description("serve Wity's tools over stdio, for Claude Code, Claude Desktop, Cursor and others")
    .option("--max-spend <usd>", "stop paid calls after this many dollars in one session", number)
    .action(async (opts: { maxSpend?: number }) => {
      const { serveMcp } = await import("./mcp.ts");
      code = await serveMcp(ctx(), opts);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return code;
  } catch (err) {
    // Commander has already printed its own message (or the help).
    if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT.ok : EXIT.usage;

    const paint = painter(shouldColor(io.env, io.stderr));
    if (err instanceof CliError) {
      io.stderr.write(`\n  ${paint("red", "✗")} ${err.message}\n`);
      if (err.hint) io.stderr.write(`    ${paint("dim", err.hint)}\n`);
      io.stderr.write("\n");
      return err.code;
    }
    // A bug, or something the CLI didn't expect. Show the message only: a stack trace helps nobody at a terminal.
    const message = err instanceof Error ? err.message : String(err);
    io.stderr.write(`\n  ${paint("red", "✗")} Something went wrong: ${clean(message)}\n\n`);
    return EXIT.error;
  }
};
