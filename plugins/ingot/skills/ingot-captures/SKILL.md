---
name: ingot-captures
description: Large MCP tool results are stored in Ingot tables named <provider>_<tool> instead of shown in full. Use when a tool result says it was stored in Ingot, or when you need data an MCP tool returned earlier in this session or a past one.
---

# Captured tool results

When an MCP result is longer than about 8,000 characters, a hook stores it in
Ingot and you get a stub instead: the table, the `call_id` of that call, the
columns and a few preview rows. Query what you need with the ingot `query`
tool rather than calling the tool again.

Tables are named for the server and tool: `mcp__sentry__search_issues` lands
in `sentry_search_issues`, `mcp__plugin_azure_azure__storage` in
`azure_storage`. Every call to a tool goes into the same table, so earlier
results, from past sessions too, are still there.

Each row is one item of the result. A result that is a list of objects, or an
object holding a single list, gives a row per object and a column per top-level
key; nested values are `JSON` columns, numbers are `DOUBLE`. A key that starts
with `_` or clashes with the columns below gets an `r_` prefix. Anything else
is text, split into 2,000-character rows with `part` and an embedded `text`
column, so `recall` on that table ranks the chunks by meaning.

Every row also carries:

| column         | what it holds                              |
| -------------- | ------------------------------------------ |
| `call_id`      | the tool call's id, quoted in the stub     |
| `call_input`   | the tool's arguments, as JSON text         |
| `call_session` | the Claude Code session that made the call |

```sql
-- this call
SELECT * FROM sentry_search_issues WHERE call_id = 'toolu_…' LIMIT 20
-- an earlier call with different arguments
SELECT DISTINCT call_id, call_input FROM sentry_search_issues
WHERE call_input LIKE '%project-x%'
```

Call the tool again instead when the data may have changed since it was
stored, or when the stub's columns can't answer the question.
