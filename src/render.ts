// How answers look on a terminal.
// Every string that came from the API or from a file goes through `clean` before it's printed.

import type { ChoiceAnswer, NoulAnswer, ReasoningInfo, ScoreAnswer, SystemOneResponse } from "wity-sdk";
import { bar, clean, cost, decimal, ms, type Paint, pct, truncate } from "./output.ts";

/** Choice answers with more options than this show the top ones, and say how many are hidden. */
const MAX_ROWS = 10;
const MAX_LABEL = 28;

const barWidth = (columns: number | undefined): number => (columns !== undefined && columns < 72 ? 14 : 28);

interface Row {
  label: string;
  p: number;
  winner: boolean;
  /** Shown before the label, like a score level's number. */
  tag?: string;
}

const rows = (items: Row[], paint: Paint, columns: number | undefined): string[] => {
  const width = barWidth(columns);
  const labelWidth = Math.max(...items.map((row) => row.label.length));
  const tagWidth = Math.max(0, ...items.map((row) => row.tag?.length ?? 0));
  return items.map((row) => {
    const mark = row.winner ? paint("green", "●") : " ";
    const tag = row.tag !== undefined ? `${paint("dim", row.tag.padStart(tagWidth))}  ` : "";
    const label = row.label.padEnd(labelWidth);
    const value = pct(row.p).padStart(7);
    return `  ${mark} ${tag}${row.winner ? paint("bold", label) : label}  ${bar(row.p, width, paint, row.winner ? "green" : "gray")}  ${row.winner ? paint("bold", value) : paint("dim", value)}`;
  });
};

const REASONS: Record<string, string> = {
  close_call: "the top options were close",
  order_sensitive: "the answer changed when the options were reordered",
  forecast: "the question asks for a likelihood",
  requested: "reasoning was set to always",
};

/** A note when Wity thought before answering, with the answer it had before thinking. */
const thinking = (info: ReasoningInfo | undefined, before: string | undefined, paint: Paint): string[] => {
  const lines: string[] = [];
  if (info?.thought) {
    const why = info.reason ? (REASONS[info.reason] ?? clean(info.reason).replaceAll("_", " ")) : undefined;
    const tokens = info.thought_tokens ? ` ${info.thought_tokens.toLocaleString("en")} thought tokens.` : "";
    lines.push(
      `  ${paint("magenta", "◆")} ${paint("dim", `Wity thought first${why ? `, because ${why}` : ""}.${tokens}`)}`,
    );
    if (before) lines.push(`    ${paint("dim", `Before thinking: ${before}`)}`);
  }
  if (info?.budget_limited) lines.push(`  ${paint("yellow", "▲ Thinking was cut short to meet --max-latency.")}`);
  return lines;
};

const topOf = (probabilities: Record<string, number>): string =>
  Object.entries(probabilities).reduce((best, entry) => (entry[1] > best[1] ? entry : best), ["", -1] as [
    string,
    number,
  ])[0];

export const renderNoul = (answer: NoulAnswer, paint: Paint, columns?: number): string[] => {
  const yes = answer.noul;
  const lines = rows(
    [
      { label: "yes", p: yes, winner: yes >= 0.5 },
      { label: "no", p: 1 - yes, winner: yes < 0.5 },
    ],
    paint,
    columns,
  );
  const before = answer.direct_noul !== undefined ? `yes ${pct(answer.direct_noul)}` : undefined;
  return [...lines, ...spaced(thinking(answer.reasoning, before, paint))];
};

export const renderChoice = (answer: ChoiceAnswer, paint: Paint, columns?: number): string[] => {
  const sorted = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, MAX_ROWS);
  const lines = rows(
    shown.map(([id, p]) => ({ label: truncate(clean(id), MAX_LABEL), p, winner: id === answer.choice })),
    paint,
    columns,
  );
  if (sorted.length > shown.length) {
    lines.push(`    ${paint("dim", `and ${sorted.length - shown.length} more options. Use --json to see all.`)}`);
  }
  lines.push("", `  ${paint("dim", `confidence ${decimal(answer.confidence)}`)}`);
  const direct = answer.direct_probabilities;
  const top = direct && topOf(direct);
  const before = direct && top ? `${truncate(clean(top), MAX_LABEL)} ${pct(direct[top] ?? 0)}` : undefined;
  return [...lines, ...spaced(thinking(answer.reasoning, before, paint))];
};

export const renderScore = (answer: ScoreAnswer, paint: Paint, columns?: number): string[] => {
  const levels = Object.keys(answer.legend).sort((a, b) => Number(a) - Number(b));
  const top = topOf(answer.probabilities);
  const name = (level: string | undefined) => truncate(clean(answer.legend[level ?? ""] ?? ""), MAX_LABEL);
  const low = levels[0];
  const high = levels[levels.length - 1];
  const head = `  ${paint("bold", answer.score.toFixed(2))}  ${paint("dim", `on a scale from ${low} (${name(low)}) to ${high} (${name(high)})`)}`;
  const lines = rows(
    levels.map((level) => ({
      tag: level,
      label: name(level),
      p: answer.probabilities[level] ?? 0,
      winner: level === top,
    })),
    paint,
    columns,
  );
  const direct = answer.direct_probabilities;
  const before = direct
    ? `score ${Object.entries(direct)
        .reduce((sum, [level, p]) => sum + Number(level) * p, 0)
        .toFixed(2)}`
    : undefined;
  return [
    head,
    "",
    ...lines,
    "",
    `  ${paint("dim", `confidence ${decimal(answer.confidence)}`)}`,
    ...spaced(thinking(answer.reasoning, before, paint)),
  ];
};

/** Any answer, by its type. */
export const renderAnswer = (
  answer: ChoiceAnswer | NoulAnswer | ScoreAnswer,
  paint: Paint,
  columns?: number,
): string[] =>
  answer.type === "noul"
    ? renderNoul(answer, paint, columns)
    : answer.type === "choice"
      ? renderChoice(answer, paint, columns)
      : renderScore(answer, paint, columns);

/** A blank line before a block, if there is a block. */
const spaced = (lines: string[]): string[] => (lines.length > 0 ? ["", ...lines] : []);

/** The last line: model, time on Wity, total time, tokens and estimated cost. */
export const renderFooter = (res: SystemOneResponse, totalMs: number, paint: Paint): string => {
  const parts = [
    clean(res.model),
    `${ms(res.metadata.elapsed_ms)} on Wity`,
    `${ms(totalMs)} total`,
    `${res.usage.input_tokens.toLocaleString("en")} input tokens`,
    `≈ ${cost(res.usage.input_tokens)}`,
  ];
  return `  ${paint("dim", parts.join(" · "))}`;
};
