# Documented, not recorded

These bodies are written from Unipile's v2 reference pages. None was recorded from a live
account: nobody has been able to call Unipile from an agent environment (CTO decision on the
action log task, 22 Oct 2026). Treat them as our reading of the docs, not as evidence of what
LinkedIn returns. After the first deploy, the shipped read tools get run once on a connected
account and the raw results replace these files (follow-up task).

What each one pins:

- `user-posts.person.json`: `GET /v2/{account_id}/users/{provider_id}/posts` for a person.
- `user-posts.company.json`: the same route for a company id (a numeric id is a company page).
- `profile.by-handle.json`: `GET /v2/{account_id}/users/{public_handle}`, the lookup that turns
  a handle into a provider id before the posts call.
- `company-profile.json`: `GET /v2/{account_id}/linkedin/company/{id_or_slug}`.

Open points only a live call settles: whether the posts route also accepts a public handle (if so
the lookup can go), what `reactions_counter` items look like, and whether a company id works as
`user_id`.
