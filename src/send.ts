// Sending a request with the saved key: the spinner, the timing, and plain-English errors.

import type { GenerateRequest, GenerateResponse, SystemOneRequest, SystemOneResponse } from "wity";
import { explain, makeClient } from "./api.ts";
import type { Ctx } from "./context.ts";
import { type FoundKey, findKey } from "./credentials.ts";
import { CliError, EXIT } from "./exit.ts";
import { spinner } from "./output.ts";

export const requireKey = async (ctx: Ctx): Promise<FoundKey> => {
  const found = await findKey(ctx.baseURL, ctx.io.env, ctx.store);
  if (!found) throw new CliError("No API key found.", EXIT.auth, "Run `wity api-key set`, or set WITY_API_KEY.");
  return found;
};

export const sendSystemOne = async (
  ctx: Ctx,
  request: SystemOneRequest,
): Promise<{ res: SystemOneResponse; totalMs: number }> => {
  const found = await requireKey(ctx);
  const client = makeClient(found.key, ctx.baseURL, ctx.io);
  const stop = spinner(ctx.io, "Asking Wity…", "Still working. Wity may be thinking this one through…");
  const started = performance.now();
  try {
    const res = await client.systemOne(request, { signal: ctx.io.signal });
    return { res, totalMs: performance.now() - started };
  } catch (err) {
    throw explain(err, found);
  } finally {
    stop();
  }
};

export const sendGenerate = async (
  ctx: Ctx,
  request: GenerateRequest,
): Promise<{ res: GenerateResponse; totalMs: number }> => {
  const found = await requireKey(ctx);
  const client = makeClient(found.key, ctx.baseURL, ctx.io);
  const stop = spinner(ctx.io, "Writing…", "Still writing…");
  const started = performance.now();
  try {
    const res = await client.generate(request, { signal: ctx.io.signal });
    return { res, totalMs: performance.now() - started };
  } catch (err) {
    throw explain(err, found);
  } finally {
    stop();
  }
};
