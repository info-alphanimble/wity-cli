// `wity` with no arguments: try questions live, in the terminal.
// Loaded only when it's opened, so the one-shot commands never pay for Ink and React.

import { Box, render, Text, useAnimation, useApp, useInput, usePaste, useWindowSize } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Reasoning, SystemOneRequest, SystemOneResponse } from "wity";
import { explain, makeClient } from "./api.ts";
import { systemOneTs } from "./code.ts";
import { choiceQuestion, noulQuestion, scoreQuestion } from "./commands/questions.ts";
import type { Ctx } from "./context.ts";
import { type FoundKey, keyPrefix } from "./credentials.ts";
import { CliError, EXIT, type ExitCode } from "./exit.ts";
import type { Io } from "./io.ts";
import { clean, cleanBlock, cost, type Paint, painter, shouldColor } from "./output.ts";
import { renderAnswer, renderFooter } from "./render.ts";
import { checkStateLength } from "./schema.ts";
import { requireKey } from "./send.ts";

const TYPES = ["noul", "choice", "score"] as const;
type Type = (typeof TYPES)[number];
const REASONINGS = ["off", "auto", "always"] as const;
type Field = "text" | "type" | "question" | "options" | "reasoning";

const LABEL_WIDTH = 13;
const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

type Status =
  | { kind: "idle" }
  | { kind: "running"; started: number }
  | { kind: "done"; res: SystemOneResponse; totalMs: number; instructions: string }
  | { kind: "error"; message: string; hint?: string };

const fieldsFor = (type: Type): Field[] =>
  type === "noul" ? ["text", "type", "question", "reasoning"] : ["text", "type", "question", "options", "reasoning"];

const cycle = <T,>(values: readonly T[], value: T, step: number): T =>
  values[(values.indexOf(value) + step + values.length) % values.length] as T;

/** "billing=Payments; technical=Bugs" → ["billing=Payments", "technical=Bugs"] */
const splitOptions = (value: string): string[] =>
  value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * A one-line text box. Ctrl combinations, Tab and arrows up and down are left to the playground.
 * Pasted text arrives whole (bracketed paste), so a pasted line break never sends the question.
 */
function Input(props: {
  value: string;
  onChange: (value: string) => void;
  focus: boolean;
  placeholder: string;
  multiline?: boolean;
}) {
  const { value, onChange, focus, placeholder, multiline } = props;
  const [cursor, setCursor] = useState(value.length);
  useEffect(() => setCursor((at) => Math.min(at, value.length)), [value]);

  const insert = (text: string) => {
    onChange(value.slice(0, cursor) + text + value.slice(cursor));
    setCursor(cursor + text.length);
  };

  useInput(
    (input, key) => {
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.return || key.escape) return;
      if (key.leftArrow) setCursor(Math.max(0, cursor - 1));
      else if (key.rightArrow) setCursor(Math.min(value.length, cursor + 1));
      else if (key.backspace || key.delete) {
        if (cursor > 0) {
          onChange(value.slice(0, cursor - 1) + value.slice(cursor));
          setCursor(cursor - 1);
        }
      } else if (input) insert(cleanBlock(input).replaceAll("\n", ""));
    },
    { isActive: focus },
  );
  // Pasted text keeps its spaces. Only a one-line box turns line breaks into spaces.
  usePaste((pasted) => insert(multiline ? cleanBlock(pasted) : cleanBlock(pasted).replace(/\s*\n\s*/g, " ")), {
    isActive: focus,
  });

  // Line breaks show as ⏎, so long pasted text stays on one line here. The text itself keeps them.
  const shown = value.replaceAll("\n", "⏎");
  if (!focus) return shown ? <Text>{shown}</Text> : <Text dimColor>{placeholder}</Text>;
  if (!shown) {
    return (
      <Text>
        <Text inverse> </Text>
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }
  return (
    <Text>
      {shown.slice(0, cursor)}
      <Text inverse>{shown[cursor] ?? " "}</Text>
      {shown.slice(cursor + 1)}
    </Text>
  );
}

function Row(props: { label: string; focus: boolean; hint?: string; children: ReactNode }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={LABEL_WIDTH} flexShrink={0}>
          <Text color={props.focus ? "cyan" : undefined} dimColor={!props.focus}>
            {props.focus ? "› " : "  "}
            {props.label}
          </Text>
        </Box>
        <Box flexGrow={1}>{props.children}</Box>
      </Box>
      {props.focus && props.hint ? (
        <Box marginLeft={LABEL_WIDTH}>
          <Text dimColor>{props.hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Choices<T extends string>(props: { values: readonly T[]; value: T; focus: boolean }) {
  return (
    <Text>
      {props.values.map((value) =>
        value === props.value ? (
          <Text key={value} color="cyan" bold inverse={props.focus}>
            {` ${value} `}
          </Text>
        ) : (
          <Text key={value} dimColor>{` ${value} `}</Text>
        ),
      )}
    </Text>
  );
}

function Working({ started }: { started: number }) {
  const { frame } = useAnimation({ interval: 80 });
  const slow = Date.now() - started > 1500;
  return (
    <Text>
      <Text color="cyan">{FRAMES[frame % FRAMES.length]}</Text>
      <Text dimColor>{slow ? " Still working. Wity may be thinking this one through…" : " Asking Wity…"}</Text>
    </Text>
  );
}

export function Playground(props: { ctx: Ctx; found: FoundKey; initialText: string; paint: Paint }) {
  const { ctx, found, paint } = props;
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const [text, setText] = useState(props.initialText);
  const [type, setType] = useState<Type>("noul");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("");
  const [reasoning, setReasoning] = useState<Reasoning>("auto");
  const [focus, setFocus] = useState<Field>(props.initialText ? "question" : "text");
  const [showCode, setShowCode] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [spent, setSpent] = useState({ calls: 0, tokens: 0 });
  const inFlight = useRef<AbortController | null>(null);

  const fields = fieldsFor(type);
  const move = (step: number) => setFocus((at) => cycle(fields, fields.includes(at) ? at : "type", step));

  /** The request as it stands. Throws a CliError that says what's missing. */
  const build = (): SystemOneRequest => {
    if (text.trim() === "") throw new CliError("Type or paste the text to judge first.", EXIT.usage);
    checkStateLength(text);
    const built =
      type === "noul"
        ? noulQuestion(question, undefined, undefined)
        : type === "choice"
          ? choiceQuestion(question, splitOptions(options))
          : scoreQuestion(question, splitOptions(options));
    return { state: text, questions: { answer: built }, reasoning };
  };

  const ask = async () => {
    if (inFlight.current) return;
    let request: SystemOneRequest;
    try {
      request = build();
    } catch (err) {
      const e = err as CliError;
      setStatus({ kind: "error", message: e.message, hint: e.hint });
      return;
    }
    setShowCode(false);
    const controller = new AbortController();
    inFlight.current = controller;
    setStatus({ kind: "running", started: Date.now() });
    // SDK warnings would draw over the screen, so they're dropped here. Errors still show below.
    const quietIo: Io = { ...ctx.io, stderr: { write: () => true } };
    const client = makeClient(found.key, ctx.baseURL, quietIo);
    const started = performance.now();
    try {
      const res = await client.systemOne(request, { signal: AbortSignal.any([controller.signal, ctx.io.signal]) });
      setSpent((s) => ({ calls: s.calls + 1, tokens: s.tokens + res.usage.input_tokens }));
      setStatus({ kind: "done", res, totalMs: performance.now() - started, instructions: question });
    } catch (err) {
      const e = explain(err, found);
      setStatus(
        e instanceof CliError
          ? { kind: "error", message: e.message, hint: e.hint }
          : { kind: "error", message: String(e) },
      );
    } finally {
      inFlight.current = null;
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (inFlight.current) inFlight.current.abort();
      else exit();
    } else if (key.escape) {
      if (showCode) setShowCode(false);
      else exit();
    } else if (key.ctrl && input === "t") setShowCode((shown) => !shown);
    else if (key.tab) move(key.shift ? -1 : 1);
    else if (key.downArrow) move(1);
    else if (key.upArrow) move(-1);
    else if (key.return) void ask();
    else if ((key.leftArrow || key.rightArrow) && (focus === "type" || focus === "reasoning")) {
      const step = key.leftArrow ? -1 : 1;
      if (focus === "type") setType((at) => cycle(TYPES, at, step));
      else setReasoning((at) => cycle(REASONINGS, at, step));
    }
  });

  let code: string | undefined;
  if (showCode) {
    try {
      code = systemOneTs(build(), ctx.baseURL);
    } catch (err) {
      code = `// ${(err as Error).message}`;
    }
  }

  const width = Math.min(columns, 100);
  const optionsHint =
    type === "choice"
      ? "id=description; id=description (2 to 256 options, separated by ;)"
      : "lowest; …; highest (2 to 10 levels, separated by ;)";

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Text>
          <Text color="cyan">◆ </Text>
          <Text bold>wity playground</Text>
        </Text>
        <Text dimColor>
          {keyPrefix(found.key)} · {found.source === "env" ? "WITY_API_KEY" : found.source}
          {spent.calls > 0 ? ` · ${spent.calls} call${spent.calls > 1 ? "s" : ""} ≈ ${cost(spent.tokens)}` : ""}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Row label="Text" focus={focus === "text"} hint="what Wity reads · paste works, line breaks show as ⏎">
          <Input
            value={text}
            onChange={setText}
            focus={focus === "text"}
            placeholder="My card was charged twice…"
            multiline
          />
        </Row>
        <Row label="Type" focus={focus === "type"} hint="← → to change">
          <Choices values={TYPES} value={type} focus={focus === "type"} />
        </Row>
        <Row label="Question" focus={focus === "question"}>
          <Input
            value={question}
            onChange={setQuestion}
            focus={focus === "question"}
            placeholder={type === "noul" ? "Does the customer need this soon?" : "Which team should handle this?"}
          />
        </Row>
        {type !== "noul" ? (
          <Row label={type === "choice" ? "Options" : "Levels"} focus={focus === "options"} hint={optionsHint}>
            <Input
              value={options}
              onChange={setOptions}
              focus={focus === "options"}
              placeholder={type === "choice" ? "billing=Payments; technical=Bugs; other" : "Calm; Annoyed; Angry"}
            />
          </Row>
        ) : null}
        <Row label="Reasoning" focus={focus === "reasoning"} hint="← → to change · auto thinks only when needed">
          <Choices values={REASONINGS} value={reasoning} focus={focus === "reasoning"} />
        </Row>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>⏎ ask · tab next · ctrl+t {showCode ? "hide" : "show"} code · esc quit</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {code !== undefined ? (
          <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
            <Text dimColor>TypeScript · npm install wity</Text>
            <Text>{code}</Text>
          </Box>
        ) : status.kind === "running" ? (
          <Working started={status.started} />
        ) : status.kind === "error" ? (
          <Box flexDirection="column">
            <Text>
              <Text color="red">✗ </Text>
              {status.message}
            </Text>
            {status.hint ? <Text dimColor>{`  ${status.hint}`}</Text> : null}
          </Box>
        ) : status.kind === "done" ? (
          <Box flexDirection="column">
            <Text bold>{clean(status.instructions)}</Text>
            {status.res.answers.answer ? (
              <Text>{["", ...renderAnswer(status.res.answers.answer, paint, width), ""].join("\n")}</Text>
            ) : null}
            <Text>{renderFooter(status.res, status.totalMs, paint)}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

export const playground = async (ctx: Ctx, initialText: string): Promise<ExitCode> => {
  const { io } = ctx;
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw new CliError("The playground needs a terminal.", EXIT.usage, "In scripts, use noul, choice, score or ask.");
  }
  const found = await requireKey(ctx);
  const paint = painter(shouldColor(io.env, io.stdout));
  const app = render(<Playground ctx={ctx} found={found} initialText={initialText} paint={paint} />, {
    stdin: io.stdin as NodeJS.ReadStream,
    stdout: io.stdout as NodeJS.WriteStream,
    stderr: io.stderr as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await app.waitUntilExit();
  return EXIT.ok;
};
