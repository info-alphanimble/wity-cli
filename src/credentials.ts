// Where the API key is kept between runs.
//
// The OS keychain when there is one: macOS Keychain, Windows Credential Manager, or the Secret Service on Linux.
// The keyring package calls the keychain directly, so the key is never a command-line argument that other
// processes could read. Without a keychain, a JSON file that only this user can read (0600, in a 0700 folder).
// WITY_CREDENTIAL_STORE=keychain or =file picks one. The default, auto, prefers the keychain.
//
// Each key is filed under the API address it was saved for. A key saved for one address is never sent to another.

import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, EXIT } from "./exit.ts";

const SERVICE = "wity-cli";

/** How the key arrived: on the command line, typed or pasted at the prompt, or piped in with --stdin. */
export type SavedVia = "argument" | "paste" | "token";

export interface Saved {
  key: string;
  baseURL: string;
  /** ISO time. */
  savedAt: string;
  via: SavedVia;
}

export type StoreKind = "keychain" | "file";

export interface Store {
  kind: StoreKind;
  /** For people: "macOS Keychain", or the file's path. */
  location: string;
  get(baseURL: string): Promise<Saved | undefined>;
  set(saved: Saved): Promise<void>;
  /** `true` if there was a key to remove. */
  delete(baseURL: string): Promise<boolean>;
}

type Env = Record<string, string | undefined>;

/** Checks a stored record, so a hand-edited or broken one is reported instead of used. */
const parseSaved = (value: unknown, baseURL: string): Saved | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { key, savedAt, via } = value as Record<string, unknown>;
  if (typeof key !== "string" || key === "") return undefined;
  return {
    key,
    baseURL,
    savedAt: typeof savedAt === "string" ? savedAt : "",
    via: via === "argument" || via === "token" ? via : "paste",
  };
};

/** What goes into the keychain or the file. The address is the entry's name, so it isn't repeated inside. */
const record = ({ key, savedAt, via }: Saved) => ({ key, savedAt, via });

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

const KEYCHAIN_NAMES: Record<string, string> = {
  darwin: "macOS Keychain",
  win32: "Windows Credential Manager",
  linux: "the Secret Service keyring",
};

/** The keychain store, or `undefined` if this machine doesn't have a working one. */
const keychainStore = async (): Promise<Store | undefined> => {
  let AsyncEntry: typeof import("@napi-rs/keyring").AsyncEntry;
  try {
    ({ AsyncEntry } = await import("@napi-rs/keyring"));
  } catch {
    return undefined; // no build of the native module for this platform
  }
  // On Linux, the kernel keyring is the fallback and forgets keys at logout. Only the Secret Service persists.
  const options = { linux: { store: "secret-service" as const } };
  const entry = (baseURL: string) => new AsyncEntry(SERVICE, baseURL, options);

  // A read that finds nothing is harmless. It fails when there's no keychain service (for example a server).
  try {
    await entry("probe").getPassword();
  } catch {
    return undefined;
  }

  return {
    kind: "keychain",
    location: KEYCHAIN_NAMES[process.platform] ?? "the system keychain",
    async get(baseURL) {
      const raw = await entry(baseURL).getPassword();
      if (raw === undefined) return undefined;
      try {
        return parseSaved(JSON.parse(raw), baseURL);
      } catch {
        return undefined;
      }
    },
    async set(saved) {
      await entry(saved.baseURL).setPassword(JSON.stringify(record(saved)));
    },
    async delete(baseURL) {
      return entry(baseURL).deletePassword();
    },
  };
};

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------

/** `~/.config/wity/credentials.json`, or under XDG_CONFIG_HOME or APPDATA when set. */
export const credentialsPath = (env: Env): string => {
  const base =
    env.XDG_CONFIG_HOME?.trim() ||
    (process.platform === "win32" && env.APPDATA?.trim()) ||
    join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "wity", "credentials.json");
};

/** POSIX permission checks. Windows files don't carry these modes, so it relies on the profile folder's ACLs. */
const checkPrivate = async (path: string, what: "file" | "folder"): Promise<boolean> => {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (process.platform === "win32") return true;
  if (info.isSymbolicLink()) {
    throw new CliError(`The credentials ${what} is a symbolic link, so it isn't used: ${path}`, EXIT.auth);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new CliError(`The credentials ${what} belongs to another user, so it isn't used: ${path}`, EXIT.auth);
  }
  // The file must not be readable by others. The folder must not be writable by others, who could swap the file.
  const loose = what === "file" ? info.mode & 0o077 : info.mode & 0o022;
  if (loose) {
    const fix = what === "file" ? `chmod 600 "${path}"` : `chmod 700 "${path}"`;
    throw new CliError(
      `Other users can access the credentials ${what}, so it isn't used: ${path}`,
      EXIT.auth,
      `Fix it with: ${fix}`,
    );
  }
  return true;
};

const fileStore = (env: Env): Store => {
  const path = credentialsPath(env);
  const folder = dirname(path);

  const readAll = async (): Promise<Record<string, unknown>> => {
    if (!(await checkPrivate(path, "file"))) return {};
    try {
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof data === "object" && data !== null && !Array.isArray(data)) return data as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new CliError(
      `The credentials file is damaged: ${path}`,
      EXIT.auth,
      "Delete it and run `wity api-key set` again.",
    );
  };

  const writeAll = async (data: Record<string, unknown>): Promise<void> => {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await checkPrivate(folder, "folder");
    // Write a new file, then swap it in. The file is private from the moment it exists.
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await rename(temp, path);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  };

  return {
    kind: "file",
    location: path,
    async get(baseURL) {
      return parseSaved((await readAll())[baseURL], baseURL);
    },
    async set(saved) {
      const all = await readAll();
      all[saved.baseURL] = record(saved);
      await writeAll(all);
    },
    async delete(baseURL) {
      const all = await readAll();
      if (!(baseURL in all)) return false;
      delete all[baseURL];
      if (Object.keys(all).length === 0) await rm(path, { force: true });
      else await writeAll(all);
      return true;
    },
  };
};

// ---------------------------------------------------------------------------
// Choosing a store, and finding the key
// ---------------------------------------------------------------------------

export const openStore = async (env: Env): Promise<Store> => {
  const wanted = (env.WITY_CREDENTIAL_STORE ?? "auto").trim().toLowerCase() || "auto";
  if (!["auto", "keychain", "file"].includes(wanted)) {
    throw new CliError("WITY_CREDENTIAL_STORE must be auto, keychain or file.", EXIT.usage);
  }
  if (wanted === "file") return fileStore(env);
  const keychain = await keychainStore();
  if (keychain) return keychain;
  if (wanted === "keychain") {
    throw new CliError(
      "No working keychain was found on this machine.",
      EXIT.auth,
      "Unset WITY_CREDENTIAL_STORE to save the key in a private file instead.",
    );
  }
  return fileStore(env);
};

export type KeySource = "env" | StoreKind;

export interface FoundKey {
  key: string;
  source: KeySource;
  /** For people: where the key came from. */
  location: string;
  /** Only for a saved key. */
  saved?: Saved;
}

/** WITY_API_KEY wins over a saved key, like in the SDK. `wity api-key show` says which one is in use. */
export const findKey = async (
  baseURL: string,
  env: Env,
  store: () => Promise<Store>,
): Promise<FoundKey | undefined> => {
  const fromEnv = env.WITY_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env", location: "the WITY_API_KEY environment variable" };
  const opened = await store();
  const saved = await opened.get(baseURL);
  return saved && { key: saved.key, source: opened.kind, location: opened.location, saved };
};

/**
 * What's safe to show of a key: its first 9 characters, like the console's key list ("wity_Ab12…").
 * Console keys are 48 characters. A short, unusual key shows only 4, so most of it stays hidden.
 */
export const keyPrefix = (key: string): string => `${key.slice(0, key.length >= 24 ? 9 : 4)}…`;
