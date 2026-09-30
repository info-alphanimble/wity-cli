// Everything a command reads from or writes to, in one object.
// The real one wraps `process`. Tests pass their own, so no test touches the real terminal or environment.

export interface Input extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface Output {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface Io {
  env: Record<string, string | undefined>;
  stdin: Input;
  stdout: Output;
  stderr: Output;
  /** Aborted on Ctrl+C, so a call in flight stops at once. */
  signal: AbortSignal;
}

export const processIo = (signal: AbortSignal): Io => ({
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  signal,
});
