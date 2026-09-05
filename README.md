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

Credentials live in `~/.forz/config.json` (mode 0600).

## Resources

| Group        | Resources                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Full CRUD    | `customers`, `sites`, `contacts`, `jobs`, `estimates`, `invoices`, `sales_orders`, `items`, `tasks`, `leads`, `deals`, `projects` |
| Lookups (RO) | `payment_terms`, `tax_rates`, `job_types`, `item_categories`, `system_options`, `labels`, `statuses`, `custom_field_definitions`  |

Each CRUD resource supports `list | get | create | update | delete`. Lookups are list-only,
except `custom_field_definitions`, which also supports `get <id>`.

## API conventions baked in

The CLI enforces the Forz v2 conventions automatically:

- **Bearer auth** with `fz_<UUIDv7>` keys.
- **Pagination** via HMAC-signed cursors. `--limit` is capped server-side at 100 (default 25). The CLI prints
  the cursor for the next page on stderr when `has_more` is true.
- **Filtering, sorting & search:** every CRUD `list` accepts `--sort <field>` (ascending; use
  `--sort=-field` for descending), `--q <text>` free-text search, and `--filter.<key> <value>` (with operators
  `--filter.<key>[gte|lte|gt|lt|ne|in] <value>`). Each endpoint allow-lists its own fields; an unknown field
  returns `400 filter.invalid` / `sort.invalid`. Lookups `labels`, `statuses` and `custom_field_definitions`
  accept `--filter.related_name <Type>`.
- **Optimistic concurrency:** `update` and `delete` require `--if-match <etag>`. Run `forz <resource> get <id>`
  first — the weak ETag (`W/"<epoch>-<lock>"`, e.g. `W/"1745596800-3"`) is printed on stderr; quote it whole
  in the shell.
- **Idempotency:** financial creates (`invoices`, `sales_orders`) auto-generate an
  `Idempotency-Key`; override with `--idempotency-key <key>`.
- **Errors:** the CLI surfaces RFC 9457 `application/problem+json` bodies and the stable, dotted `code` field
  (e.g. `validation.failed`, `resource.not_found`) on non-2xx responses.

## Common commands

```
forz login --token fz_<uuid> [--base-url https://staging.forz.io]
forz logout
forz whoami                                     # confirm this key's account/user before mutating
forz ping                                       # authenticated health check
forz config show
forz config set baseUrl https://staging.forz.io

forz <resource> list [--limit N] [--cursor C] [--sort <field>] [--q <text>] [--filter.<key> <val> ...]
forz <resource> get <id>                        # prints ETag on stderr
forz <resource> create --body JSON|@file|@-     # @- reads stdin
forz <resource> update <id> --if-match <etag> --body JSON|@file
forz <resource> delete <id> --if-match <etag>

forz custom_field_definitions get <id>          # gettable lookup

forz raw <path> [--method M] [--body J] [--header.<H> <V>]
```

## Library use

```ts
import { ForzClient } from 'forz-cli'

const client = new ForzClient({ token: process.env.FORZ_TOKEN })

const page = await client.resource('customers').list({ limit: 25 })
for (const c of page.data) console.log(c.id, c.organization)
while (page.hasMore && page.nextCursor) { /* fetch next */ }

const { data: customer, etag } = await client.resource('customers').get('0190a1b2-9c3d-7e4f-8a1b-2c3d4e5f6071')
await client.resource('customers').update(customer.id, { organization: 'New name' }, { ifMatch: etag! })

await client.resource('invoices').create({ /* ... */ })  // Idempotency-Key auto-set
```

## Use with Claude Code, Codex & other AI agents

This package ships agent instructions that teach a coding agent to drive the `forz` CLI
correctly — the ETag/If-Match flow, idempotency on financial creates, cursor pagination, and
RFC 9457 error handling. The same guidance is provided in two formats (`SKILL.md` is the
source of truth; `AGENTS.md` is generated from it):

| Agent | File | Install |
| ----- | ---- | ------- |
| **Claude Code** | `skill/forz-cli/SKILL.md` (+ packaged `skill/forz-cli.skill`) | copy into `~/.claude/skills/forz-cli/` |
| **OpenAI Codex** (and other [`AGENTS.md`](https://agents.md)-compatible agents) | `skill/forz-cli/AGENTS.md` | append to your project's `AGENTS.md` or `~/.codex/AGENTS.md` |

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
