#!/usr/bin/env node
// The `wity` executable. Everything else is in main.ts.

import { processIo } from "./io.ts";
import { main } from "./main.ts";

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

process.exitCode = await main(process.argv.slice(2), processIo(controller.signal));
