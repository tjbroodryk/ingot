# @ingot/examples

## github-agent

An agent built on the Vercel AI SDK that answers a question about a GitHub repository. It has two
sets of tools. `list_issues`, `list_pull_requests` and `list_workflow_runs` return canned GitHub
API responses. Each tool stores its response in an ingot and gives the model the receipt instead:
the table's schema and a SELECT for the rows just stored. Ingot's own read-only tools (`describe`,
`query`, `recall` and `pending`) let the model read the data with SQL. The ingot is kept between
runs, so a second question can be answered from memory. When it is empty, the agent fetches first.

```bash
bun run db:up && bun run dev          # a local Ingot on :3002
export INGOT_API_KEY=...              # the key the server was started with
export INGOT_ACCOUNT=...              # the account that key belongs to (default: dev)
export ANTHROPIC_API_KEY=...

bun run example -- "what data do you have?"
bun run example -- "which PRs merged after a failed CI run on their branch?"
```

Quote the question: zsh treats an unquoted `?` as a glob.

The tool calls go to stderr, with what `describe` found as a markdown table, and the answer to
stdout. `--transcript <file>` also writes the whole
conversation as JSON: the system prompt, every tool call and every tool result.

```bash
bun run example -- --transcript chat.json "what data do you have?"
```
 `INGOT_URL` defaults to
`http://localhost:3002` and `ANTHROPIC_MODEL` picks the model.

`INGOT_API_KEY` and `INGOT_ACCOUNT` must match `INGOT_API_KEY` and `INGOT_ACCOUNT` in
`apps/ingot/.env`. A key used against any other account gets a 403.
