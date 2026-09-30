import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { Io } from "../src/io.ts";
import { main } from "../src/main.ts";

/** A made-up key in the shape of a console key. Tests check that it never shows up in any output. */
export const GOOD_KEY = "wity_TestKey0123456789abcdefghijklmnopqrstuvwxyzAB";
export const BAD_KEY = "wity_RevokedKey0123456789abcdefghijklmnopqrstuvwxy";

/** A real API response, copied from the SDK's test/fixtures (captured from the live API). */
export const fixture = (name: string): { status: number; body: Record<string, unknown> } =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

export interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/**
 * A fake Wity API on 127.0.0.1. /health and /v1/models behave like the real ones.
 * /v1/systemone answers with `next` (a fixture), re-keyed to the question name the CLI sent.
 */
export const fakeWity = async () => {
  const seen: Seen[] = [];
  let next: Reply = fixture("noul");
  let nextGenerate: Reply = fixture("generate-text");
  let modelsReply: Reply | undefined;

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : undefined;
  };

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = req.url ?? "";
    seen.push({ method: req.method ?? "", path, authorization: req.headers.authorization, body });
    const send = ({ status, body: out, headers }: Reply) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(out === undefined ? "" : JSON.stringify(out));
    };

    if (path === "/health") return send({ status: 200, body: { status: "ok", model: "wity-1" } });
    if (path === "/v1/models") {
      if (modelsReply) return send(modelsReply);
      return req.headers.authorization === `Bearer ${GOOD_KEY}`
        ? send({
            status: 200,
            body: { object: "list", data: [{ id: "wity-1", object: "model", created: 0, owned_by: "alphanimble" }] },
          })
        : send(fixture("error-bad-key"));
    }
    if (path === "/v1/systemone") {
      if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) return send(fixture("error-bad-key"));
      const reply = structuredClone(next);
      const answers = (reply.body as { answers?: Record<string, unknown> } | undefined)?.answers;
      if (answers) {
        // The fixture's answers, in order, under the names the CLI asked with.
        const values = Object.values(answers);
        const names = Object.keys((body as { questions: object }).questions);
        (reply.body as { answers: Record<string, unknown> }).answers = Object.fromEntries(
          names.map((name, i) => [name, values[Math.min(i, values.length - 1)]]),
        );
      }
      return send(reply);
    }
    if (path === "/v1/generate") {
      if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) return send(fixture("error-bad-key"));
      return send(nextGenerate);
    }
    send({ status: 404, body: { detail: "Not Found" } });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    /** The next /v1/systemone reply. */
    reply: (value: Reply) => {
      next = value;
    },
    /** The next /v1/generate reply. */
    generateReply: (value: Reply) => {
      nextGenerate = value;
    },
    /** Replace the /v1/models reply, for example with a redirect. */
    models: (value: Reply | undefined) => {
      modelsReply = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

export interface RunOptions {
  env?: Record<string, string | undefined>;
  /** Piped into stdin. */
  stdin?: string;
  /** Pretend stdin is a terminal. `keys` are typed into it, one chunk each. */
  tty?: { keys: string[] };
  /** Pretend stdout is a terminal. */
  stdoutTTY?: boolean;
}

/** A private config folder per test, so saved keys never touch the real keychain or home folder. */
export const tempConfig = (): Record<string, string> => ({
  XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "wity-cli-test-")),
  WITY_CREDENTIAL_STORE: "file",
});

/** Run `wity <args>` in-process. Returns the exit code and everything printed. */
export const run = async (args: string[], options: RunOptions = {}) => {
  let stdout = "";
  let stderr = "";

  let stdin: Io["stdin"];
  if (options.tty) {
    const stream = new PassThrough() as unknown as Io["stdin"] & PassThrough;
    stream.isTTY = true;
    stream.setRawMode = () => stream;
    const { keys } = options.tty;
    // Type once the prompt is listening.
    setTimeout(() => {
      for (const key of keys) stream.write(key);
    }, 10);
    stdin = stream;
  } else {
    stdin = Object.assign(Readable.from(options.stdin === undefined ? [] : [options.stdin]), { isTTY: false });
  }

  const io: Io = {
    env: options.env ?? {},
    stdin,
    stdout: { write: (text: string) => (stdout += text), isTTY: options.stdoutTTY ?? false, columns: 100 },
    stderr: { write: (text: string) => (stderr += text), isTTY: false },
    signal: new AbortController().signal,
  };
  const code = await main(args, io);
  return { code, stdout, stderr };
};
