// wity doctor: check everything the CLI needs, one line each.

import { DEFAULT_BASE_URL } from "wity";
import { checkHealth, checkKey, refusedHint } from "../api.ts";
import type { Ctx } from "../context.ts";
import { type FoundKey, findKey, keyPrefix } from "../credentials.ts";
import { CliError, EXIT, type ExitCode } from "../exit.ts";
import { ms, writeJson } from "../output.ts";

type State = "ok" | "fail" | "skip";

interface Result {
  name: string;
  state: State;
  detail: string;
  hint?: string;
}

/** A CliError becomes a failed check. Anything else is a bug and is thrown. */
const attempt = async (name: string, run: () => Promise<Result>): Promise<Result> => {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof CliError) || err.code === EXIT.cancelled) throw err;
    return { name, state: "fail", detail: err.message, hint: err.hint };
  }
};

export const doctor = async (ctx: Ctx, opts: { json?: boolean }): Promise<ExitCode> => {
  const { io } = ctx;
  const pretty = !opts.json && Boolean(io.stdout.isTTY);
  const p = ctx.out;
  const results: Result[] = [];

  const show = (result: Result) => {
    results.push(result);
    if (!pretty) return;
    const mark = result.state === "ok" ? p("green", "✓") : result.state === "fail" ? p("red", "✗") : p("dim", "–");
    io.stdout.write(
      `  ${mark} ${result.name.padEnd(15)} ${result.state === "skip" ? p("dim", result.detail) : result.detail}\n`,
    );
    if (result.hint) io.stdout.write(`    ${" ".repeat(15)} ${p("dim", result.hint)}\n`);
  };

  if (pretty) io.stdout.write(`\n  ${p("bold", "Wity doctor")}\n\n`);

  show({ name: "Node.js", state: "ok", detail: process.versions.node });
  show({
    name: "API address",
    state: "ok",
    detail: ctx.baseURL === DEFAULT_BASE_URL ? ctx.baseURL : `${ctx.baseURL} (custom)`,
  });
  show(
    await attempt("Key storage", async () => {
      const store = await ctx.store();
      return { name: "Key storage", state: "ok", detail: store.location };
    }),
  );

  const health = await attempt("Wity reachable", async () => {
    const check = await checkHealth(ctx.baseURL, io);
    return check.status === 200
      ? { name: "Wity reachable", state: "ok", detail: `answered in ${ms(check.ms)}` }
      : { name: "Wity reachable", state: "fail", detail: `the health check answered ${check.status}` };
  });
  show(health);

  let found: FoundKey | undefined;
  /** No key, or a key Wity refused. Exits with the auth code, so scripts can tell it from a network problem. */
  let authProblem = false;
  const key = await attempt("API key", async () => {
    found = await findKey(ctx.baseURL, io.env, ctx.store);
    authProblem = !found;
    return found
      ? { name: "API key", state: "ok", detail: `${keyPrefix(found.key)} from ${found.location}` }
      : {
          name: "API key",
          state: "fail",
          detail: "no key found",
          hint: "Run `wity api-key set`, or set WITY_API_KEY.",
        };
  });
  show(key);

  const using = found;
  const accepted =
    using && health.state === "ok"
      ? await attempt("Key accepted", async () => {
          const check = await checkKey(using.key, ctx.baseURL, io);
          authProblem = check.status === 401;
          return check.status === 200
            ? { name: "Key accepted", state: "ok", detail: `yes, checked in ${ms(check.ms)}` }
            : check.status === 401
              ? { name: "Key accepted", state: "fail", detail: "no, Wity refused it", hint: refusedHint(using) }
              : { name: "Key accepted", state: "fail", detail: `couldn't tell, Wity answered ${check.status}` };
        })
      : ({ name: "Key accepted", state: "skip", detail: "skipped" } as Result);
  show(accepted);

  const failed = results.filter((result) => result.state === "fail");
  if (opts.json || !io.stdout.isTTY) writeJson(io, { ok: failed.length === 0, checks: results });
  else
    io.stdout.write(
      `\n  ${failed.length === 0 ? p("green", "All good.") : p("red", `${failed.length} check${failed.length > 1 ? "s" : ""} failed.`)}\n\n`,
    );

  if (failed.length === 0) return EXIT.ok;
  if (authProblem) return EXIT.auth;
  return EXIT.error;
};
