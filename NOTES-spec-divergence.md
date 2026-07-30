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
public API.

**Handled (client-side) as of `feat/contacts-linkage-warning`:**

- `linkageWarning()` in `src/lib/commands` compares the linkage fields the request
  set against the created record, and `forz contacts create` prints a `# warning:`
  line on stderr when they came back null or absent. stdout stays clean JSON and
  the exit code stays zero — the server returned `201`, so this is a caveat, not
  an error.
- Documented in README's Resources section and in `skill/forz-cli/SKILL.md`
  (regenerate `AGENTS.md` via `skill/sync-skill-docs.sh` after editing SKILL.md).

The check keys off the *symptom* in the response, not off a hardcoded assumption
that the server is broken, so it stops firing by itself once Forz starts echoing
the linkage back — no client release needed. Note that the silent-drop behaviour
has not been re-confirmed against the live API since the integer→UUID v7 id
migration; re-verify before escalating the bug report again.
