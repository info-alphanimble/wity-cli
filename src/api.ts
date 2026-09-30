// The link between the CLI and the Wity SDK.

import { format } from "node:util";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InsufficientBalanceError,
  type LogLevel,
  RateLimitError,
  WityClient,
  WityError,
} from "wity-sdk";
import { BILLING_PAGE } from "./config.ts";
import type { FoundKey } from "./credentials.ts";
import { CliError, EXIT } from "./exit.ts";
import type { Io } from "./io.ts";
import { clean } from "./output.ts";

/** How long the CLI's own checks (health, key) wait. API calls use the SDK's timeouts. */
const CHECK_TIMEOUT_MS = 15_000;

/**
 * A client for `baseURL`. The SDK checks the address here: https only, plain http only for localhost.
 * Its log lines go to stderr, so stdout stays clean for JSON.
 */
export const makeClient = (key: string, baseURL: string, io: Io): WityClient => {
  try {
    return new WityClient({
      apiKey: key,
      baseURL,
      logLevel: io.env.WITY_LOG_LEVEL?.trim() ? (io.env.WITY_LOG_LEVEL.trim() as LogLevel) : undefined,
      logger: {
        debug: (message, ...args) => io.stderr.write(`${format(`[wity] ${message}`, ...args)}\n`),
        info: (message, ...args) => io.stderr.write(`${format(`[wity] ${message}`, ...args)}\n`),
        warn: (message, ...args) => io.stderr.write(`${format(`[wity] ${message}`, ...args)}\n`),
        error: (message, ...args) => io.stderr.write(`${format(`[wity] ${message}`, ...args)}\n`),
      },
    });
  } catch (err) {
    if (err instanceof WityError) throw new CliError(err.message, EXIT.usage);
    throw err;
  }
};

export interface Check {
  status: number;
  ms: number;
}

/**
 * A GET that never follows redirects, so a key only goes to the address it was meant for.
 * Throws a CliError if the address can't be reached.
 */
const get = async (url: string, io: Io, key?: string): Promise<Check> => {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      redirect: "manual",
      signal: AbortSignal.any([io.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]),
    });
    await response.body?.cancel();
    return { status: response.status, ms: performance.now() - started };
  } catch (err) {
    if (io.signal.aborted) throw new CliError("Cancelled.", EXIT.cancelled);
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new CliError(
      timedOut ? `No answer from Wity within ${CHECK_TIMEOUT_MS / 1000} s.` : "Couldn't reach Wity.",
      EXIT.error,
      "Check your internet connection. `wity doctor` runs a full check.",
    );
  }
};

/** GET /health. Needs no key. */
export const checkHealth = (baseURL: string, io: Io): Promise<Check> => get(`${baseURL}/health`, io);

/**
 * GET /v1/models with the key. 200 means the key works, 401 means it was refused.
 * This call isn't billed, so it's safe to run on every `api-key set` and `api-key show`.
 */
export const checkKey = (key: string, baseURL: string, io: Io): Promise<Check> => {
  // Made only to run the SDK's checks on the address and key before the key is sent anywhere.
  const client = makeClient(key, baseURL, io);
  return get(`${client.baseURL}/v1/models`, io, key);
};

/** What to do when a key is refused, depending on where it came from. */
export const refusedHint = (found: Pick<FoundKey, "source">): string =>
  found.source === "env"
    ? "The key comes from WITY_API_KEY. Check it, or unset it to use the key saved by `wity api-key set`."
    : "It may have been revoked. Run `wity api-key set` to save a new key.";

/** Turn an SDK error into a message and exit code for the terminal. */
export const explain = (err: unknown, found: Pick<FoundKey, "source">): unknown => {
  if (!(err instanceof WityError)) return err;
  const id = err instanceof APIError && err.requestId ? ` Request id: ${clean(err.requestId)}` : "";

  if (err instanceof AuthenticationError)
    return new CliError("Wity refused the API key.", EXIT.auth, refusedHint(found));
  if (err instanceof InsufficientBalanceError) {
    return new CliError("Your Wity balance has run out.", EXIT.error, `Add credits at ${BILLING_PAGE}`);
  }
  if (err instanceof BadRequestError) {
    return new CliError(`Wity refused the request: ${clean(err.message)}`, EXIT.usage, `Nothing was billed.${id}`);
  }
  if (err instanceof RateLimitError) {
    return new CliError("Too many requests at once for this key.", EXIT.error, `Wait a moment and try again.${id}`);
  }
  if (err instanceof APIUserAbortError) return new CliError("Cancelled.", EXIT.cancelled);
  if (err instanceof APITimeoutError) {
    return new CliError(
      "Wity didn't answer in time.",
      EXIT.error,
      "Try again, or set --max-latency to cap thinking time.",
    );
  }
  if (err instanceof APIConnectionError) {
    return new CliError(
      "Couldn't reach Wity.",
      EXIT.error,
      "Check your internet connection. `wity doctor` runs a full check.",
    );
  }
  if (err instanceof APIError)
    return new CliError(`Wity answered with an error: ${clean(err.message)}`, EXIT.error, id.trim() || undefined);
  return new CliError(clean(err.message), EXIT.usage);
};
