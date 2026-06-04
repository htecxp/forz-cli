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

1. Mint an API key in the Forz UI at **/settings/api_keys** (format: `fz_live_<UUIDv7>` or `fz_test_<UUIDv7>`).
2. Save it locally:

   ```
   forz login --token fz_live_018f4c7e-9a2b-7f3a-bd9e-1a2b3c4d5e6f
   forz ping       # auth-check
   ```

3. Use it:

   ```
   forz customers list --limit 50
   forz customers get cust_01J9Z...
   forz jobs create --body @new-job.json
   forz invoices create --body @invoice.json      # auto Idempotency-Key
   forz customers update <id> --if-match '"abc"' --body '{"name":"New"}'
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

- **Bearer auth** with `fz_(live|test)_<UUIDv7>` keys.
- **Pagination** via HMAC-signed cursors. `--limit` is capped server-side at 100 (default 25). The CLI prints
  the cursor for the next page on stderr when `has_more` is true.
- **Optimistic concurrency:** `update` and `delete` require `--if-match <etag>`. Run `forz <resource> get <id>`
  first — the ETag is printed on stderr.
- **Idempotency:** financial creates (`invoices`, `sales_orders`) auto-generate an
  `Idempotency-Key`; override with `--idempotency-key <uuid>`.
- **Errors:** the CLI surfaces RFC 9457 `application/problem+json` bodies and the stable `code` field on
  non-2xx responses.

## Common commands

```
forz login --token fz_live_<uuid> [--base-url https://staging.forz.io]
forz logout
forz ping                                       # authenticated health check
forz config show
forz config set baseUrl https://staging.forz.io

forz <resource> list [--limit N] [--cursor C] [--filter.<key> <val> ...]
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
for (const c of page.data) console.log(c.id, c.name)
while (page.hasMore && page.nextCursor) { /* fetch next */ }

const { data: customer, etag } = await client.resource('customers').get('cust_01J...')
await client.resource('customers').update(customer.id, { name: 'New' }, { ifMatch: etag! })

await client.resource('invoices').create({ /* ... */ })  // Idempotency-Key auto-set
```

## Development

```
yarn install
yarn build      # tsc -> dist/
yarn test       # jest
yarn lint
```

## License

MIT
