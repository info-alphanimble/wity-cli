// The shape of questions, checked before anything is sent. Used by `wity ask -f` and by the MCP tools.
// It follows the API's own shape (type, instructions, criteria), so a file matches the API docs and --dry-run output.
// Limits are from wity.alphanimble.com/docs/limits.

import { z } from "zod";
import { CliError, EXIT } from "./exit.ts";
import { MAX_STATE_CHARS } from "./input.ts";

const text = z.string().trim().min(1, "can't be empty");

export const noulSchema = z.strictObject({
  type: z.literal("noul"),
  instructions: text,
  criteria: z.strictObject({ true: text, false: text }).optional(),
});

export const choiceSchema = z.strictObject({
  type: z.literal("choice"),
  instructions: text,
  criteria: z
    .record(z.string().trim().min(1, "option ids can't be empty"), z.string())
    .refine(
      (options) => Object.keys(options).length >= 2 && Object.keys(options).length <= 256,
      "needs 2 to 256 options",
    ),
});

export const scoreSchema = z.strictObject({
  type: z.literal("score"),
  instructions: text,
  criteria: z.array(text).min(2, "needs 2 to 10 levels").max(10, "needs 2 to 10 levels"),
});

export const questionSchema = z.discriminatedUnion("type", [noulSchema, choiceSchema, scoreSchema]);

export const questionsSchema = z
  .record(z.string().trim().min(1, "question names can't be empty").max(64), questionSchema)
  .refine((questions) => Object.keys(questions).length > 0, "needs at least one question");

/** Text, or an object or array that Wity reads as JSON. */
export const stateSchema = z.union([text, z.record(z.string(), z.json()), z.array(z.json())]);

export const reasoningSchema = z.enum(["off", "auto", "always"]);

/** A `wity ask -f` file. `state` is optional there: it can come from --text, --file or a pipe instead. */
export const askFileSchema = z.strictObject({
  state: stateSchema.optional(),
  questions: questionsSchema,
  reasoning: reasoningSchema.optional(),
  max_latency_ms: z.number().int().min(200).max(120_000).optional(),
});

/** State length as Wity counts it: characters of the text, or of the JSON for an object. */
export const stateLength = (state: unknown): number =>
  typeof state === "string" ? Array.from(state).length : JSON.stringify(state).length;

export const checkStateLength = (state: unknown): void => {
  const length = stateLength(state);
  if (length > MAX_STATE_CHARS) {
    throw new CliError(
      `The state is ${length.toLocaleString("en")} characters. Wity reads at most ${MAX_STATE_CHARS.toLocaleString("en")}.`,
      EXIT.usage,
    );
  }
};

/** Zod's issues as one line each: "questions.team.criteria: needs 2 to 256 options". */
export const describeIssues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "(file)"}: ${issue.message}`).join("\n    ");
