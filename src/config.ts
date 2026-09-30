// Where the CLI talks to.

import { DEFAULT_BASE_URL } from "wity";
import { CliError, EXIT } from "./exit.ts";

/** The website, where people sign in and manage keys. */
export const CONSOLE_URL = "https://wity.alphanimble.com";
export const KEYS_PAGE = `${CONSOLE_URL}/console/keys`;
export const BILLING_PAGE = `${CONSOLE_URL}/console/billing`;

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
