// wity api-key set, wity api-key show, wity api-key remove.

import { DEFAULT_BASE_URL } from "wity-sdk";
import { checkKey, refusedHint } from "../api.ts";
import { KEYS_PAGE } from "../config.ts";
import type { Ctx } from "../context.ts";
import { findKey, keyPrefix, type SavedVia } from "../credentials.ts";
import { CliError, EXIT, type ExitCode } from "../exit.ts";
import { readHidden, readStdin } from "../input.ts";
import { ms, spinner, writeJson } from "../output.ts";

/** Printable characters only, no spaces. The SDK refuses anything else. */
const KEY_PATTERN = /^[\x21-\x7E]+$/;

const envWarning = (ctx: Ctx, text: string): void => {
  if (ctx.io.env.WITY_API_KEY?.trim()) ctx.io.stderr.write(`  ${ctx.err("yellow", "▲")} ${text}\n\n`);
};

/** Shown only when it isn't the usual address, so people notice they're pointed somewhere else. */
const addressLine = (ctx: Ctx): string =>
  ctx.baseURL === DEFAULT_BASE_URL ? "" : `    ${ctx.err("dim", "API".padEnd(9))} ${ctx.baseURL}\n`;

const when = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

// ---------------------------------------------------------------------------
// key set
// ---------------------------------------------------------------------------

export interface SetKeyOptions {
  stdin?: boolean;
}

/**
 * Check the key with the free /v1/models call, then save it. A key saved before is replaced.
 * The key comes from the command line, stdin (--stdin), or a hidden prompt, in that order.
 */
export const setKey = async (ctx: Ctx, opts: SetKeyOptions, given?: string): Promise<ExitCode> => {
  const { io } = ctx;
  if (given !== undefined && opts.stdin) {
    throw new CliError("Give the key on the command line or with --stdin, not both.", EXIT.usage);
  }
  const via: SavedVia = given !== undefined ? "argument" : opts.stdin ? "token" : "paste";
  let key: string;
  if (via === "argument") {
    key = (given ?? "").trim();
  } else if (via === "token") {
    if (io.stdin.isTTY) {
      throw new CliError(
        "--stdin reads the key from stdin.",
        EXIT.usage,
        "Pipe it in: wity api-key set --stdin < key.txt",
      );
    }
    key = (await readStdin(io.stdin)).trim();
  } else {
    io.stderr.write(`\n  ${ctx.err("bold", "Save your Wity API key")}\n\n`);
    io.stderr.write(`  Create a key at ${ctx.err("cyan", KEYS_PAGE)} and paste it below.\n`);
    io.stderr.write(`  ${ctx.err("dim", "Nothing shows while you paste. Press Enter when done.")}\n\n`);
    key = (await readHidden(io, "  API key: ")).trim();
  }

  if (!key) throw new CliError("No key was given.", EXIT.usage);
  if (!KEY_PATTERN.test(key)) {
    throw new CliError(
      "The key has spaces or unusual characters.",
      EXIT.usage,
      "Check that you copied the whole key and nothing else.",
    );
  }

  const stop = spinner(io, "Checking the key…", "Still checking the key…");
  let check: Awaited<ReturnType<typeof checkKey>>;
  try {
    check = await checkKey(key, ctx.baseURL, io);
  } finally {
    stop();
  }
  if (check.status === 401) {
    throw new CliError(
      "Wity refused this key.",
      EXIT.auth,
      "Check that you copied all of it, and that it hasn't been revoked.",
    );
  }
  if (check.status !== 200) throw new CliError(`Couldn't check the key. Wity answered ${check.status}.`, EXIT.error);

  const store = await ctx.store();
  await store.set({ key, baseURL: ctx.baseURL, savedAt: new Date().toISOString(), via });

  io.stderr.write(`\n  ${ctx.err("green", "✓")} ${ctx.err("bold", "Saved.")} The key works.\n\n`);
  io.stderr.write(`    ${ctx.err("dim", "Key".padEnd(9))} ${keyPrefix(key)}\n`);
  io.stderr.write(`    ${ctx.err("dim", "Saved in")}  ${store.location}\n`);
  io.stderr.write(addressLine(ctx));
  io.stderr.write("\n");
  envWarning(ctx, "WITY_API_KEY is set in this shell, and it wins over the saved key. Unset it to use the saved one.");
  return EXIT.ok;
};

// ---------------------------------------------------------------------------
// key remove
// ---------------------------------------------------------------------------

/** Remove the saved key from this computer. The key itself keeps working until it's revoked on the website. */
export const removeKey = async (ctx: Ctx): Promise<ExitCode> => {
  const { io } = ctx;
  const p = ctx.err;
  const store = await ctx.store();
  if (!(await store.delete(ctx.baseURL))) {
    io.stderr.write(
      `\n  There's no saved key on this computer${ctx.baseURL === DEFAULT_BASE_URL ? "" : ` for ${ctx.baseURL}`}.\n\n`,
    );
    envWarning(ctx, "WITY_API_KEY is set in this shell, so commands keep using it. Remove it with: unset WITY_API_KEY");
    return EXIT.ok;
  }
  io.stderr.write(`\n  ${p("green", "✓")} ${p("bold", "Removed the key")} from ${store.location}.\n`);
  io.stderr.write(`    ${p("dim", `It still works until you revoke it at ${KEYS_PAGE}`)}\n\n`);
  envWarning(
    ctx,
    "WITY_API_KEY is still set in this shell, so commands keep using it. Remove it with: unset WITY_API_KEY",
  );
  return EXIT.ok;
};

// ---------------------------------------------------------------------------
// key show
// ---------------------------------------------------------------------------

export const showKey = async (ctx: Ctx, opts: { json?: boolean }): Promise<ExitCode> => {
  const { io } = ctx;
  const found = await findKey(ctx.baseURL, io.env, ctx.store);
  if (!found) throw new CliError("No API key found.", EXIT.auth, "Run `wity api-key set`, or set WITY_API_KEY.");

  // A network problem shouldn't hide what we know. The status then says it couldn't be checked.
  const stop = opts.json ? () => {} : spinner(io, "Checking the key…", "Still checking the key…");
  let check: Awaited<ReturnType<typeof checkKey>> | undefined;
  let problem: string | undefined;
  try {
    check = await checkKey(found.key, ctx.baseURL, io);
  } catch (err) {
    if (!(err instanceof CliError) || err.code === EXIT.cancelled) throw err;
    problem = err.message;
  } finally {
    stop();
  }
  const works = check ? check.status === 200 : undefined;

  if (opts.json || !io.stdout.isTTY) {
    writeJson(io, {
      api: ctx.baseURL,
      key: keyPrefix(found.key),
      source: found.source,
      location: found.location,
      saved_at: found.saved?.savedAt || null,
      works: works ?? null,
    });
  } else {
    const p = ctx.out;
    const line = (label: string, value: string) => io.stdout.write(`    ${p("dim", label.padEnd(9))} ${value}\n`);
    const dot = works === true ? p("green", "●") : works === false ? p("red", "●") : p("yellow", "●");
    const title = works === false ? "The key was refused" : "Wity API key";

    io.stdout.write(`\n  ${dot} ${p("bold", title)}\n\n`);
    line("Key", keyPrefix(found.key));
    line("From", `${found.location}${found.saved?.savedAt ? ` · saved ${when(found.saved.savedAt)}` : ""}`);
    line("API", ctx.baseURL);
    line(
      "Status",
      works === true
        ? `${p("green", "works")} ${p("dim", `· checked in ${ms(check?.ms ?? 0)}`)}`
        : works === false
          ? p("red", "refused")
          : p("yellow", `not checked: ${problem ?? "no answer"}`),
    );
    io.stdout.write("\n");
    if (works === false) io.stdout.write(`  ${p("dim", refusedHint(found))}\n\n`);
  }

  if (works === false) return EXIT.auth;
  if (works === undefined) return EXIT.error;
  return EXIT.ok;
};
