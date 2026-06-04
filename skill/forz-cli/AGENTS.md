<!-- Generated from SKILL.md by skill/sync-skill-docs.sh — do not edit by hand. -->

> **Using OpenAI Codex or another `AGENTS.md`-compatible agent?** Append the rest
> of this file to your project's `AGENTS.md` (or `~/.codex/AGENTS.md`). It is the
> same guidance as the Claude skill at `skill/forz-cli/SKILL.md`, minus the
> Claude-specific frontmatter.


# Forz CLI

`forz` is a zero-dependency CLI for the **Forz Public API v2** (field-service
management — customers, jobs, invoices, etc.). This guide captures the conventions that
trip people up. For the exhaustive, always-current command list, run **`forz help`** —
it is the source of truth and reflects the API version the installed CLI targets.

## Setup check (do this first)

```
forz help        # is the CLI installed? shows the full command surface
forz ping        # authenticated? prints "OK" + your rate-limit budget
```

- Not installed → `npm install -g forz-cli` (or prefix every command with `npx`, e.g. `npx forz ping`).
- Not authenticated → `forz login --token fz_live_<uuid>` (keys are minted in the Forz UI at `/settings/api_keys`; format `fz_(live|test)_<UUIDv7>`). Credentials live in `~/.forz/config.json`.
- Use a `fz_test_` key against test data while figuring out a workflow, then switch to `fz_live_`.

Never paste a token into a command the user can see logged if you can avoid it — prefer that the user runs `forz login` themselves. If you must, treat the key like a password.

## How output works (read this before scripting)

`forz` separates **data** from **metadata** so you can pipe cleanly:

- **stdout** = the JSON payload (an object for `get`/`create`/`update`, an array for `list`).
- **stderr** = side-channel hints that are *not* part of the data:
  - after `get`: `# ETag: "<value>"` — you need this for the next update/delete.
  - after `list`: `# more available — re-run with --cursor <c>` — there are more pages.

So `forz customers get cust_01J... > customer.json` captures clean JSON, and the ETag still shows up in your terminal. When you need the ETag programmatically, read it from stderr — don't try to parse it out of stdout, it isn't there.

## The ETag / If-Match flow (the #1 thing to get right)

Forz uses optimistic concurrency: every record has an ETag, and **`update` and `delete`
refuse to run without `--if-match <etag>`**. This prevents you from blindly overwriting a
change someone else made. The flow is always **get → use the ETag → mutate**:

```
forz customers get cust_01J9Z...
# stderr prints:  # ETag: "W/a1b2c3"
forz customers update cust_01J9Z... --if-match '"W/a1b2c3"' --body '{"name":"New Name"}'
```

Notes that save debugging time:
- Pass the ETag **exactly** as printed, quotes and all. Wrap it in single quotes in the shell so the inner double-quotes survive: `--if-match '"W/a1b2c3"'`.
- A `412 Precondition Failed` means the record changed since your `get` — re-`get` to obtain the fresh ETag, reconcile, and retry. Don't loop blindly.
- `delete` needs the ETag too: `forz customers delete <id> --if-match '<etag>'`.
- `update` is a PATCH (partial) — send only the fields you're changing, not the whole object.

## Idempotency on financial creates

Creating an **invoice** or a **sales order** is a financial action, so the API requires an
`Idempotency-Key`. The CLI **auto-generates one** for `invoices create` and
`sales_orders create`, so a normal create just works:

```
forz invoices create --body @invoice.json
```

The key matters when a create **fails ambiguously** (timeout, 5xx) and you don't know if
it went through. The safe pattern depends on whether you controlled the key:

- **You set an explicit key** → just retry with the **same** key; the server dedupes, so at most one invoice is created:
  ```
  forz invoices create --body @invoice.json --idempotency-key 018f-your-stable-uuid
  # safe to retry verbatim
  ```
- **The CLI auto-generated the key** (you didn't pass one, so you don't know what it was) → you **cannot** dedupe a retry. Don't blindly re-run — first **check whether it already exists** (`forz invoices list --filter...` for the customer/amount/date) and only create if it's genuinely missing.

The lesson: for any financial create you might need to retry, **control the key yourself**
from the first attempt so a retry is provably safe. Non-financial creates (customers,
jobs, …) don't require a key; pass `--idempotency-key` only when you want the same safety.

## Pagination

`list` returns one page: default 25 rows, max `--limit 100`. When more exist, the cursor
is printed on stderr. To walk everything, follow the cursor until it stops appearing:

```
forz jobs list --limit 100
forz jobs list --limit 100 --cursor <cursor-from-stderr>
```

Filter server-side with `--filter.<key> <value>` (forwarded as raw query params), e.g.
`forz jobs list --filter.status open --filter.customer_id cust_01J...`. Available filter
keys are per-resource — when unsure, check the Forz API docs or try one and read the error.

## Body input

Anywhere a `--body` is accepted you can pass JSON three ways:

- inline: `--body '{"name":"Acme"}'`
- from a file: `--body @./new-customer.json`
- from stdin: `--body @-` (e.g. `cat job.json | forz jobs create --body @-`, or pipe from `jq`)

## Errors

Non-2xx responses are RFC 9457 `application/problem+json` with a **stable `code` field**.
Branch on `code`, not on the human-readable message (messages change, codes don't). The
CLI surfaces the status, code, and body, e.g. `HTTP 422 [validation_error]: ...`. Common
ones: `validation_error` (fix the body), `not_found` (bad id), `precondition_failed`
(stale ETag — re-get), `rate_limited` (back off; `forz ping` shows your budget).

## Resource map

Run `forz help` for the authoritative list. As of API version **2026-04-30**:

- **Full CRUD** (`list | get | create | update | delete`):
  `customers`, `sites`, `contacts`, `jobs`, `estimates`, `invoices`, `sales_orders`,
  `items`, `tasks`, `leads`, `deals`, `projects`.
- **Lookups** (read-only, `list` only):
  `payment_terms`, `tax_rates`, `job_types`, `item_categories`, `system_options`,
  `labels`, `statuses`, `custom_field_definitions`.
  - `custom_field_definitions` is the one lookup that also supports `get <id>`.

The resource set is **pinned to the API version the CLI was built against**. If a command
errors with "Unknown resource/command", trust `forz help` over memory — the surface may
have changed between releases.

## Escape hatch

For anything the typed commands don't cover, call the API directly:

```
forz raw /api/v2/system_options
forz raw /api/v2/customers --method POST --body @c.json --header.Idempotency-Key <uuid>
```

`raw` prints the response body verbatim and lets you set arbitrary headers via
`--header.<Name> <value>`.

## Task recipes

**Safely rename a customer (get → update):**
```
forz customers get cust_01J9Z...                       # note the # ETag: line on stderr
forz customers update cust_01J9Z... --if-match '"<etag>"' --body '{"name":"Acme Corp"}'
```

**Create an invoice (financial — idempotency is automatic):**
```
forz invoices create --body @invoice.json              # Idempotency-Key auto-set
```

**Walk every open job:**
```
forz jobs list --limit 100 --filter.status open
# while stderr shows a cursor, repeat with --cursor <c> and collect the stdout arrays
```

**Stand up a customer → site → job chain:**
```
forz customers create --body '{"name":"Acme"}'         # capture the returned id from stdout
forz sites create     --body '{"customer_id":"<id>","address":"..."}'
forz jobs create      --body '{"site_id":"<site_id>","job_type_id":"...","summary":"..."}'
```
Look up valid `job_type_id` / `tax_rate` / `payment_term` values from the matching lookup
(`forz job_types list`, etc.) before referencing them.

## Working style

- When a task needs an id you don't have, `list` (with a `--filter` if you can) to find it before acting.
- Prefer the typed commands over `raw`; reach for `raw` only when no command fits.
- Capture stdout to a file or `jq` it for the data; watch stderr for ETags and pagination cursors.
- Mutations are real writes against the user's account — confirm destructive actions (`delete`, bulk updates) before running them, and prefer a `fz_test_` key while iterating.
