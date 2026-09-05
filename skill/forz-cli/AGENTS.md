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
forz whoami      # which account/user is this key bound to? (JSON to stdout)
forz ping        # authenticated? prints "OK" + your rate-limit budget
```

- Not installed → `npm install -g forz-cli` (or prefix every command with `npx`, e.g. `npx forz ping`).
- Not authenticated → `forz login --token fz_<uuid>` (keys are minted in the Forz UI at `/settings/api_keys`; format `fz_<UUIDv7>`). Credentials live in `~/.forz/config.json`.
- Before any create/update/delete, run `forz whoami` to confirm you're connected to the intended account — every write hits the real tenant (there is a single environment, so there is no "test mode" to fall back on).

Never paste a token into a command the user can see logged if you can avoid it — prefer that the user runs `forz login` themselves. If you must, treat the key like a password.

## How output works (read this before scripting)

`forz` separates **data** from **metadata** so you can pipe cleanly:

- **stdout** = the JSON payload (an object for `get`/`create`/`update`, an array for `list`).
- **stderr** = side-channel hints that are *not* part of the data:
  - after `get`: `# ETag: W/"1745596800-3"` — you need this for the next update/delete.
  - after `list`: `# more available — re-run with --cursor <c>` — there are more pages.
  - after `whoami`: `# connected to <account> as <email>` — a human summary; parse the JSON on stdout, never this line.

So `forz customers get 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071 > customer.json` captures clean JSON, and the ETag still shows up in your terminal. When you need the ETag programmatically, read it from stderr — don't try to parse it out of stdout, it isn't there.

## The ETag / If-Match flow (the #1 thing to get right)

Forz uses optimistic concurrency: every record has an ETag, and **`update` and `delete`
refuse to run without `--if-match <etag>`**. This prevents you from blindly overwriting a
change someone else made. The flow is always **get → use the ETag → mutate**:

```
forz customers get 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071
# stderr prints:  # ETag: W/"1745596800-3"
forz customers update 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071 --if-match 'W/"1745596800-3"' --body '{"organization":"New Name"}'
```

Notes that save debugging time:
- The ETag is a **weak ETag** of the form `W/"<epoch>-<lock_version>"` (e.g. `W/"1745596800-3"`). Pass it **exactly** as printed — the double quotes belong *after* the `W/` prefix. Wrap the whole token in single quotes so the embedded double-quotes survive: `--if-match 'W/"1745596800-3"'`. Don't add an extra outer pair of quotes.
- A `412 Precondition Failed` (`precondition.failed`) means the record changed since your `get` — re-`get` to obtain the fresh ETag, reconcile, and retry. Don't loop blindly.
- Omitting `--if-match` is caught locally by the typed commands; via `forz raw`, a PATCH/DELETE with no `If-Match` returns `428 Precondition Required` (`precondition.required`).
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
Reusing a key with a **different body** returns `409 idempotency_key.in_use`; omitting it on a
financial create (only reachable via `forz raw`) returns `400 idempotency_key.required`.

## Pagination, filtering & sorting

`list` returns one page: default 25 rows, max `--limit 100`. When more exist, the cursor
is printed on stderr. To walk everything, follow the cursor until it stops appearing:

```
forz jobs list --limit 100
forz jobs list --limit 100 --cursor <cursor-from-stderr>
```

Narrow and order results server-side. Each list endpoint **allow-lists its own fields**:

- `--sort <field>` — ascending by default; for descending use the `=` form, e.g. `--sort=-created_at` (a leading `-` in the value needs `--sort=…`, not a space). Honored on the first page; the cursor fixes the order on continuation pages.
- `--q <text>` — free-text search.
- `--filter.<key> <value>` — equality, e.g. `--filter.status Open`. Range/set operators: `--filter.created_at[gte] 2026-01-01T00:00:00Z`, `--filter.status[in] Open,Closed` (operators: `gte|lte|gt|lt|ne|in`).

Common allow-lists: `customers` → `q,sort,organization,number,status,created_at`;
`invoices` → `q,sort,customer_id,number,status,invoice_date,due_date`;
`jobs`/`leads`/`deals`/`estimates`/`projects`/`sales_orders`/`tasks` →
`q,sort,created_at,updated_at,status`. An unknown field returns `400 filter.invalid` /
`sort.invalid`; changing a filter, sort, or `q` mid-pagination invalidates the cursor
(`cursor.invalid_filters`). Status values are the tenant's own labels — list them with
`forz statuses list` when unsure.

Lookups take no `--sort`/`--q`, but `labels`, `statuses` and `custom_field_definitions`
accept `--filter.related_name <Type>` to scope the catalog to one resource type, e.g.
`forz statuses list --filter.related_name Job`.

## Body input

Anywhere a `--body` is accepted you can pass JSON three ways:

- inline: `--body '{"organization":"Acme"}'`
- from a file: `--body @./new-customer.json`
- from stdin: `--body @-` (e.g. `cat job.json | forz jobs create --body @-`, or pipe from `jq`)

## Errors

Non-2xx responses are RFC 9457 `application/problem+json` with a **stable `code` field**
in dotted snake_case (e.g. `validation.failed`). Branch on `code`, not on the
human-readable message (messages change, codes don't). The CLI surfaces the status, code,
and body, e.g. `HTTP 422 [validation.failed]: ...`. Common ones:

- `validation.failed` (fix the body), `resource.not_found` (bad id).
- `precondition.failed` (412 — stale ETag, re-`get`), `precondition.required` (428 — missing `--if-match`, only via `raw`).
- `rate_limit.exceeded` (429 — back off; `forz ping` shows your budget).
- `idempotency_key.required` / `idempotency_key.in_use` (409 — same key, different body).
- `pagination.limit_too_large` (`--limit` > 100), `sort.invalid`, `filter.invalid`, `cursor.invalid` / `cursor.expired` / `cursor.invalid_filters`, `number.immutable`.
- `status.transition_invalid` (the requested `status` isn't a legal next step from the current one — check `forz statuses list`).

## Resource map

Run `forz help` for the authoritative list. As of API version **2026-04-30**:

- **Full CRUD** (`list | get | create | update | delete`):
  `customers`, `sites`, `contacts`, `jobs`, `estimates`, `invoices`, `sales_orders`,
  `items`, `tasks`, `leads`, `deals`, `projects`.
- **Lookups** (read-only, `list` only):
  `payment_terms`, `tax_rates`, `job_types`, `item_categories`, `system_options`,
  `labels`, `statuses`, `custom_field_definitions`.
  - `custom_field_definitions` is the one lookup that also supports `get <id>`.

Record ids are **UUID v7** strings on the wire (e.g. `0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071`)
— that's what you pass to `get`/`update`/`delete` and to id filters like `--filter.customer_id`.
(The API also exposes a `customer_…`/`job_…`/`site_…` TypeID form in logs and cross-system
references, but the accepted wire id is the raw UUID.)

The resource set is **pinned to the API version the CLI was built against**. If a command
errors with "Unknown resource/command", trust `forz help` over memory — the surface may
have changed between releases.

## Escape hatch

For anything the typed commands don't cover, call the API directly:

```
forz raw /api/v2/system_options
forz raw /api/v2/customers --method POST --body @c.json --header.Idempotency-Key <key>
```

`raw` prints the response body verbatim and lets you set arbitrary headers via
`--header.<Name> <value>` (e.g. `--header.If-Match 'W/"1745596800-3"'` on a raw PATCH/DELETE).

## Task recipes

**Rename a customer (the display field is `organization`):**
```
forz customers get 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071     # note the # ETag: line on stderr
forz customers update 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071 --if-match '<etag>' --body '{"organization":"Acme Corp"}'
```

**Create an invoice (financial — idempotency is automatic):**
```
forz invoices create --body @invoice.json              # Idempotency-Key auto-set
```

**Walk every open job:**
```
forz jobs list --limit 100 --filter.status Open
# while stderr shows a cursor, repeat with --cursor <c> and collect the stdout arrays
```

**Stand up a customer → site → job chain:**
```
forz customers create --body '{"organization":"Acme"}'                                   # capture the returned id (a UUID) from stdout
forz sites create     --body '{"site_name":"HQ","street":"123 Main St","city":"Austin","state":"TX","siteable_type":"Customer","siteable_id":"<customer-id>"}'
forz jobs create      --body '{"customer_id":"<customer-id>","site_id":"<site-id>","title":"Annual service","job_type":"Service Call"}'
```
`customers` also accept `reference` — a partner-defined external id — on create/update.

**Line items (`lineitems` on jobs / estimates / invoices / sales orders):** each entry needs
`item_id`. `unit_price` is optional on new lines — omit it and the server resolves the
customer's contract price, else the item's list price; send `0` for a deliberately free
line. On updates, an entry carrying `id` keeps its stored price when `unit_price` is
omitted. `labor_hours_per_unit` / `labor_rate` are accepted only while the tenant's
`labor_pricing` module is on and are silently stripped otherwise, so check the response.

Look up valid `job_type` / `tax_rate` / `payment_term` values from the matching lookup
(`forz job_types list`, etc.) before referencing them — `job_type` is the JobType's
display name, not an id.

## Working style

- When a task needs an id you don't have, `list` (with a `--filter` if you can) to find it before acting.
- Prefer the typed commands over `raw`; reach for `raw` only when no command fits.
- Capture stdout to a file or `jq` it for the data; watch stderr for ETags and pagination cursors.
- Mutations are real writes against the user's account — there is a single environment (no test mode), so run `forz whoami` to confirm the target account first and confirm destructive actions (`delete`, bulk updates) before running them.
