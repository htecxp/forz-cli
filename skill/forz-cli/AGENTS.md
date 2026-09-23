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
forz ping        # key valid? prints "OK" + your read (GET) rate-limit budget
```

- Not installed → `npm install -g forz-cli` (or prefix every command with `npx`, e.g. `npx forz ping`).
- Not authenticated (401 `auth.*`) → `forz login --token fz_<uuid>` (keys are minted in the Forz UI at `/settings/api_keys`; format `fz_<UUIDv7>`). Credentials live in `~/.forz/config.json`.
- A 403 `auth.scope_missing` is not an auth problem: the key works but lacks the scope named in `required_scope`. `forz whoami | jq .api_key.scopes` shows what it has (`<resource>:write` implies read). Ask the user for a key with that scope rather than retrying.
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
- `delete` needs the ETag too (`forz customers delete <id> --if-match '<etag>'`), but the server does **not** check it on DELETE today: a stale ETag still deletes. `get` right before a delete and confirm it's the intended record.
- `update` is a PATCH (partial) — send only the fields you're changing, not the whole object.
- The server **silently ignores body keys it doesn't accept** (misspelled, read-only, or not
  writable on that resource) and still answers 200/201, with no 422. Compare the returned record
  with what you sent before reporting success. Documented-but-ignored today: `custom_fields` on
  sites/contacts/estimates/invoices, job `contact_id`/`schedule_date`, estimate `public_notes`,
  item `active`, task/lead `position`. Customers have no email; update the linked contact.

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
  Dedup is keyed on key **and** body: change the body and the same key creates a *second* invoice. Keys are remembered for 24h; a 5xx is not cached, so a retry after one re-executes.
- **The CLI auto-generated the key** (you didn't pass one, so you don't know what it was) → you **cannot** dedupe a retry. Don't blindly re-run — first **check whether it already exists** (`forz invoices list --filter.customer_id <id> --filter.invoice_date[gte] <date>`) and only create if it's genuinely missing.

The lesson: for any financial create you might need to retry, **control the key yourself**
from the first attempt so a retry is provably safe. Non-financial creates (customers,
jobs, …) don't require a key; pass `--idempotency-key` only when you want the same safety.
`409 idempotency_key.in_use` means a request with the same key and body is **still in
flight**: wait ~2s and retry with the same key (never mint a new one). Omitting the key on a
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

Common allow-lists: `customers` → `q,sort,organization,number,status,created_at`;
`invoices` → `q,sort,customer_id,number,status,invoice_date,due_date`;
`jobs`/`leads`/`deals`/`projects`/`tasks` → `q,sort,created_at,updated_at,status`;
`estimates`/`sales_orders` → `q,sort,created_at,status` (the spec lists `updated_at`, but the
server ignores that filter; `--sort=-updated_at` works).

**An unknown filter key is silently ignored — you get the unfiltered list with a 200.** A
typo like `--filter.stauts Open` returns every row, so sanity-check the rows before any bulk
update or delete. An unknown `--sort` field does return `400 sort.invalid`, and a bad operator
or unparseable value returns `400 filter.invalid`. Changing a filter or `q` mid-pagination
returns `cursor.invalid_filters`; `sort` is simply fixed by the cursor on continuation pages.
Status values are the tenant's own labels — list them with `forz statuses list` when unsure.

Lookups take no `--sort`/`--q`, but `labels`, `statuses` and `custom_field_definitions`
accept `--filter.related_name <Type>` to scope the catalog to one resource type, e.g.
`forz statuses list --filter.related_name Job`. The read-only resources (`assets`,
`vendors`, `tickets`, `purchase_orders`, `recurring_jobs`, `recurring_invoices`) take only
`--limit`/`--cursor` — no sort, search, or filters in this API version (they're ignored, not
rejected).

## Notes (comments on a record)

Every CRUD resource except `items`, and every read-only resource, exposes the web
"Comments" tab as `notes`:

```
forz jobs notes <job-id>                                   # list, paginates like any list
forz jobs notes <job-id> --add "Called back, wants a quote by Friday"   # create
```

`--add` takes plain text and the CLI wraps it as `{"note":{"description":…}}` for you.
Notes need the parent's `<resource>:write` scope to create; a blank body is `422 validation.failed`.
Notes are append-only in v2 — there is no update or delete.

## Body input

Anywhere a `--body` is accepted you can pass JSON three ways:

- inline: `--body '{"organization":"Acme"}'`
- from a file: `--body @./new-customer.json`
- from stdin: `--body @-` (e.g. `cat job.json | forz jobs create --body @-`, or pipe from `jq`)

Shape: send the flat fields from the API spec (`{"organization":"Acme"}`). Typed
`create`/`update` wrap them under the singular resource key (`{"customer":{…}}`) for you, and
an already-wrapped body passes through unchanged. With `forz raw`, wrap it yourself
(`{"job":{…,"lineitems":[…]}}`, `{"project":{"user_ids":[…]}}`): the server silently drops a
flat `lineitems` / `user_ids` and answers 201/200 with nothing attached.

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

Common codes:

- `validation.failed` (fix the body), `resource.not_found` (bad id).
- `precondition.failed` (412 — stale ETag, re-`get`), `precondition.required` (428 — missing `--if-match`, only via `raw`).
- `rate_limit.exceeded` (429 — wait the seconds given in the error `detail`, "Retry after N seconds."; reads and writes have separate budgets and `forz ping` shows only the read one).
- `idempotency_key.required` (400), `idempotency_key.in_use` (409 — same key still in flight; wait and retry with the same key).
- `auth.missing_token` / `auth.invalid_token` / `auth.failed` (401 — key missing, wrong, expired or revoked; the user must `forz login` with a valid key).
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
forz contacts create  --body '{"first_name":"Ana","last_name":"Diaz","linkable_type":"Customer","linkable_id":"<customer-id>"}'
```
`customers` also accept `reference` — a partner-defined external id — on create/update.

- A contact is attached via `linkable_type` (`Customer`, `Lead` or `Site`) + `linkable_id`, on
  **create only**. Never put `linkable_*` in an update body (re-link isn't supported and the
  server errors), and don't send `customer_id` — contacts have none, so it's silently dropped.
- On tenants with the System module on, a job/estimate/invoice/sales order with a `site_id` also
  needs a `system_id` on that site (422 `system_id: is required`). Systems aren't in the published
  spec yet: list them with `forz raw '/api/v2/systems?site_id=<site-id>'` (needs `systems:read`).

**Line items (`lineitems` on jobs / estimates / invoices / sales orders):** each new entry
needs `item_id` **and** `description` — a new line missing either is silently discarded (no
422), so check the response. Via `forz raw`, `lineitems` must sit inside the resource key
(`{"invoice":{…,"lineitems":[…]}}`); see Body input. `unit_price` is optional on new lines — omit it and the server resolves the
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
- Mutations are real writes against the user's account — there is a single environment (no test mode), so run `forz whoami` to confirm the target account first and confirm destructive actions (`delete`, bulk updates) before running them.
