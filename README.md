# forz-cli

A zero-dependency TypeScript CLI for the [Forz Public API v2](https://app.forz.io)
— the field service management platform.

Project structure modeled on [printing-press](https://github.com/impadalko/printing-press):
no runtime dependencies, TypeScript compiled to `dist/`, exposed via `bin/index.js`.

## Install

```
yarn add forz-cli
# or
npm install forz-cli
```

Then `npx forz <command>` or, if installed globally, `forz <command>`.

## Quick start

1. Mint an API key in the Forz UI at **/settings/api_keys** (format: `fz_<UUIDv7>`).
2. Save it locally:

   ```
   forz login --token fz_018f4c7e-9a2b-7f3a-bd9e-1a2b3c4d5e6f
   forz whoami     # confirm which account/user the key belongs to
   forz ping       # auth-check
   ```

3. Use it:

   ```
   forz customers list --limit 50
   forz customers get 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071
   forz jobs create --body @new-job.json
   forz invoices create --body @invoice.json      # auto Idempotency-Key
   forz customers update <id> --if-match 'W/"1745596800-3"' --body '{"organization":"New name"}'
   ```

Credentials live in `~/.forz/config.json` (mode 0600). `FORZ_TOKEN` and `FORZ_BASE_URL`
override the saved config, and `--token` / `--base-url` override both (flag > env > config).

## Resources

| Group        | Resources                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Full CRUD    | `customers`, `sites`, `contacts`, `jobs`, `estimates`, `invoices`, `sales_orders`, `items`, `tasks`, `leads`, `deals`, `projects` |
| List/create  | `systems` (`list --filter.site_id` / `--filter.customer_id`, `create`)                                                            |
| Read-only    | `assets`, `vendors`, `tickets`, `purchase_orders`, `recurring_jobs`, `recurring_invoices`                                         |
| Lookups (RO) | `payment_terms`, `tax_rates`, `job_types`, `item_categories`, `system_options`, `labels`, `statuses`, `custom_field_definitions`  |

Each CRUD resource supports `list | get | create | update | delete | notes` (`items` has no `notes`). Read-only resources
support `list | get | notes` (`notes <id>` lists comments, `notes <id> --add <text>` adds one). Lookups are list-only,
except `custom_field_definitions`, which also supports `get <id>`. `forz <resource> --help` shows one
resource's commands. Contacts also have a `linkages` sub-resource (see below).

> **`contacts` — check the parent linkage.** `forz contacts create` prints a stderr warning when
> `linkable_id` / `linkable_type` you sent are missing from the created record (stdout stays clean
> JSON, exit code zero). `PATCH` ignores those fields; attach it with
> `forz contacts linkages <id> --add --body '{"linkable_type":"Customer","linkable_id":"<uuid>"}'`.

## API conventions baked in

The CLI enforces the Forz v2 conventions automatically:

- **Bearer auth** with `fz_<UUIDv7>` keys.
- **Pagination** via HMAC-signed cursors. `--limit` max 100 (default 25); above that is `400 pagination.limit_too_large`, not clamped. The CLI prints
  the cursor for the next page on stderr when `has_more` is true.
- **Filtering, sorting & search:** every CRUD `list` accepts `--sort <field>` (ascending; use
  `--sort=-field` for descending), `--q <text>` free-text search, and `--filter.<key> <value>` (with operators
  `--filter.<key>[gte|lte|gt|lt|in] <value>`). Each endpoint allow-lists its own fields: an unknown sort
  field returns `400 sort.invalid`, and an unknown filter/query key returns `400 filter.invalid` naming the
  allowed keys. Read-only resources take only `--limit`/`--cursor`. Lookups `labels`, `statuses` and
  `custom_field_definitions` accept `--filter.related_name <Type>`.
- **Body envelope:** `create`/`update` send the body under the singular resource key (`{"job": {...}}`).
  Flat fields or the wrapped form both work.
- **Optimistic concurrency:** `update` and `delete` require `--if-match <etag>`. Run `forz <resource> get <id>`
  first — the weak ETag (`W/"<epoch>-<lock>"`, e.g. `W/"1745596800-3"`) is printed on stderr; quote it whole
  in the shell. The server enforces it on PATCH and DELETE (`428` missing, `412` stale).
- **Idempotency:** financial creates (`invoices`, `sales_orders`) auto-generate an
  `Idempotency-Key`; override with `--idempotency-key <key>`. When such a create fails, the key is printed on
  stderr so you can retry it with the same body (except `409 idempotency_key.in_use`: that key was already used
  with a different body, so send the original body or use a new key).
- **Retries & timeouts:** `429` is retried a bounded number of times, honoring `Retry-After`; `502`/`503`/`504`
  too, but only for GETs and requests with an `Idempotency-Key`, so a write is never replayed.
  Requests time out after 30s; change it with `--timeout <seconds>` or `FORZ_TIMEOUT`.
- **Exit codes:** `0` success, `1` API/network error, `2` usage error.
- **Errors:** the CLI surfaces RFC 9457 `application/problem+json` bodies and the stable, dotted `code` field
  (e.g. `validation.failed`, `resource.not_found`) on non-2xx responses.

## Common commands

```
forz --version
forz login --token fz_<uuid> [--base-url http://localhost:3000]
forz logout
forz whoami                                     # confirm this key's account/user before mutating
forz ping                                       # key check via /me + read rate-limit budget
forz config show
forz config set baseUrl http://localhost:3000
forz <any command> --base-url http://localhost:3000 --token fz_…   # one-off override (also FORZ_BASE_URL / FORZ_TOKEN)
forz <resource> --help

forz <resource> list [--limit N] [--cursor C] [--sort <field>] [--q <text>] [--filter.<key> <val> ...]
forz <resource> get <id>                        # prints ETag on stderr
forz <resource> create --body JSON|@file|@-     # @- reads stdin
forz <resource> update <id> --if-match <etag> --body JSON|@file
forz <resource> delete <id> --if-match <etag>

forz <resource> notes <id> [--limit N] [--cursor C]   # list comments on a record
forz <resource> notes <id> --add "<text>"               # add a comment
forz custom_field_definitions get <id>          # gettable lookup

forz customers update <id> --if-match <etag> --body '{"custom_fields":{"Tier":"Gold"}}'   # field label or id
forz customers list '--filter.custom_fields[Tier]' Gold            # quote in zsh
forz customers attach <id> "Contract" --file ./contract.pdf --if-match <etag>

forz contacts linkages <id>                     # list the records a contact is linked to
forz contacts linkages <id> --add --body '{"linkable_type":"Customer","linkable_id":"<uuid>"}'
forz contacts linkages <id> --update <linkage_id> --body '{"primary":true}'
forz contacts linkages <id> --delete <linkage_id>

forz systems list --filter.site_id <site-id>
forz systems create --body '{"site_id":"<uuid>","system_option_id":"<uuid>"}'

forz raw <path> [--method M] [--body J] [--header.<H> <V>] [--include]   # --include prints status + headers
```

`raw` sends your token only to the configured base URL's origin; it refuses an absolute URL on
another host.

## Library use

```ts
import { ForzClient } from 'forz-cli'

const client = new ForzClient({ token: process.env.FORZ_TOKEN })

const page = await client.resource('customers').list({ limit: 25 })
for (const c of page.data) console.log(c.id, c.organization)
while (page.hasMore && page.nextCursor) {
  /* fetch next */
}

const { data: customer, etag } = await client
  .resource('customers')
  .get('0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071')
await client
  .resource('customers')
  .update(customer.id, { organization: 'New name' }, { ifMatch: etag! })

await client.resource('invoices').create({
  /* ... */
}) // Idempotency-Key auto-set
```

## Use with Claude Code, Codex & other AI agents

This package ships agent instructions that teach a coding agent to drive the `forz` CLI
correctly — the ETag/If-Match flow, idempotency on financial creates, cursor pagination, and
RFC 9457 error handling. The same guidance is provided in two formats (`SKILL.md` is the
source of truth; `AGENTS.md` is generated from it):

| Agent                                                                           | File                                                          | Install                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| **Claude Code**                                                                 | `skill/forz-cli/SKILL.md` (+ packaged `skill/forz-cli.skill`) | copy into `~/.claude/skills/forz-cli/`                       |
| **OpenAI Codex** (and other [`AGENTS.md`](https://agents.md)-compatible agents) | `skill/forz-cli/AGENTS.md`                                    | append to your project's `AGENTS.md` or `~/.codex/AGENTS.md` |

```
# Claude Code — install as a skill
mkdir -p ~/.claude/skills/forz-cli
cp node_modules/forz-cli/skill/forz-cli/SKILL.md ~/.claude/skills/forz-cli/

# OpenAI Codex — append the instructions to your AGENTS.md
cat node_modules/forz-cli/skill/forz-cli/AGENTS.md >> AGENTS.md   # or ~/.codex/AGENTS.md
```

Then ask the agent things like "look up customer 0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071 in Forz" or "create an invoice
from invoice.json" and it will use the CLI following the platform's conventions. The
instructions defer to `forz help` for the authoritative command surface, so they stay correct
across CLI updates. Both formats are kept in sync by `skill/sync-skill-docs.sh`.

## Development

```
yarn install
yarn build      # tsc -> dist/
yarn test       # jest
yarn lint
```

## License

MIT
