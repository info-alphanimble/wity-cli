// Reading what the person gives the CLI: the text to judge, and a key typed or piped in.

import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { CliError, EXIT } from "./exit.ts";
import type { Input, Io } from "./io.ts";

/** Wity reads at most this many characters of state. From wity.alphanimble.com/docs/limits. */
export const MAX_STATE_CHARS = 32_000;

/** `split` and `extract` read longer documents, up to this many characters. */
export const MAX_DOC_CHARS = 60_000;

/** Stop reading input past this size. Far above what Wity accepts, and small enough to keep in memory. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

const tooBig = () =>
  new CliError(
    `The input is over ${MAX_READ_BYTES / 1024 / 1024} MB. Wity reads at most ${MAX_STATE_CHARS} characters.`,
    EXIT.usage,
  );

/** Everything on stdin, as text. */
export const readStdin = async (stdin: Input): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_READ_BYTES) throw tooBig();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export interface StateFlags {
  text?: string;
  file?: string;
}

/** The text to judge: `--text`, `--file` (`-` is stdin), or piped in. Exactly one of them. */
export const readState = async (flags: StateFlags, io: Io, max: number = MAX_STATE_CHARS): Promise<string> => {
  if (flags.text !== undefined && flags.file !== undefined) {
    throw new CliError("Give the text with --text or --file, not both.", EXIT.usage);
  }

  let text: string;
  if (flags.text !== undefined) {
    text = flags.text;
  } else if (flags.file !== undefined && flags.file !== "-") {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(flags.file);
    } catch {
      throw new CliError(`Can't read the file ${flags.file}`, EXIT.usage);
    }
    if (!info.isFile()) throw new CliError(`${flags.file} is not a file.`, EXIT.usage);
    if (info.size > MAX_READ_BYTES) throw tooBig();
    text = await readFile(flags.file, "utf8");
  } else if (flags.file === "-" || !io.stdin.isTTY) {
    text = await readStdin(io.stdin);
  } else {
    throw new CliError(
      "No text to judge.",
      EXIT.usage,
      'Pass it with --text "...", --file path, or pipe it in: cat email.txt | wity noul "Is this spam?"',
    );
  }

  text = text.replace(/^﻿/, ""); // a byte-order mark some editors add
  if (text.trim() === "") throw new CliError("The text to judge is empty.", EXIT.usage);
  // Counted in characters, not UTF-16 units, so emoji count once.
  const length = Array.from(text).length;
  if (length > max) {
    throw new CliError(
      `The text is ${length.toLocaleString("en")} characters. Wity reads at most ${max.toLocaleString("en")}.`,
      EXIT.usage,
    );
  }
  return text;
};

/**
 * Ask a yes-or-no question on the terminal. Only "y" or "yes" is a yes. Ctrl+C cancels.
 * The question goes to stderr, so stdout stays clean.
 */
export const confirm = (io: Io, question: string): Promise<boolean> => {
  io.stderr.write(`  ${question} [y/N] `);
  const lines = createInterface({ input: io.stdin });
  return new Promise((resolve, reject) => {
    const finish = (answer: boolean | Error) => {
      lines.removeAllListeners();
      lines.close();
      io.signal.removeEventListener("abort", onAbort);
      if (answer instanceof Error) reject(answer);
      else resolve(answer);
    };
    const onAbort = () => finish(new CliError("Cancelled.", EXIT.cancelled));
    lines.once("line", (line) => finish(/^y(es)?$/i.test(line.trim())));
    lines.once("close", () => finish(false));
    io.signal.addEventListener("abort", onAbort, { once: true });
  });
};

/**
 * Before deleting: `--yes` goes ahead. On a terminal, ask. Anywhere else, refuse, so a script never deletes by accident.
 * Returns false when the person says no.
 */
export const confirmDelete = async (io: Io, what: string, yes: boolean | undefined): Promise<boolean> => {
  if (yes) return true;
  if (!io.stdin.isTTY) {
    throw new CliError(`Deleting ${what} needs --yes when there's no terminal to ask.`, EXIT.usage);
  }
  return confirm(io, `Delete ${what}? This can't be undone.`);
};

/**
 * Ask for a secret on the terminal without showing it. Nothing is echoed, not even dots.
 * Ctrl+C cancels. Escape sequences (arrow keys, bracketed paste markers) are skipped.
 */
export const readHidden = (io: Io, prompt: string): Promise<string> => {
  const { stdin } = io;
  if (!stdin.isTTY || !stdin.setRawMode) {
    return Promise.reject(
      new CliError(
        "There's no terminal to type the key into.",
        EXIT.usage,
        "Pipe it in instead: wity api-key set --stdin < key.txt",
      ),
    );
  }
  io.stderr.write(prompt);
  const setRawMode = stdin.setRawMode.bind(stdin);
  setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    let inEscape = false;

    const finish = (err?: Error) => {
      stdin.off("data", onData);
      setRawMode(false);
      stdin.pause();
      io.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };

    const onData = (chunk: string | Buffer) => {
      for (const ch of String(chunk)) {
        if (inEscape) {
          // An escape sequence ends with a letter or ~ (ESC [ 2 0 0 ~ is the start of a paste).
          if (/[A-Za-z~]/.test(ch)) inEscape = false;
          continue;
        }
        if (ch === "\x1b") inEscape = true;
        else if (ch === "\r" || ch === "\n" || ch === "\x04") return finish();
        else if (ch === "\x03") return finish(new CliError("Cancelled.", EXIT.cancelled));
        else if (ch === "\x7f" || ch === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (ch >= " ") value += ch;
      }
    };

    stdin.on("data", onData);
  });
};
