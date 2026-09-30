import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsPath, findKey, keyPrefix, openStore } from "../src/credentials.ts";
import { CliError, EXIT } from "../src/exit.ts";
import { GOOD_KEY, tempConfig } from "./helpers.ts";

const A = "https://api.example.com";
const B = "https://other.example.com";

const saved = (key: string, baseURL = A) => ({
  key,
  baseURL,
  savedAt: "2026-09-30T10:00:00.000Z",
  via: "paste" as const,
});

describe("file store", () => {
  it("saves a key readable only by this user, in a private folder", async () => {
    const env = tempConfig();
    const store = await openStore(env);
    await store.set(saved(GOOD_KEY));

    const path = credentialsPath(env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(await store.get(A)).toEqual(saved(GOOD_KEY));
  });

  it("files keys by API address, so a key never goes to another address", async () => {
    const env = tempConfig();
    const store = await openStore(env);
    await store.set(saved(GOOD_KEY, A));
    expect(await store.get(B)).toBeUndefined();
    expect(await findKey(B, env, async () => store)).toBeUndefined();
  });

  it("refuses a file that other users can read", async () => {
    const env = tempConfig();
    const store = await openStore(env);
    await store.set(saved(GOOD_KEY));
    chmodSync(credentialsPath(env), 0o644);

    const err = await store.get(A).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(EXIT.auth);
    expect((err as CliError).hint).toContain("chmod 600");
  });

  it("refuses a folder that other users can write to", async () => {
    const env = tempConfig();
    const path = credentialsPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o777);
    const store = await openStore(env);
    await expect(store.set(saved(GOOD_KEY))).rejects.toThrow(/Other users can access the credentials folder/);
  });

  it("refuses a symbolic link in place of the file", async () => {
    const env = tempConfig();
    const path = credentialsPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const elsewhere = join(dirname(path), "elsewhere.json");
    writeFileSync(elsewhere, "{}", { mode: 0o600 });
    symlinkSync(elsewhere, path);
    const store = await openStore(env);
    await expect(store.get(A)).rejects.toThrow(/symbolic link/);
  });

  it("reports a damaged file instead of guessing", async () => {
    const env = tempConfig();
    const path = credentialsPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "not json", { mode: 0o600 });
    const store = await openStore(env);
    await expect(store.get(A)).rejects.toThrow(/damaged/);
  });

  it("removes one address's key, and the file with the last one", async () => {
    const env = tempConfig();
    const store = await openStore(env);
    await store.set(saved(GOOD_KEY, A));
    await store.set(saved(GOOD_KEY, B));

    expect(await store.delete(A)).toBe(true);
    expect(await store.delete(A)).toBe(false);
    expect(JSON.parse(readFileSync(credentialsPath(env), "utf8"))).toHaveProperty([B]);

    expect(await store.delete(B)).toBe(true);
    expect(() => statSync(credentialsPath(env))).toThrow();
  });
});

describe("findKey", () => {
  it("prefers WITY_API_KEY over a saved key, and says so", async () => {
    const env = { ...tempConfig(), WITY_API_KEY: "wity_from_env_000000000000000000" };
    const store = await openStore(env);
    await store.set(saved(GOOD_KEY));
    const found = await findKey(A, env, async () => store);
    expect(found?.source).toBe("env");
    expect(found?.key).toBe("wity_from_env_000000000000000000");
  });

  it("doesn't open the store when WITY_API_KEY is set", async () => {
    let opened = false;
    await findKey(A, { WITY_API_KEY: GOOD_KEY }, async () => {
      opened = true;
      throw new Error("should not open");
    });
    expect(opened).toBe(false);
  });

  it("rejects an unknown WITY_CREDENTIAL_STORE", async () => {
    await expect(openStore({ WITY_CREDENTIAL_STORE: "cloud" })).rejects.toThrow(/auto, keychain or file/);
  });
});

describe("keyPrefix", () => {
  it("shows 9 characters of a console key", () => {
    expect(keyPrefix(GOOD_KEY)).toBe("wity_Test…");
  });

  it("shows only 4 characters of a short key", () => {
    expect(keyPrefix("abcdefghijkl")).toBe("abcd…");
  });
});
