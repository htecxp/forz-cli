# Bug: `POST /api/v2/contacts` silently drops `linkable_id` + `linkable_type`

**API:** Forz Public API V2 — spec version `2026-04-30`
**Endpoint:** `POST /api/v2/contacts`
**Severity:** High — documented linkage feature is non-functional. Contacts created via the public API are orphaned and **cannot be re-linked** (per `ContactUpdateInput` description: "`linkable_*` is set-once at create — re-link is not yet exposed via v2").

## Expected behavior

Per `ContactCreateInput` in the OpenAPI spec:

> "Pass `linkable_id` + `linkable_type` to attach the contact to a Customer / Lead / Site as the primary linkage in the same request."

```
linkable_id    integer (int64)              Parent record ID to attach to.
linkable_type  enum: Customer|Lead|Site     Parent record class name.
```

The created contact should be persisted with the supplied `linkable_id` / `linkable_type`.

## Actual behavior

`HTTP 201` is returned, but `linkable_id` and `linkable_type` come back `null`. The contact is persisted but unattached, and the documented surface offers no way to attach it after the fact.

## Reproduction (raw curl, bypassing forz-cli)

```bash
curl -X POST https://app.forz.io/api/v2/contacts \
  -H "Authorization: Bearer fz_live_<…>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "linkable_id": 1029130,
    "linkable_type": "Customer",
    "first_name": "CurlTest",
    "last_name": "Direct",
    "title": "Owner"
  }'
```

Response — `HTTP 201`:

```json
{
  "data": {
    "id": 1055306,
    "first_name": "CurlTest",
    "last_name": "Direct",
    "title": "Owner",
    "linkable_id": null,
    "linkable_type": null,
    "email": null,
    "phone": null,
    "mobile": null,
    "contact_method": null,
    "custom_fields": {},
    "created_at": "2026-05-11T10:42:51.629Z",
    "updated_at": "2026-05-11T10:42:51.629Z"
  }
}
```

Target customer `1029130` exists (`GET /api/v2/customers/1029130` → 200).

## Variants tried (all returned HTTP 201 with linkage nulled)

| Body shape | Result |
|---|---|
| `{linkable_id, linkable_type}` (per spec) | `linkable_id: null` |
| `{linkable: {id, type}}` (nested) | `linkable_id: null` |
| `{customer_id}` | `linkable_id: null` |
| `{customer: {id}}` (nested) | `linkable_id: null` |
| `{contactable_id, contactable_type}` | `linkable_id: null` |
| `POST /api/v2/customers/{id}/contacts` | HTTP 500 |
| `PATCH /api/v2/contacts/{id}` with `{linkable_id, linkable_type}` | HTTP 400 |
| `POST /api/v2/customers` with inline `{contacts: [...]}` | Customer created, no contact attached |
| `PATCH /api/v2/customers/{id}` with `{contacts_attributes: [...]}` | HTTP 400 |

## Affected tenant records (created during repro)

Customer IDs: `1029130`, `1029131`, `1029132`
Orphan contact IDs: `1055295`, `1055296`, `1055297`, `1055298–1055302`, `1055306`

## Likely cause

The endpoint appears to filter inbound params through a strong-params allowlist that excludes the polymorphic linkage fields. Verify the contacts controller's permitted-params list includes `:linkable_id` and `:linkable_type` and that the model accepts mass assignment of the polymorphic association.

If the omission is intentional (v2 not yet exposing linkage), update `ContactCreateInput`'s description in the OpenAPI spec so it stops promising behavior the server doesn't deliver — and ideally return `422` instead of silently dropping the fields.
