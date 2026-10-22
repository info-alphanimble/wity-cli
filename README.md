# Wity CLI

Ask [Wity](https://wity.alphanimble.com) typed questions about any text, from your terminal. Get a probability for every answer, and use it in scripts through exit codes.

```sh
cat email.txt | wity noul "Is this a phishing message?"
```

Needs Node.js 22.13 or newer.

```sh
npm install -g wity-cli
```

## API key

```sh
wity api-key set wity_…             # save a key from wity.alphanimble.com/console/keys
wity api-key set                    # or paste it at a hidden prompt
wity api-key set --stdin < key.txt  # or pipe it in, for CI and scripts
wity api-key show                   # which key is in use, and does it work
wity api-key remove                 # remove the saved key from this computer
wity doctor                         # check the key, storage and connection
```

1. Create a key on the [keys page](https://wity.alphanimble.com/console/keys).
2. Run `wity api-key set wity_…` with your key. Or run `wity api-key set` alone and paste the key at the prompt. Nothing shows while you paste.
3. The CLI checks the key with a free call, then saves it.

**Scripts and CI.** `wity api-key set --stdin` reads the key from stdin instead of a prompt: `wity api-key set --stdin < key.txt`, or `echo "$KEY" | wity api-key set --stdin`. Or skip saving a key and set `WITY_API_KEY`.

**A new key.** Running `wity api-key set` again replaces the saved key.

**Removing a key.** `wity api-key remove` only removes the key from this computer. The key keeps working, because the same key may run somewhere else. Revoke it on the keys page if you need to.

**How the key is kept safe.**
- The key is saved in the OS keychain (macOS Keychain, Windows Credential Manager, or the Secret Service on Linux). Without one, it goes in `~/.config/wity/credentials.json`, readable only by you. `WITY_CREDENTIAL_STORE=keychain` or `=file` picks one.
- A key typed in the command (`wity api-key set wity_…`) is saved in your shell history. The prompt and `--stdin` keep it out.
- `WITY_API_KEY` wins over a saved key. `wity api-key show` says which one is in use.
- A key is saved for one API address, and never sent to another. Redirects are never followed.

## Ask

```sh
wity noul "Is this urgent?" --text "Server is down for all customers"
wity choice "Which team handles this?" -o billing="Payments and refunds" -o technical="Bugs and outages" --file ticket.txt
wity score "How upset is the customer?" -l Calm -l Annoyed -l Angry --text "Where is my order?!"
```

The text comes from `--text`, `--file` (`-` for stdin), or a pipe. Up to 32,000 characters.

| Flag | What it does |
|---|---|
| `-r, --reasoning off\|auto\|always` | When Wity thinks before answering. The API default is `auto`. |
| `--max-latency <ms>` | Cap the time per request, 200 to 120000. |
| `--json` | Print the full response. This is the default when output is piped. |
| `--field <path>` | Print one value, like `noul`, `choice` or `probabilities.billing`. |
| `--fail-under <n>` | Exit with 10 if the answer is under `n` (see below). |
| `--expect <id>` | `choice` only: exit with 10 unless this option wins. |
| `--dry-run` | Print the request without sending it. Needs no key. |
| `--code [ts\|curl]` | Print the request as TypeScript (with the SDK) and as curl, instead of sending it. Needs no key. |
| `--if-yes`, `--if-no` | `noul` only: describe what yes and no mean. |

`--fail-under` compares:

- for `noul`, the probability of yes
- for `choice`, the probability of the winner, or of `--expect` if given
- for `score`, the score itself, on the level scale (0 is the lowest level)

Probabilities add up to 1, but they aren't calibrated. Treat them as how sure Wity is, not as exact odds.

## Several questions at once

`wity ask` sends every question in a YAML or JSON file in one call. The questions use the API's own shape.

```yaml
# questions.yaml
state: My card was charged twice, and I need one refund before Friday.   # optional: or use --text, --file, a pipe
reasoning: auto                                                          # optional
questions:
  team:
    type: choice
    instructions: Which team should handle this ticket?
    criteria:
      billing: Payments, charges and refunds
      technical: Bugs, errors and outages
      other: Anything else
  urgent:
    type: noul
    instructions: Does the customer need this soon?
  upset:
    type: score
    instructions: How upset is the customer?
    criteria: [Calm, Annoyed, Angry]
```

```sh
wity ask questions.yaml
wity ask questions.yaml --file ticket.txt --field team.choice
```

- `state` can also be an object, which Wity reads as JSON.
- A question can be a saved [skill](#skills): `urgent: {skill: urgent-ticket}`.
- Every problem in the file is listed before anything is sent.
- `--reasoning` and `--max-latency` override the file.

## Generate

`wity generate` writes short text, up to 512 tokens. With `--shape`, it writes JSON that matches a JSON Schema.

```sh
wity generate "The one-sentence reply to send" --file ticket.txt
wity generate "Origin city and seat" --text "LISBOA (LIS) -> BER, seat 23C" --shape ticket.schema.json
```

- On a terminal it prints the text, then time and cost.
- Piped, it prints only the text, or with `--shape` only the JSON. Use `--json` for the whole response.
- If Wity hits `--max-tokens` (default 128), it says so. With `--shape`, it exits with 1, because the JSON isn't complete.
- Check generated text before you act on it. It can say things that aren't in the input.

## Split

`wity split` cuts a document into whole items: emails from a thread, clauses from a contract, entries from a log. Every item is an exact slice of the text, with its start and end offsets.

```sh
wity split --file thread.txt --by "one item per email"
wity split --file contract.txt --unit clause --starts-at "a numbered heading like 4. Liability."
wity split --file thread.txt --skill email-thread
```

- The text comes from `--text`, `--file` (`-` for stdin), or a pipe. Up to 60,000 characters.
- Say what one item is with `--by`, in plain words. The default is one item per paragraph.
- For more control, give `--unit`, with `--starts-at`, `--keep-together` and `--never-split` (each up to 8 times).
- Or use `--skill` with a split skill. It splits the way its examples do, so leave out the other options.
- On a terminal it prints the items, numbered, with their offsets. Piped, it prints JSON.
- `--jsonl` prints one item per line, for scripts:

```sh
wity split --file thread.txt --by "one item per email" --jsonl |
  while IFS= read -r item; do printf '%s' "$item" | wity noul "Is this a complaint?" --field noul; done
```

## Extract

`wity extract` pulls named fields out of a document. Each value comes back as written, with its position and a confidence.

```sh
wity extract --file contract.txt \
  -f party="a company that signs the agreement" \
  -f "effective date"="when it takes effect" \
  --type "effective date"=date
```

- Give 1 to 16 fields with `-f name="what it asks for"`.
- `--type name=date|duration|number` makes a field come back normalised. Dates come back as YYYY-MM-DD.
- A field with no values prints "none found".
- Confidence is from 0 to 1. It isn't calibrated.
- Up to 60,000 characters of text. `--json`, `--dry-run` and `--code` work like they do for the other commands.

## Skills

A skill saves a question once, and learns your definition from labelled examples. Reading and managing skills is free. Adding examples is billed once, on their tokens.

```yaml
# urgent-ticket.yaml: a decision skill
name: urgent-ticket
question:
  type: noul
  instructions: Does this support ticket need a reply within the hour?
examples:
  - {state: Checkout is down for every customer., answer: yes}
  - {state: Can you change my invoice address?, answer: no}
```

```yaml
# email-thread.yaml: a split skill
name: email-thread
split: one item per email
examples:
  - text: "From: dana@example.com\nSeal test failed.\n\nFrom: marcus@example.com\nRerun tomorrow."
    items: ["From: dana@example.com\nSeal test failed.", "From: marcus@example.com\nRerun tomorrow."]
```

```sh
wity skills add urgent-ticket.yaml                  # make a skill from a file
wity skills list                                    # your skills, newest first
wity skills show urgent-ticket                      # its question, examples, status and quality
wity skills try urgent-ticket --file ticket.txt     # ask its question about a text
wity skills edit urgent-ticket --description "..."  # or a file with only the fields to change
wity skills delete urgent-ticket

wity skills examples add urgent-ticket more.yaml    # a list of {state, answer}, or {text, items} for split skills
wity skills examples list urgent-ticket
wity skills examples delete urgent-ticket ex_…
```

- A decision skill has a `noul` or `choice` question. It can also have `description`, `parts`, `combine` and `metadata`.
- A decision skill starts learning at 8 examples, with at least 2 for each of two answers.
- For a split skill, one example already helps, and about three is enough.
- A new question, parts or rule makes the skill learn again.
- Every command takes the skill's name or its id (`sk_…`).
- Use a decision skill in `wity ask` as `{skill: urgent-ticket}`. Use a split skill with `wity split --skill`.

## Sessions

A session keeps a state on Wity's side. Add to it as things happen, decide when you need to, and correct the answers so the skills learn. Decisions are billed like questions. Events, reads and repeats are free.

```sh
wity sessions add --text "Ticket #5120 from Northwind Foods." --skill urgent-ticket --expires-in 30d
wity sessions event ses_… --update "Customer: checkout still fails."
wity sessions decide ses_…                          # runs the session's skills
wity sessions event ses_… --feedback ev_… --answer no   # it was wrong: this becomes an example
wity sessions log ses_…                             # every event, oldest first
```

| Event | Does |
|---|---|
| `--update <text>` | Adds to what Wity reads |
| `--state <text>` | Replaces what Wity reads from here on |
| `--note <text>` | Kept in the log, never read |
| `--feedback <decision_id> --answer <a>` | The right answer to an earlier decision. Add `--question <name>` if it had more than one skill |

- `decide` takes a questions file like `wity ask`, without a state, to ask your own questions instead. Its reasoning defaults to `off`.
- `--remember` adds the decision's answers to what later decisions read.
- A repeat of the same contents and questions gives the same answer, for 0 tokens.
- `wity sessions list`, `show`, `edit` (skills, expiry) and `delete` work like the skills commands.
- Sessions expire after 7 days, unless `--expires-in` says otherwise (60 s to 90 days, like `12h` or `30d`).

**Deleting.** `delete` commands ask first on a terminal. Scripts must pass `--yes`.

## Playground

Run `wity` with no arguments, or `wity playground --file ticket.txt`, to try questions live.

- Type or paste the text, pick a question type, and press Enter to ask.
- Tab moves between fields. ← → changes the type and reasoning.
- Ctrl+T shows the request as code. Esc quits.
- Every Enter is a real, billed call. The header shows the running cost.

## AI agents (MCP)

`wity mcp serve` gives AI apps Wity as tools. Set a key first with `wity api-key set`, or set `WITY_API_KEY`.

- Questions: `wity_noul`, `wity_choice`, `wity_score`, `wity_ask`, and `wity_skill` for a saved skill.
- Documents: `wity_split` and `wity_extract`. Writing: `wity_generate`.
- Free reads: `wity_list_skills` and `wity_list_sessions`.

```sh
claude mcp add wity -- wity mcp serve --max-spend 1   # Claude Code
```

For Claude Desktop, Cursor and other apps, add this to their MCP settings:

```json
{
  "mcpServers": {
    "wity": { "command": "wity", "args": ["mcp", "serve", "--max-spend", "1"] }
  }
}
```

- It talks over stdin and stdout only, and opens no network port.
- No tool takes a key, or can set or remove one. The key never appears in tool output.
- The tools only use Wity. None can make, change or delete a skill, a session or anything else.
- `--max-spend` stops paid calls after that many dollars in one session, in case an agent gets stuck in a loop.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | The API or network failed |
| 2 | Bad flags or input. Nothing was billed. |
| 3 | No API key, or the key was refused |
| 10 | Answered, but failed `--fail-under` or `--expect` |
| 130 | Cancelled with Ctrl+C, or you said no to a delete |

```sh
if wity noul "Does this diff touch billing code?" --file change.diff --fail-under 0.5 >/dev/null; then
  echo "Needs a billing reviewer"
fi
```

## Settings

| Variable | What |
|---|---|
| `WITY_API_KEY` | Use this key instead of the saved one. |
| `WITY_BASE_URL` | Use another API address (also `--base-url`). https only, except localhost. |
| `WITY_CREDENTIAL_STORE` | `auto` (default), `keychain` or `file`. |
| `WITY_LOG_LEVEL` | `debug`, `info`, `warn` (default), `error` or `off`. Logs go to stderr. They never include the key or your text. |
| `NO_COLOR`, `FORCE_COLOR` | Turn colours off or on. |

## Developing

```sh
npm install
npm run dev -- noul "Is this spam?" --text "..."   # build, then run
npm run check   # typecheck, lint, tests, build, audit
```

The tests run offline against a fake Wity server, with real responses in `test/fixtures/`. They never touch your keychain or saved key.
