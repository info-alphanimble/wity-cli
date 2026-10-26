// Tells someone at a terminal when a newer version of this package is on npm.
//
// - Only when both stdout and stderr are terminals, and not in CI. Servers, pipes and scripts never see it.
// - Checks npm at most once a day, in the background. Nothing ever waits for the check.
//   A check cut short because the program exited first is tried again after an hour.
// - Shows the notice at most once a day, on stderr, from what an earlier check found.
// - WITY_NO_UPDATE_CHECK=1 turns it off. Every Wity package reads the same variable.

import type * as Https from "node:https";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CHECK_TIMEOUT_MS = 5000;

/** What's kept between runs, in one small file per package. */
export interface UpdateState {
  /** When a check last finished, in ms, whether or not npm answered. */
  checkedAt?: number;
  /** When a check last started, in ms. */
  triedAt?: number;
  /** The newest version npm reported. */
  latest?: string;
  /** When the notice was last shown, in ms. */
  shownAt?: number;
}

/** Everything the notice touches, so tests can fake the clock, the file and npm. */
export interface UpdateDeps {
  now: () => number;
  read: () => UpdateState | undefined;
  write: (state: UpdateState) => void;
  /** Resolves to the newest version on npm, or undefined if npm couldn't be reached. */
  fetchLatest: () => Promise<string | undefined>;
}

/**
 * Starts a check if the last one was over a day ago, and returns the notice to show, if one is due.
 * Never throws and never waits: a broken cache file or a failed check just means no notice.
 */
export const updateNotice = (
  name: string,
  current: string,
  updateCommand: string,
  deps: UpdateDeps,
): string | undefined => {
  try {
    const now = deps.now();
    const state = deps.read() ?? {};
    let notice: string | undefined;
    if (state.latest !== undefined && isNewer(state.latest, current) && !within(state.shownAt, now, DAY_MS)) {
      notice = `\n  ${name} ${state.latest} is out. You have ${current}.\n  Update with: ${updateCommand}\n\n`;
      state.shownAt = now;
    }
    if (!within(state.checkedAt, now, DAY_MS) && !within(state.triedAt, now, HOUR_MS)) {
      state.triedAt = now;
      deps
        .fetchLatest()
        .catch(() => undefined)
        .then((latest) => {
          // Finished, so it counts for the day even when npm didn't answer. Keep what an earlier check found.
          const saved = deps.read() ?? state;
          deps.write({ ...saved, checkedAt: deps.now(), ...(latest && { latest }) });
        })
        .catch(() => {});
    }
    deps.write(state);
    return notice;
  } catch {
    return undefined;
  }
};

const within = (then: number | undefined, now: number, ms: number): boolean =>
  then !== undefined && now - then >= 0 && now - then < ms;

/** True when `latest` is a later release than `current`. Pre-releases on npm never count as newer. */
export const isNewer = (latest: string, current: string): boolean => {
  const parse = (version: string) => /^(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(version.trim());
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b || a[4]) return false;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff > 0;
  }
  // Same numbers: a release is newer than the pre-release you have.
  return b[4] !== undefined;
};

/**
 * The real clock, cache file and npm, on Node. Undefined when the notice shouldn't run here:
 * turned off, in CI, not at a terminal, or not on Node (or on a Node too old for getBuiltinModule).
 */
export const nodeUpdateDeps = (name: string): UpdateDeps | undefined => {
  const proc = typeof process === "undefined" ? undefined : process;
  const env = proc?.env ?? {};
  if (env.WITY_NO_UPDATE_CHECK?.trim() || env.CI?.trim()) return undefined;
  if (!proc?.stdout?.isTTY || !proc.stderr?.isTTY) return undefined;
  if (typeof proc.getBuiltinModule !== "function") return undefined;

  // getBuiltinModule instead of import, so bundlers for other runtimes never see a Node module.
  const fs = proc.getBuiltinModule("node:fs");
  const path = proc.getBuiltinModule("node:path");
  const os = proc.getBuiltinModule("node:os");
  const https = proc.getBuiltinModule("node:https");

  const base =
    env.XDG_CACHE_HOME?.trim() ||
    (proc.platform === "win32" && env.LOCALAPPDATA?.trim()) ||
    path.join(env.HOME?.trim() || os.homedir(), ".cache");
  const file = path.join(base, "wity", `update-npm-${name}.json`);

  return {
    now: () => Date.now(),
    read: () => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as UpdateState;
      } catch {
        return undefined;
      }
    },
    write: (state) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state));
      } catch {
        // A read-only home folder just means no notice.
      }
    },
    fetchLatest: () => fetchLatestFromNpm(https, name),
  };
};

const fetchLatestFromNpm = (https: typeof Https, name: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
      { agent: false, timeout: CHECK_TIMEOUT_MS, headers: { accept: "application/json" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const version = (JSON.parse(body) as { version?: unknown }).version;
            resolve(res.statusCode === 200 && typeof version === "string" ? version : undefined);
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    // An unref'd socket never keeps the program running. If it exits first, the check just didn't finish.
    req.on("socket", (socket) => socket.unref());
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
  });

const shown = new Set<string>();

/** Checks once per process per package, and prints a due notice to stderr. Safe to call on every client. */
export const showUpdateNoticeOnce = (name: string, current: string, updateCommand: string): void => {
  if (shown.has(name)) return;
  shown.add(name);
  const deps = nodeUpdateDeps(name);
  if (!deps) return;
  const notice = updateNotice(name, current, updateCommand, deps);
  if (notice) process.stderr.write(notice);
};
