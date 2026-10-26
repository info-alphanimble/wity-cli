# Changelog

All notable changes to `wity-cli`. Versions follow [semver](https://semver.org). Before 1.0, a minor version can add features.

## 0.2.1 (2026-10-26)

### Added

- **Update notice.** When a newer `wity-cli` is on npm, `wity` says so on stderr after a command, at most once a day. It asks npm at most once a day, in the background, so no command waits for it. It stays quiet in CI, when output is piped, and in `wity mcp serve`. `WITY_NO_UPDATE_CHECK=1` turns it off.

### Changed

- Dependency updates for security fixes: `body-parser` 2.4.0, `fast-uri` 3.1.9, `ip-address` 10.7.5, `qs` 6.16.1 and `zod` 4.6.7.

## 0.2.0 (2026-10-22)

Split documents, extract fields, and teach Wity with skills and sessions.

### Added

- **`wity split`** cuts a document into whole items: emails, clauses, messages, log entries. Every item is an exact slice of the text, with its offsets.
  - Say what one item is with `--by` in plain words, or with `--unit` plus `--starts-at`, `--keep-together` and `--never-split`.
  - `--skill` splits the way a split skill was taught. It can't be combined with the other split options.
  - On a terminal it prints numbered items. `--json` prints the full response, and `--jsonl` prints one item per line for scripts.
- **`wity extract`** pulls named fields out of a document with `-f name="what it asks for"` (1 to 16 fields). `--type name=date|duration|number` normalises a field. Each value prints with its confidence and offsets, and a field with no values says "none found".
- `split` and `extract` read up to 60,000 characters, and take `--dry-run` and `--code` like the other commands.
- **`wity skills`**: `list`, `show`, `add` (from a YAML or JSON file), `edit` (flags or a file), `delete` and `try`. Also `examples add`, `examples list` and `examples delete`.
- **`wity sessions`**: `list`, `show`, `add`, `edit`, `delete`, `event` (`--update`, `--state`, `--note`, or `--feedback` with `--answer`), `decide` and `log`.
  - `decide` runs the session's skills, or the questions in a file. `--remember` adds the answers to what later decisions read. A repeat says it was answered before, for 0 tokens.
  - `log` shows every event, with each decision's answers first.
- **Skill questions in `wity ask`.** A question in the file can be `{skill: name}`. `--code` writes it with `skill("name")`. Answers from a skill say which skill version answered, and how.
- **MCP tools.** `wity mcp serve` adds `wity_split`, `wity_extract`, `wity_skill`, and the free `wity_list_skills` and `wity_list_sessions`. No tool can make, change or delete anything. Paid tools count toward `--max-spend`.

### Changed

- Builds against `wity-sdk` 0.2.0.
- `delete` commands ask first on a terminal. Without one, they need `--yes`, so a script never deletes by accident.
- A missing skill, session or example says "Not found" with a hint, and exits with 2. A skill name that's taken says so, and exits with 2.
- `@modelcontextprotocol/sdk` 1.32.1, for its security fixes.

### Fixed

- `--code` no longer fails on a question file that has skill questions.

## 0.1.1 (2026-10-05)

### Changed

- The default API address is now `https://api.wity.alphanimble.com`. A key saved by 0.1.0 under the old address is moved to the new one the first time it's used, with a one-time notice.

## 0.1.0 (2026-09-30)

First release.

- `wity noul`, `wity choice` and `wity score` for one question, and `wity ask` for several from a YAML or JSON file.
- `wity generate` for short text, or JSON that matches a shape.
- `--fail-under` and `--expect` turn an answer into an exit code for scripts.
- `--dry-run` and `--code` (TypeScript and curl) print the request without sending it.
- `wity api-key` keeps the key in the OS keychain, and `wity doctor` checks the setup.
- `wity playground` to try questions live, and `wity mcp serve` for AI agents.
