// What every command gets: the terminal, the API address, the key store and the colour functions.

import { DEFAULT_BASE_URL } from "wity-sdk";
import { OLD_BASE_URL, resolveBaseURL } from "./config.ts";
import { moveKey, openStore, type Store } from "./credentials.ts";
import type { Io } from "./io.ts";
import { type Paint, painter, shouldColor } from "./output.ts";

export interface Ctx {
  io: Io;
  baseURL: string;
  /** Opened on first use, so commands that don't need the keychain never touch it. */
  store: () => Promise<Store>;
  /** Colours for stdout and for stderr. Each is off when its stream isn't a terminal. */
  out: Paint;
  err: Paint;
}

/**
 * Opens the store and, on the default address, moves a key saved under the old one.
 * The notice goes to stderr, so stdout stays clean for JSON and for `wity mcp serve`.
 */
const openAndMove = async (io: Io, baseURL: string): Promise<Store> => {
  const store = await openStore(io.env);
  if (baseURL === DEFAULT_BASE_URL && (await moveKey(store, OLD_BASE_URL, baseURL))) {
    io.stderr.write(
      `[wity] Notice: the Wity API has moved to ${baseURL}.\n` +
        "[wity] Your saved API key was moved to the new address. No action is needed.\n",
    );
  }
  return store;
};

export const makeCtx = (io: Io, baseUrlFlag: string | undefined): Ctx => {
  const baseURL = resolveBaseURL(baseUrlFlag, io.env);
  let opened: Promise<Store> | undefined;
  return {
    io,
    baseURL,
    store: () => {
      opened ??= openAndMove(io, baseURL);
      return opened;
    },
    out: painter(shouldColor(io.env, io.stdout)),
    err: painter(shouldColor(io.env, io.stderr)),
  };
};
