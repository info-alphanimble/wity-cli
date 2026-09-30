// What every command gets: the terminal, the API address, the key store and the colour functions.

import { resolveBaseURL } from "./config.ts";
import { openStore, type Store } from "./credentials.ts";
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

export const makeCtx = (io: Io, baseUrlFlag: string | undefined): Ctx => {
  const baseURL = resolveBaseURL(baseUrlFlag, io.env);
  let opened: Promise<Store> | undefined;
  return {
    io,
    baseURL,
    store: () => {
      opened ??= openStore(io.env);
      return opened;
    },
    out: painter(shouldColor(io.env, io.stdout)),
    err: painter(shouldColor(io.env, io.stderr)),
  };
};
