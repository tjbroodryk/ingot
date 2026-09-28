# @ingot/examples

## github-agent

An agent built on the Vercel AI SDK that answers a question about a GitHub repository. It has two
sets of tools. `list_issues`, `list_pull_requests` and `list_workflow_runs` return canned GitHub
API responses, and each tool stores its response in an ingot on the way past. Ingot's own
`describe`, `query` and `recall` tools let the model read those responses back with SQL. The
ingot is kept between runs, so a second question can be answered from memory.

```bash
bun run db:up && bun run dev          # a local Ingot on :3002
export INGOT_API_KEY=...              # the key the server was started with
export ANTHROPIC_API_KEY=...

bun run example -- "what data do you have?"
bun run example -- "which PRs merged after a failed CI run on their branch?"
```

Quote the question: zsh treats an unquoted `?` as a glob.

The tool calls go to stderr and the answer to stdout. `INGOT_URL` and `INGOT_ACCOUNT` default to
the local dev server, and `ANTHROPIC_MODEL` picks the model.
