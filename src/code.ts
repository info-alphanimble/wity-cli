// --code: the same request as TypeScript (with the SDK) and as curl, to copy into your own project.
// The key is always $WITY_API_KEY in the output, never the real one.

import { DEFAULT_BASE_URL, type GenerateRequest, type Question, type SystemOneRequest } from "wity-sdk";
import type { Ctx } from "./context.ts";
import { CliError, EXIT } from "./exit.ts";

export type CodeLang = "ts" | "curl";

/** A string as a JavaScript literal. JSON's escaping is valid JavaScript, and safe for any text. */
const str = (value: string): string => JSON.stringify(value);

/** An object key: bare when it's a plain identifier, quoted otherwise. */
const prop = (key: string): string => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : str(key));

/** A JSON value as JavaScript, indented to sit at `indent`. */
const literal = (value: unknown, indent: string): string =>
  JSON.stringify(value, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : indent + line))
    .join("\n")
    .replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:");

const builder = (question: Question, indent: string): string => {
  if (question.type === "noul") {
    return question.criteria
      ? `noul(${str(question.instructions)}, ${literal(question.criteria, indent)})`
      : `noul(${str(question.instructions)})`;
  }
  if (question.type === "choice") {
    const options = Object.entries(question.criteria)
      .map(([id, description]) => `${indent}  ${prop(id)}: ${str(description)},`)
      .join("\n");
    return `choice(${str(question.instructions)}, {\n${options}\n${indent}})`;
  }
  const levels = question.criteria.map(str);
  const inline = `[${levels.join(", ")}]`;
  return inline.length <= 80
    ? `score(${str(question.instructions)}, ${inline})`
    : `score(${str(question.instructions)}, [\n${levels.map((level) => `${indent}  ${level},`).join("\n")}\n${indent}])`;
};

const clientLine = (baseURL: string): string =>
  baseURL === DEFAULT_BASE_URL
    ? "const client = new WityClient(); // reads WITY_API_KEY"
    : `const client = new WityClient({ baseURL: ${str(baseURL)} }); // reads WITY_API_KEY`;

export const systemOneTs = (request: SystemOneRequest, baseURL: string): string => {
  const types = [...new Set(Object.values(request.questions).map((q) => q.type))].sort();
  const questions = Object.entries(request.questions)
    .map(([name, question]) => `    ${prop(name)}: ${builder(question, "    ")},`)
    .join("\n");
  const extras = [
    request.reasoning && `  reasoning: ${str(request.reasoning)},`,
    request.max_latency_ms !== undefined && `  max_latency_ms: ${request.max_latency_ms},`,
  ].filter(Boolean);
  const first = Object.entries(request.questions)[0];
  const field = first?.[1].type === "noul" ? "noul" : first?.[1].type === "choice" ? "choice" : "score";
  return [
    `import { WityClient, ${types.join(", ")} } from "wity-sdk";`,
    "",
    clientLine(baseURL),
    "",
    "const res = await client.systemOne({",
    `  state: ${literal(request.state, "  ")},`,
    "  questions: {",
    questions,
    "  },",
    ...extras,
    "});",
    "",
    first ? `console.log(res.answers.${prop(first[0])}.${field});` : "console.log(res.answers);",
  ].join("\n");
};

export const generateTs = (request: GenerateRequest, baseURL: string): string => {
  const fields = [
    request.state !== undefined && `  state: ${literal(request.state, "  ")},`,
    `  instructions: ${str(request.instructions)},`,
    request.shape !== undefined && `  shape: ${literal(request.shape, "  ")},`,
    request.max_tokens !== undefined && `  max_tokens: ${request.max_tokens},`,
  ].filter(Boolean);
  return [
    `import { WityClient } from "wity-sdk";`,
    "",
    clientLine(baseURL),
    "",
    "const res = await client.generate({",
    ...fields,
    "});",
    "",
    request.shape !== undefined ? "console.log(res.value);" : "console.log(res.text);",
  ].join("\n");
};

/**
 * A curl command. The body goes in a quoted heredoc, so the shell never expands anything in it.
 * JSON strings can't hold a raw line break, so no line of the body can end the heredoc early.
 */
export const curl = (route: string, body: object, baseURL: string): string =>
  [
    `curl ${baseURL}${route} \\`,
    `  -H "Authorization: Bearer $WITY_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    "  -d @- <<'JSON'",
    JSON.stringify(body, null, 2),
    "JSON",
  ].join("\n");

/** `--code`, `--code ts` or `--code curl`. Commander gives `true` for the bare flag. */
export const codeLangs = (value: string | boolean | undefined): CodeLang[] | undefined => {
  if (value === undefined || value === false) return undefined;
  if (value === true) return ["ts", "curl"];
  if (value === "ts" || value === "curl") return [value];
  throw new CliError("--code takes ts or curl, or nothing for both.", EXIT.usage);
};

export const printCode = (ctx: Ctx, langs: CodeLang[], ts: string, sh: string): void => {
  const { io } = ctx;
  const pretty = Boolean(io.stdout.isTTY);
  const show = (title: string, code: string) => {
    if (pretty) io.stdout.write(`\n  ${ctx.out("dim", title)}\n\n`);
    io.stdout.write(`${code}\n`);
  };
  if (langs.includes("ts")) show("TypeScript · npm install wity-sdk", ts);
  if (langs.includes("curl")) show("curl", sh);
  if (pretty) io.stdout.write(`\n  ${ctx.out("dim", "Nothing was sent. Set WITY_API_KEY before running this.")}\n\n`);
};
