# Notes for forz-cli maintainers

## Spec divergence: contacts cannot be linked at create time

The Forz Public API v2 (`2026-04-30`) advertises `linkable_id` + `linkable_type`
on `POST /api/v2/contacts` to attach a contact to a Customer / Lead / Site, but
the server silently drops both fields and returns `HTTP 201` with
`linkable_id: null, linkable_type: null`. `PATCH /api/v2/contacts/:id` returns
`400` for the same fields, and `ContactUpdateInput`'s own description states
re-link is not exposed in v2.

Confirmed with raw `curl` (so it isn't a forz-cli body-serialization bug). See
`BUG-forz-api-contacts-linkage.md` in this directory for the full report sent
to Forz.

### Implication for forz-cli users

Anyone trying `forz contacts create --body '{"linkable_id":…, "linkable_type":"Customer", …}'`
will get an orphaned contact with no error and no way to attach it through the
public API. Worth documenting until Forz fixes it server-side — e.g. a note in
README's `contacts` row, or a runtime warning when the response contains a
nulled `linkable_*` after the request explicitly set it.
