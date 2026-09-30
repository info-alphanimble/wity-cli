// Exit codes are a promise to scripts. Don't renumber them.

export const EXIT = {
  ok: 0,
  /** The API, the network or something else failed. */
  error: 1,
  /** Bad flags or bad input. Nothing was sent, or Wity refused the request (400). Nothing was billed. */
  usage: 2,
  /** No key, or the key was refused. */
  auth: 3,
  /** The answer came back, but it failed `--fail-under` or `--expect`. */
  gate: 10,
  /** Ctrl+C. */
  cancelled: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error meant for the person at the terminal. `message` is printed as is, so write it for them. */
export class CliError extends Error {
  override name = "CliError";
  readonly code: ExitCode;
  /** One extra line on what to do next. */
  readonly hint: string | undefined;

  constructor(message: string, code: ExitCode = EXIT.error, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}
