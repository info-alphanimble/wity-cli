#!/usr/bin/env node
// The `wity` executable. Everything else is in main.ts.

import pkg from "../package.json" with { type: "json" };
import { processIo } from "./io.ts";
import { main } from "./main.ts";
import { nodeUpdateDeps, updateNotice } from "./update-notice.ts";

// Ctrl+C cancels the call in flight. If the command doesn't stop by itself soon after, exit anyway.
const controller = new AbortController();
process.on("SIGINT", () => {
  process.stderr.write("\x1b[?25h"); // the spinner hides the cursor; bring it back
  controller.abort();
  setTimeout(() => process.exit(130), 500).unref();
});

// `wity ... | head` closes the pipe early. That's fine, not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw err;
});

// `wity mcp serve` belongs to the agent that started it, so it never checks for updates.
const updateDeps = process.argv.slice(2).includes("mcp") ? undefined : nodeUpdateDeps("wity-cli");
const notice = updateDeps && updateNotice("wity-cli", pkg.version, "npm install -g wity-cli", updateDeps);
// The SDK is bundled in, so a notice from it would be about a package you never installed.
process.env.WITY_NO_UPDATE_CHECK = "1";

process.exitCode = await main(process.argv.slice(2), processIo(controller.signal));

// Shown after the command, so it never gets mixed into its output.
if (notice) process.stderr.write(notice);
