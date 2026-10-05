// Where the CLI talks to.

import { DEFAULT_BASE_URL } from "wity-sdk";
import { CliError, EXIT } from "./exit.ts";

/** The website, where people sign in and manage keys. */
export const CONSOLE_URL = "https://wity.alphanimble.com";
export const KEYS_PAGE = `${CONSOLE_URL}/console/keys`;
export const BILLING_PAGE = `${CONSOLE_URL}/console/billing`;

/**
 * Where the API lived before it moved to api.wity.alphanimble.com (SDK 0.1.1).
 * Keys saved by CLI 0.1.0 are filed under it, so they're moved to the new address on first use.
 * Both addresses reach the same server, so moving the key doesn't send it anywhere new.
 */
export const OLD_BASE_URL: string = "https://wity-proxy-production-2c33.up.railway.app";

/** Dollars per million input tokens, from wity.alphanimble.com/pricing. Output and thinking are free. */
export const PRICE_PER_MILLION_INPUT_USD = 0.042;

/**
 * The API address: `--base-url`, then WITY_BASE_URL, then the SDK's default.
 * Returned in the same form the SDK uses (no trailing slash), because saved keys are filed under it.
 * The SDK does the full check (https only, no user or password) when the client is made.
 */
export const resolveBaseURL = (flag: string | undefined, env: Record<string, string | undefined>): string => {
  const raw = flag?.trim() || env.WITY_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The URL isn't repeated, in case a key was pasted into it by mistake.
    throw new CliError("The API address is not a valid URL. Check --base-url or WITY_BASE_URL.", EXIT.usage);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};
