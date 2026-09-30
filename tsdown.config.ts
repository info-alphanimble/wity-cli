import { defineConfig } from "tsdown";

// Builds dist/cli.mjs, the `wity` command.
// The SDK is a devDependency, so it's bundled in: the CLI doesn't need it published.
// commander and @napi-rs/keyring stay separate packages (the keyring has native code).
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  fixedExtension: true,
});
