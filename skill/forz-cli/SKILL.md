---
name: forz-cli
description: >-
  Drive the Forz field-service management platform from the command line using the
  `forz` CLI (npm package `forz-cli`, Forz Public API v2). Use this skill whenever the
  user wants to read or modify Forz data — customers, sites, contacts, jobs, estimates,
  invoices, sales orders, items, tasks, leads, deals, projects, assets, vendors, tickets,
  purchase orders, recurring jobs/invoices, or comments (notes) on any record — or mentions Forz,
  forz.io, field-service jobs/dispatch, an `fz_…` API key, or a bare Forz
  record id (a UUID, or a `customer_…`/`job_…` TypeID). It covers
  the conventions that are easy to get wrong: the ETag/If-Match flow on updates and
  deletes, idempotency keys on invoices and sales orders, cursor pagination, JSON body
  input, and RFC 9457 error handling. Reach for it even when the user says "look up a
  customer in Forz" or "create an invoice" without naming the CLI.
---

# Forz CLI

`forz` is a zero-dependency CLI for the **Forz Public API v2** (field-service
management — customers, jobs, invoices, etc.). This guide captures the conventions that
trip people up. For the exhaustive, always-current command list, run **`forz help`** —
it is the source of truth and reflects the API version the installed CLI targets.

## Setup check (do this first)

```
forz help        # is the CLI installed? shows the full command surface
forz whoami      # which account/user is this key bound to? (JSON to stdout)
forz ping        # key valid? prints "OK" + your read (GET) rate-limit budget
```

- Not installed → `npm install -g forz-cli` (or prefix every command with `npx`, e.g. `npx forz ping`).
- Not authenticated (401 `auth.*`) → `forz login --token fz_<uuid>` (keys are minted in the Forz UI at `/settings/api_keys`; format `fz_<UUIDv7>`). Credentials live in `~/.forz/config.json`; `FORZ_TOKEN` / `FORZ_BASE_URL` override it, and `--token` / `--base-url` override both.
- A 403 `auth.scope_missing` is not an auth problem: the key works but lacks the scope named in `required_scope`. `forz whoami | jq .api_key.scopes` shows what it has (`<resource>:write` implies read). Ask the user for a key with that scope rather than retrying.
- Before any create/update/delete, run `forz whoami` to confirm you're connected to the intended account — every write hits the real tenant (API keys have no "test mode" to fall back on).

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
refuse to run without `--if-match <etag>`**. On updates this prevents you from blindly
overwriting a change someone else made. The flow is always **get → use the ETag → mutate**:

```
forz customers get 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071
# stderr prints:  # ETag: W/"1745596800-3"
forz customers update 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071 --if-match 'W/"1745596800-3"' --body '{"organization":"New Name"}'
```

Notes that save debugging time:
- The ETag is a **weak ETag** of the form `W/"<epoch>-<lock_version>"` (e.g. `W/"1745596800-3"`). Pass it **exactly** as printed — the double quotes belong *after* the `W/` prefix. Wrap the whole token in single quotes so the embedded double-quotes survive: `--if-match 'W/"1745596800-3"'`. Don't add an extra outer pair of quotes.
- A `412 Precondition Failed` (`precondition.failed`) means the record changed since your `get` — re-`get` to obtain the fresh ETag, reconcile, and retry. Don't loop blindly.
- Omitting `--if-match` is caught locally by the typed commands; via `forz raw`, a PATCH with no `If-Match` returns `428 Precondition Required` (`precondition.required`).
- `delete` needs the ETag too (`forz customers delete <id> --if-match '<etag>'`) and the server enforces it the same way as on PATCH (`428` missing, `412` stale).
- `update` is a PATCH (partial) — send only the fields you're changing, not the whole object.
- The server **silently ignores body keys it doesn't accept** (misspelled, read-only, or not
  writable on that resource) and still answers 200/201, with no 422. Compare the returned record
  with what you sent before reporting success. Documented-but-ignored today: job `schedule_date`,
  job `title` on create (always derived as `"<system type> <job_type>"`, or just `job_type` with no
  system; set it with a follow-up `update`), estimate `public_notes`, task/lead `position`. Item `active` is written but needs the user's
  toggle-active permission. Customers have no email; update the linked contact.

## Idempotency on financial creates

Creating an **invoice** or a **sales order** is a financial action, so the API requires an
`Idempotency-Key`. The CLI **auto-generates one** for `invoices create` and
`sales_orders create`, so a normal create just works:

```
forz invoices create --body @invoice.json
```

The key matters when a create **fails ambiguously** (timeout, 5xx) and you don't know if
it went through. The safe pattern depends on whether you controlled the key:

- **You set an explicit key** → retry with the **same** key and a **byte-identical** `--body`; the server replays the first response, so at most one invoice is created:
  ```
  forz invoices create --body @invoice.json --idempotency-key 018f-your-stable-uuid
  # safe to retry verbatim (same key, same file)
  ```
  The same key with a **different** body returns `409 idempotency_key.in_use`; don't retry that, send the original body or use a new key. Keys are remembered for 24h. Failed responses (4xx and 5xx) are not cached, so after fixing a 4xx you can resend the corrected body under the same key.
- **The CLI auto-generated the key** → on a failed create it prints that key on stderr; retry with `--idempotency-key <that key>` and the same `--body`. If you lost it, don't blindly re-run: first **check whether the record exists** (`forz invoices list --filter.customer_id <id> --filter.invoice_date[gte] <date>`) and only create if it's genuinely missing.

The lesson: for any financial create you might need to retry, **control the key yourself**
from the first attempt so a retry is provably safe. Non-financial creates (customers,
jobs, …) don't require a key; pass `--idempotency-key` only when you want the same safety.
`409 idempotency_key.in_use` means either a request with the same key is **still in
flight** (wait ~2s and retry with the same key and body) or the key was already used with a
different body (see above). Omitting the key on a
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
- `--filter.<key> <value>` — equality, e.g. `--filter.status Open`. Range/set operators: `--filter.created_at[gte] 2026-01-01T00:00:00Z`, `--filter.status[in] Open,Closed`. `in` works on `status`, `gte|lte|gt|lt` on date fields; `ne` is not accepted anywhere (`400 filter.invalid`).

Filter allow-lists (all CRUD lists also take `q`; `created_at`/`updated_at` take ranges unless noted):

| Resource | Filters | Sort |
|---|---|---|
| `customers` | `organization`, `number`, `status` | `organization`, `number`, `status` |
| `sites` | `customer_id`, `lead_id`, `siteable_type`, `siteable_id`, `city`, `state`, `zip_code` | `city`, `state` |
| `contacts` | `email`, `first_name`, `last_name` | same |
| `jobs` | `customer_id`, `site_id`, `system_id`, `contact_id`, `number`, `status`, `due_date` | `number`, `status`, `due_date`, `priority` |
| `estimates` | `customer_id`, `site_id`, `system_id`, `contact_id`, `number`, `status`, `estimate_date`, `expiration_date` | `number`, `status`, `estimate_date`, `expiration_date`, `amount` |
| `invoices` | `customer_id`, `number`, `status`, `invoice_date`, `due_date` (no `updated_at` filter) | `number`, `status`, `invoice_date`, `due_date` |
| `sales_orders` | `customer_id`, `site_id`, `system_id`, `contact_id`, `number`, `status`, `date`, `due_date` | `number`, `status`, `date`, `due_date` |
| `items` | `number`, `name`, plus `item_type=products\|services\|inactive` | `number`, `name`, `item_type` |
| `tasks` | `assignee_id`, `number`, `taskable_type`, `taskable_id`, `status`, `due_date` | `number`, `status`, `due_date`, `title` |
| `leads` | `organization`, `number`, `status` | `number`, `status`, `organization` |
| `deals` | `customer_id`, `lead_id`, `number`, `status` | `number`, `status`, `name`, `amount` |
| `projects` | `customer_id`, `site_id`, `number`, `status`, `project_type` | `number`, `status`, `name`, `amount`, `project_type` |
| `systems` | `site_id`, `customer_id` (no sort/q) | none |

Every CRUD list also sorts by `created_at`/`updated_at`. **An unknown filter or query key returns
`400 filter.invalid`** and the detail names the allowed keys, so a typo like
`--filter.stauts Open` fails instead of returning every row. An unknown `--sort` field returns
`400 sort.invalid`, and a bad operator or unparseable value also returns `400 filter.invalid`. Changing a filter or `q` mid-pagination
returns `cursor.invalid_filters`; `sort` is simply fixed by the cursor on continuation pages.
Status values are the tenant's own labels — list them with `forz statuses list` when unsure.

Lookups take no `--sort`/`--q`, but `labels`, `statuses` and `custom_field_definitions`
accept `--filter.related_name <Type>` to scope the catalog to one resource type, e.g.
`forz statuses list --filter.related_name Job`. The read-only resources (`assets`,
`vendors`, `tickets`, `purchase_orders`, `recurring_jobs`, `recurring_invoices`) take only
`--limit`/`--cursor`; a sort, search or filter gets `400 filter.invalid`.

## Notes (comments on a record)

Every CRUD resource except `items`, and every read-only resource, exposes the web
"Comments" tab as `notes`:

```
forz jobs notes <job-id>                                   # list, paginates like any list
forz jobs notes <job-id> --add "Called back, wants a quote by Friday"   # create
```

`--add` takes plain text and the CLI wraps it as `{"note":{"description":…}}` for you. Text that starts with `--` must be attached with `=`: `--add="--text"`.
Notes need the parent's `<resource>:write` scope to create; a blank body is `422 validation.failed`.
Notes are append-only in v2 — there is no update or delete.

## Body input

Anywhere a `--body` is accepted you can pass JSON three ways:

- inline: `--body '{"organization":"Acme"}'`
- from a file: `--body @./new-customer.json`
- from stdin: `--body @-` (e.g. `cat job.json | forz jobs create --body @-`, or pipe from `jq`)

Shape: send the flat fields from the API spec (`{"organization":"Acme"}`). Typed
`create`/`update` wrap them under the singular resource key (`{"customer":{…}}`) for you, and
an already-wrapped body passes through unchanged. With `forz raw` a flat body works too; the
server wraps it (including `lineitems` and project `user_ids`).

## Errors

Non-2xx responses are RFC 9457 `application/problem+json` with a **stable `code` field**
in dotted snake_case (e.g. `validation.failed`). Branch on `code`, not on the
human-readable message (messages change, codes don't). The CLI surfaces the status, code,
and body, e.g. `HTTP 422 [validation.failed]: ...`. When the server names the offending
fields, the CLI prints those one per line instead of the full envelope:

```
HTTP 422 [validation.failed]: Validation failed
  phone_numbers.label: must be one of Mobile, Office, Fax, Other
```

Exit codes: `0` success, `1` API or network error, `2` usage error (bad flags or arguments).
Requests time out after 30s (`--timeout <seconds>` or `FORZ_TIMEOUT` to change).

Common codes:

- `validation.failed` (fix the body), `resource.not_found` (bad id).
- `precondition.failed` (412 — stale ETag, re-`get`), `precondition.required` (428 — missing `--if-match`, only via `raw`).
- `rate_limit.exceeded` (429 — the CLI already retried a few times honoring `Retry-After` (it retries 502/503/504 only for GETs and keyed creates, so a failed write was not replayed); if it still fails, wait the seconds in the error `detail`. Reads and writes have separate budgets and `forz ping` shows only the read one).
- `idempotency_key.required` (400), `idempotency_key.in_use` (409 — same key still in flight, or reused with a different body).
- `auth.missing_token` / `auth.invalid_token` / `auth.token_revoked` / `auth.failed` (401 — key missing, wrong, revoked/rotated or expired; the user must `forz login` with a valid key).
- `auth.scope_missing` (403 — key lacks the scope in `required_scope`; see Setup check).
- `auth.permission_denied` / `auth.plan_required` / `account.deactivated` / `account.inactive` (403 — the user's role, module, plan or account state; more scopes won't fix it, tell the user).
- `pagination.limit_too_large` (`--limit` > 100), `sort.invalid`, `filter.invalid`, `cursor.invalid` / `cursor.expired` / `cursor.invalid_filters`, `number.immutable`.
- `status.transition_invalid` (422 — `status` isn't one of the tenant's status names for that record type; use an exact `display_name` from `forz statuses list --filter.related_name <Type>`).

## Resource map

Run `forz help` for the authoritative list. As of API version **2026-04-30**:

- **Full CRUD** (`list | get | create | update | delete | notes`):
  `customers`, `sites`, `contacts`, `jobs`, `estimates`, `invoices`, `sales_orders`,
  `items`, `tasks`, `leads`, `deals`, `projects` (`items` has no `notes`).
- **Read-only records** (`list | get | notes` — `create`/`update`/`delete` are refused locally):
  `assets`, `vendors`, `tickets`, `purchase_orders`, `recurring_jobs`, `recurring_invoices`.
- **Lookups** (read-only, `list` only):
  `payment_terms`, `tax_rates`, `job_types`, `item_categories`, `system_options`,
  `labels`, `statuses`, `custom_field_definitions`.
  - `custom_field_definitions` is the one lookup that also supports `get <id>`.
- **`systems`** (`list | create`): equipment on a site. `list` takes `--filter.site_id` or
  `--filter.customer_id`; `create` needs `site_id` + `system_option_id` (from `forz system_options list`)
  and returns `409 system.duplicate` if the site already has one of that type (resend with
  `"confirmed": true`). Needs the System module (`403 auth.permission_denied` otherwise).
- `forz <resource> --help` prints one resource's commands; `forz --version` the CLI version.

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
`--include` also prints the status line and response headers to stderr, error responses included. `raw` only sends your token to the
configured base URL's origin and refuses an absolute URL on another host.

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
forz jobs create      --body '{"customer_id":"<customer-id>","site_id":"<site-id>","job_type":"Service Call"}'   # title is derived; rename via update
forz contacts create  --body '{"first_name":"Ana","last_name":"Diaz","linkable_type":"Customer","linkable_id":"<customer-id>"}'
```
`customers` also accept `reference` — a partner-defined external id — on create/update.

- `linkable_type` (`Customer`, `Lead` or `Site`) + `linkable_id` on contact **create** links the
  contact; it becomes the record's primary contact only if the record has none. On update,
  `linkable_*` is silently ignored. Don't send `customer_id` — contacts have none. A contact's
  `get` reports its primary link (else the oldest). To add, remove or re-primary links, use the
  linkages sub-resource (`contacts:write`; no `--if-match` needed):
  ```
  forz contacts linkages <contact-id>                                     # list
  forz contacts linkages <contact-id> --add --body '{"linkable_type":"Site","linkable_id":"<id>","primary":true}'
  forz contacts linkages <contact-id> --update <linkage-id> --body '{"primary":true}'   # or relationship_type
  forz contacts linkages <contact-id> --delete <linkage-id>
  ```
  A record's primary can't be unset (`primary: false` is a 422) or deleted (`contact.primary_linkage`);
  make another contact primary first.
- On tenants with the System module on, a job/estimate/invoice/sales order with a `site_id` also
  needs a `system_id` on that site (422 `system_id: is required`). Find or create one with
  `forz systems list --filter.site_id <site-id>` / `forz systems create` (needs `systems:read` / `systems:write`).

**Line items (`lineitems` on jobs / estimates / invoices / sales orders):** each new entry
needs `item_id` **and** `description` — a new line missing either gets `422 validation.failed`
naming `lineitems.item_id` / `lineitems.description`, and nothing is saved. `unit_price` is optional on new lines — omit it and the server resolves the
customer's contract price, else the item's list price; send `0` for a deliberately free
line. On updates, an entry carrying `id` keeps its stored price when `unit_price` is
omitted. `labor_hours_per_unit` / `labor_rate` are accepted only while the tenant's
`labor_pricing` module is on and are silently stripped otherwise, so check the response.

**Contact phone numbers (`phone_numbers` on contacts):** the nested array
(`{id, label, number, extension, plain}`) is what inbound call / SMS matching reads.
`phone` and `mobile` are display-only free text and are *not* synced to it on update.
It writes with the same snapshot-replace semantics as `lineitems`:

```
forz contacts update <id> --if-match '<etag>' --body '{"contact":{"phone_numbers":[
  {"id":"<uuid>","extension":"204"},
  {"label":"Office","number":"415-555-0100"}
]}}'
```

- Entry with `id` updates that row; entry without `id` creates one.
- **Any stored id you leave out is removed.** `get` first and echo back the ids you
  want to keep — a hand-written array is how numbers get wiped by accident.
- Omit the `phone_numbers` key entirely to leave the list untouched; send `[]` to clear
  every number.
- `number` is required on a new entry. On an existing entry, omit the key to keep the
  stored value — an explicit blank `number` is a `422`.
- `label`, when written, must be `Mobile`, `Office`, `Fax`, or `Other`. A legacy label
  echoed back unchanged is accepted, so a `get` → modify → `update` round trip is safe.
- `id` and `plain` are server-owned; `plain` is the normalized digit string. Discarded
  numbers are never returned.
- An `id` belonging to another contact is a `422` (not a `404`), reported as
  `phone_numbers.id`.
- A phone-only update moves the contact's ETag, so the usual `--if-match` flow applies.

On **create only**, a `mobile` with 10+ digits still auto-spawns a `Mobile` entry — skipped
when the request already supplies `phone_numbers`, so sending both never duplicates.

Look up valid values from the matching lookup before referencing them. `job_type` and
`status` take the lookup's `display_name` (`forz job_types list`); `payment_term_id` and
`tax_rate_id` (including `tax_rate_id` on lineitems) take the lookup row's `id` UUID
(`forz payment_terms list`, `forz tax_rates list`). Keys like `payment_term` or `tax_rate`
are not fields and are silently dropped.

**Status:** `status` is ignored on every `create` — the server always starts the record at the
tenant's first status. To set one, create, then `get` + `update --body '{"status":"<display_name>"}'`.
Invoices and sales orders compute their status server-side, so `status` in their create or update
body is silently ignored (you can't mark an invoice Paid via the API).

**Labels / custom fields:** `labels` replaces the full list — send every label you want to keep,
`[]` clears; values are Label `display_name`s from `forz labels list --filter.related_name <Type>`.
Project `user_ids` also replaces the whole team. `custom_fields` merges: only the keys you send
change and `null` clears one. Its keys are the field `id`s (`fields[].id`) from
`forz custom_field_definitions list --filter.related_name <Type>`, not the labels.

## Working style

- When a task needs an id you don't have, `list` (with a `--filter` if you can) to find it before acting.
- Prefer the typed commands over `raw`; reach for `raw` only when no command fits.
- Capture stdout to a file or `jq` it for the data; watch stderr for ETags and pagination cursors.
- Mutations are real writes against the user's account — there is a single environment (API keys have no test mode), so run `forz whoami` to confirm the target account first and confirm destructive actions (`delete`, bulk updates) before running them.
