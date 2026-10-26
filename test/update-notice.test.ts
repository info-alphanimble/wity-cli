import { afterEach, describe, expect, it, vi } from "vitest";
import { isNewer, nodeUpdateDeps, type UpdateState, updateNotice } from "../src/update-notice.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A fake clock, cache file and npm. `latest` is what npm reports. */
const fakeDeps = (latest: string | undefined, start: UpdateState | undefined = undefined) => {
  const clock = { now: 1_000_000 };
  let saved = start;
  const fetchLatest = vi.fn(async () => latest);
  return {
    clock,
    fetchLatest,
    saved: () => saved,
    deps: {
      now: () => clock.now,
      read: () => saved,
      write: (state: UpdateState) => {
        saved = { ...state };
      },
      fetchLatest,
    },
  };
};

const notice = (deps: ReturnType<typeof fakeDeps>["deps"], current = "0.2.0") =>
  updateNotice("wity-cli", current, "npm install -g wity-cli", deps);

/** Lets the background check finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("updateNotice", () => {
  it("checks npm on the first run, shows nothing yet, and saves what it found", async () => {
    const fake = fakeDeps("0.3.0");
    expect(notice(fake.deps)).toBeUndefined();
    expect(fake.fetchLatest).toHaveBeenCalledTimes(1);
    await settle();
    expect(fake.saved()).toMatchObject({ latest: "0.3.0", checkedAt: 1_000_000, triedAt: 1_000_000 });
  });

  it("shows the notice on the next run, from what the last check found", async () => {
    const fake = fakeDeps("0.3.0");
    notice(fake.deps);
    await settle();
    fake.clock.now += 60_000;
    expect(notice(fake.deps)).toBe(
      "\n  wity-cli 0.3.0 is out. You have 0.2.0.\n  Update with: npm install -g wity-cli\n\n",
    );
  });

  it("checks npm at most once a day", async () => {
    const fake = fakeDeps("0.3.0");
    notice(fake.deps);
    await settle();
    fake.clock.now += DAY - 1;
    notice(fake.deps);
    expect(fake.fetchLatest).toHaveBeenCalledTimes(1);
    fake.clock.now += 1;
    notice(fake.deps);
    expect(fake.fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("tries a check that was cut short again after an hour, not sooner", () => {
    const fake = fakeDeps("0.3.0");
    fake.fetchLatest.mockReturnValue(new Promise(() => {}));
    notice(fake.deps);
    fake.clock.now += HOUR - 1;
    notice(fake.deps);
    expect(fake.fetchLatest).toHaveBeenCalledTimes(1);
    fake.clock.now += 1;
    notice(fake.deps);
    expect(fake.fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("counts a check where npm didn't answer, so npm isn't asked again that day", async () => {
    const fake = fakeDeps(undefined);
    notice(fake.deps);
    await settle();
    fake.clock.now += 2 * HOUR;
    notice(fake.deps);
    expect(fake.fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("shows the notice at most once a day", () => {
    const fake = fakeDeps("0.3.0", { latest: "0.3.0", checkedAt: 1_000_000 });
    expect(notice(fake.deps)).toContain("0.3.0 is out");
    expect(notice(fake.deps)).toBeUndefined();
    fake.clock.now += DAY;
    expect(notice(fake.deps)).toContain("0.3.0 is out");
  });

  it("stays quiet when you have the newest version", () => {
    const fake = fakeDeps("0.2.0", { latest: "0.2.0", checkedAt: 1_000_000 });
    expect(notice(fake.deps)).toBeUndefined();
  });

  it("stays quiet when npm can't be reached, and keeps what it knew", async () => {
    const fake = fakeDeps(undefined, { latest: "0.2.0", checkedAt: 1_000_000 - DAY });
    notice(fake.deps);
    await settle();
    expect(fake.saved()?.latest).toBe("0.2.0");
  });

  it("never throws, even when the cache can't be read", () => {
    const fake = fakeDeps("0.3.0");
    const deps = {
      ...fake.deps,
      read: () => {
        throw new Error("broken");
      },
    };
    expect(notice(deps)).toBeUndefined();
  });
});

describe("isNewer", () => {
  it.each([
    ["0.3.0", "0.2.0", true],
    ["0.2.1", "0.2.0", true],
    ["1.0.0", "0.9.9", true],
    ["0.10.0", "0.9.0", true],
    ["0.2.0", "0.2.0", false],
    ["0.1.9", "0.2.0", false],
    ["0.3.0-beta.1", "0.2.0", false],
    ["0.2.0", "0.2.0-beta.1", true],
    ["nonsense", "0.2.0", false],
  ])("%s over %s is %s", (latest, current, expected) => {
    expect(isNewer(latest, current)).toBe(expected);
  });
});

describe("nodeUpdateDeps", () => {
  const was = { stdout: process.stdout.isTTY, stderr: process.stderr.isTTY };
  const atTerminal = (on: boolean) => {
    process.stdout.isTTY = on;
    process.stderr.isTTY = on;
  };

  afterEach(() => {
    process.stdout.isTTY = was.stdout;
    process.stderr.isTTY = was.stderr;
  });

  it("runs at a terminal", () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("WITY_NO_UPDATE_CHECK", "");
    atTerminal(true);
    expect(nodeUpdateDeps("wity-cli")).toBeDefined();
  });

  it("is off with WITY_NO_UPDATE_CHECK", () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("WITY_NO_UPDATE_CHECK", "1");
    atTerminal(true);
    expect(nodeUpdateDeps("wity-cli")).toBeUndefined();
  });

  it("is off in CI", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("WITY_NO_UPDATE_CHECK", "");
    atTerminal(true);
    expect(nodeUpdateDeps("wity-cli")).toBeUndefined();
  });

  it("is off when output is piped", () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("WITY_NO_UPDATE_CHECK", "");
    atTerminal(false);
    expect(nodeUpdateDeps("wity-cli")).toBeUndefined();
  });
});
