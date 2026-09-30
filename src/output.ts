// Drawing for the terminal: colours, bars, numbers and the spinner.
// Colours use Node's own styleText. No colour package.

import { stripVTControlCharacters, styleText } from "node:util";
import { PRICE_PER_MILLION_INPUT_USD } from "./config.ts";
import type { Io, Output } from "./io.ts";

type Style = Parameters<typeof styleText>[0];
export type Paint = (style: Style, text: string) => string;

/** NO_COLOR and TERM=dumb turn colour off. FORCE_COLOR turns it on. Otherwise only on a terminal. */
export const shouldColor = (env: Io["env"], stream: Output): boolean => {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
};

export const painter =
  (on: boolean): Paint =>
  (style, text) =>
    on ? styleText(style, text, { validateStream: false }) : text;

/** Spinners and other redrawing. Off in CI and when output isn't a terminal. */
export const canAnimate = (io: Io, stream: Output): boolean => Boolean(stream.isTTY) && !io.env.CI;

/** An OSC sequence (window title, hyperlink): ESC ] ... ended by BEL or ESC \. Node's strip leaves its text behind. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

/**
 * Text from the API or from a file, made safe for one line of a terminal.
 * Escape codes and control characters are removed, so text can't move the cursor, change colours or fake output.
 */
export const clean = (text: string): string =>
  stripVTControlCharacters(text.replace(OSC, ""))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim();

/** Like `clean`, for text of many lines: line breaks and tabs stay, everything else that could act on a terminal goes. */
export const cleanBlock = (text: string): string =>
  stripVTControlCharacters(text.replace(OSC, ""))
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === "\n" || ch === "\t" ? ch : ""));

/** Shorten to `max` characters, with an ellipsis. */
export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * A probability as a percentage with 2 decimals.
 * Values that would print as 0.00% or 100.00% print as <0.01% or >99.99%, so nothing looks certain when it isn't.
 */
export const pct = (p: number): string => {
  if (p <= 0) return "0%";
  if (p >= 1) return "100%";
  if (p < 0.00005) return "<0.01%";
  if (p >= 0.99995) return ">99.99%";
  return `${(p * 100).toFixed(2)}%`;
};

const PARTS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** A bar `width` cells wide, filled in eighths of a cell. */
export const bar = (p: number, width: number, paint: Paint, style: Style): string => {
  const eighths = Math.round(Math.min(1, Math.max(0, p)) * width * 8);
  const full = Math.floor(eighths / 8);
  const part = PARTS[eighths % 8] ?? "";
  const filled = "█".repeat(full) + part;
  const empty = width - full - (part ? 1 : 0);
  return (filled ? paint(style, filled) : "") + (empty > 0 ? paint("dim", "·".repeat(empty)) : "");
};

/** A 0–1 value like confidence, with 3 decimals. Like `pct`, it never rounds to exactly 0 or 1. */
export const decimal = (value: number): string => {
  if (value > 0 && value < 0.0005) return "<0.001";
  if (value < 1 && value >= 0.9995) return ">0.999";
  return value.toFixed(3);
};

/** Estimated cost of `tokens` input tokens, like "$0.000012". The bill itself is worked out by Wity. */
export const cost = (tokens: number): string => {
  const usd = (tokens * PRICE_PER_MILLION_INPUT_USD) / 1_000_000;
  if (usd === 0) return "$0";
  const decimals = usd >= 0.01 ? 2 : -Math.floor(Math.log10(usd)) + 1;
  return `$${usd.toFixed(decimals)}`;
};

export const ms = (value: number): string =>
  value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;

export const writeJson = (io: Io, value: unknown): void => {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/**
 * A spinner on stderr while a call runs. After `slowAfterMs` the text changes to `slowText`, if given.
 * `text` can be a function, for a label that changes, like a countdown.
 * Returns a function that clears it. Does nothing when stderr isn't a terminal or in CI.
 */
export const spinner = (io: Io, text: string | (() => string), slowText?: string, slowAfterMs = 1500): (() => void) => {
  if (!canAnimate(io, io.stderr)) return () => {};
  const paint = painter(shouldColor(io.env, io.stderr));
  const started = Date.now();
  let frame = 0;
  const draw = () => {
    const label = slowText && Date.now() - started > slowAfterMs ? slowText : typeof text === "string" ? text : text();
    io.stderr.write(`\r\x1b[2K  ${paint("cyan", FRAMES[frame++ % FRAMES.length] ?? "")} ${paint("dim", label)}`);
  };
  io.stderr.write("\x1b[?25l"); // hide the cursor
  draw();
  const timer = setInterval(draw, 80);
  return () => {
    clearInterval(timer);
    io.stderr.write("\r\x1b[2K\x1b[?25h");
  };
};
