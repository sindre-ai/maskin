---
title: MCP sign-in for Claude (OAuth)
slug: mcp-oauth
description: How Claude discovers and completes Maskin's MCP sign-in, what /mcp answers without a credential, the pinned Claude client record, the consent and token routes, how a connection ends, and the switch and flag that control it.
last_updated: 2026-10-14
---

# MCP sign-in for Claude (OAuth)

The MCP server at `/mcp` accepts API keys (`ank_`) and, when the switch below is on, Claude connector tokens (`mat_`). This page covers what Claude needs in order to find the sign-in, the routes that complete it, and how a connection ends. Token acceptance lives in `packages/auth`.

## Environment variables and the flag

- `MASKIN_MCP_OAUTH_ENABLED` — the kill switch. Unset or anything other than `true` / `1` means off. Both variables are passed through `turbo.json` (`globalPassThroughEnv`) and listed on the `apps/dev` service in `docker-compose.yml` and `docker-compose.prod.yml`.
- `MASKIN_OAUTH_ISSUER` — optional origin override, no trailing slash needed. Defaults to the web app origin (`WEB_APP_URL`, then `FRONTEND_URL`, then `https://maskin.io`). Set it in local dev, for example `http://localhost:3000`. The issuer and the `/mcp` resource in every document below follow it, per request.
- Feature flag `mcp-oauth-consent` (`FLAGS.MCP_OAUTH_CONSENT` in `apps/dev/src/lib/feature-flags.ts`), off by default. It gates what a person does: `GET /api/oauth/authorize/preview`, `POST /api/oauth/authorize/approve` and `POST /api/oauth/authorize/deny` answer `403 access_denied` unless the actor is listed in `FF_TESTER_ACTOR_IDS` and the id is in `FF_TESTER_FEATURES`. Agent actors always get the same 403.

What each control covers:

| Control | New connections (preview, approve, deny, token) | Existing tokens | List and disconnect |
| --- | --- | --- | --- |
| `MASKIN_MCP_OAUTH_ENABLED` off | stop (404) | stop working | still work |
| Flag off for the person | stop for them (403) | keep working | still work |

Listing and disconnecting a connection is never behind the switch or the flag: a person must always be able to see and remove what they connected.

## Switch off (the default)

- `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-authorization-server` answer 404.
- `POST /mcp` behaves exactly as before for every caller. A `mat_` bearer gets today's 401 from the API.

## Switch on

Discovery documents (public, no database, `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=3600`):

- Protected resource (both paths): `resource` = issuer + `/mcp`, `authorization_servers` = [issuer], `scopes_supported` = [`mcp`], `bearer_methods_supported` = [`header`], `resource_name` = `Maskin`.
- Authorization server: `issuer`, `authorization_endpoint` = issuer + `/oauth/authorize`, `token_endpoint` = issuer + `/oauth/token`, `code_challenge_methods_supported` = [`S256`], `token_endpoint_auth_methods_supported` = [`none`], `client_id_metadata_document_supported` = `true`, `authorization_response_iss_parameter_supported` = `true`. There is no `registration_endpoint` on purpose: Claude only skips dynamic client registration when it sees both `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported`.

`POST /mcp` answers 401 with no database access when the caller sends no `Authorization` header, a header that is not `Bearer `, or an empty bearer:

    WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource/mcp", scope="mcp"
    {"jsonrpc":"2.0","error":{"code":-32001,"message":"Authentication required"},"id":null}

An invalid or expired `mat_` token gets the same 401 with `error="invalid_token"` added to the header. An invalid `ank_` key is unchanged: it reaches the transport as before. `GET` and `DELETE` on `/mcp` stay a bare 405 with no database access. `Access-Control-Expose-Headers` on `/mcp` includes `WWW-Authenticate` so browser clients can read the challenge.

Behaviour change to know about: an unauthenticated `initialize` or `tools/list` used to succeed and now gets the 401.

## The pinned Claude client record

`MCP_OAUTH_PINNED_CLIENTS` in `packages/shared/src/constants/mcp-oauth.ts` is the only source for the client id, name and redirect addresses in v1. Claude only. `resolvePinnedClient` (`apps/dev/src/lib/oauth-server/client-record.ts`) matches the `client_id` and the `redirect_uri` by exact string equality, checks the client id first, and makes no outbound request.

`scripts/checks/claude-client-drift.ts` runs weekly from `.github/workflows/claude-client-drift.yml`. It compares the pin with the document Claude publishes and opens an insight when they differ. It does not change runtime behaviour and always finishes green. To let it open the insight, set the repository secrets `MASKIN_DRIFT_API_URL`, `MASKIN_DRIFT_API_KEY` and `MASKIN_DRIFT_WORKSPACE_ID`; without them it only prints the difference.

## The consent and connections routes

All under `/api/oauth`, behind `authMiddleware` with the person's own `ank_` key. A Claude token (`mat_`) is refused on every one of them (403): a connected client must not approve its own access.

- `GET /authorize/preview` checks the request in a fixed order (client id, then redirect address, both exact matches against the pinned record, then everything else) and returns the client, the person's workspaces with their role, and the scope.
- `POST /authorize/approve` takes the same parameters plus `workspace_id`. It creates the connection and a 60 second one-time code and returns `redirect_url` with `code`, `state` and `iss` (RFC 9207). One live connection per person, workspace and client: approving again ends the old one and its tokens in the same transaction.
- `POST /authorize/deny` takes the same parameters (and optionally the `workspace_id` the person had picked, used only for the funnel) and returns the `access_denied` redirect. It writes no database rows.
- `GET /grants` lists the person's connections to the pinned Claude client across their workspaces, one row per workspace: `id`, `client_id`, `client_name`, `workspace_id`, `workspace_name` (joined from the workspace), `created_at`, `last_used_at`. A row appears only when the connection is not revoked, its refresh token can still be used (the same check the token endpoint runs, `isGrantRefreshable` in `apps/dev/src/lib/oauth-server/grants.ts`) and the person still belongs to the workspace. `last_used_at` is null until the first tool call.
- `DELETE /grants/:id` ends one of the caller's own connections and every token on it at once.

Preview, approve and deny answer 404 when the switch is off and 403 `access_denied` when the flag is off or the caller is not a person. They are limited to 30 calls a minute per person.

Errors from preview, approve and deny are `{ error, error_description, redirect_url? }` with one of seven codes. `client_not_allowlisted` and `bad_redirect_uri` are identity codes and never carry a link. `pkce_missing`, `invalid_request`, `unsupported_response_type`, `invalid_scope` and `invalid_target` carry `redirect_url`: built from the pinned redirect address, never from the request's, with the matching OAuth error (`pkce_missing` goes back as `invalid_request`) and `state` only if it is 8 to 512 printable characters, always as an encoded query parameter. The field is absent, not empty, when there is no verified link.

## The token endpoint

`POST /oauth/token` is public (the code, its PKCE verifier or the refresh token is the credential), form-encoded, and answers 404 when the switch is off. Every response carries `Cache-Control: no-store` and `Pragma: no-cache`. Errors are RFC 6749's. It is limited to 30 calls a minute per client address.

- `grant_type=authorization_code`: the code is consumed in one statement, so of two simultaneous presentations exactly one wins. Presenting a used code again ends the connection (reason `code_reuse`). The redirect address must equal the one approved, and the PKCE check (S256, constant time) failing ends the connection (reason `pkce_failure`).
- `grant_type=refresh_token`: the refresh token is rotated. There is no grace window: presenting a used refresh token again ends the whole connection (reason `refresh_reuse`) and sends the PostHog event `oauth_refresh_reuse_revoked`.
- Success: `{ access_token: "mat_...", token_type: "Bearer", expires_in: 3600, refresh_token: "mrt_...", scope: "mcp" }`.

Lifetimes are constants in `packages/shared`: access token 3600 s, refresh token 2592000 s (30 days, sliding: each refresh sets a new 30 days), code 60 s. There is no absolute limit on a connection. It ends when the person disconnects it, when they are removed from the workspace (reason `member_removed`), on reuse, or after 30 days with no refresh.

Codes expired for over a day and tokens expired for over a week are deleted hourly by `apps/dev/src/services/oauth-sweeper.ts`. Connections themselves are kept as the audit record.

## Audit and measurement

Every change is an `events` row with `entity_type` `oauth_grant` through `recordEvent`: `oauth_grant_created`, `oauth_token_issued`, `oauth_token_refreshed`, `oauth_grant_revoked`, `oauth_code_reuse_detected`, `oauth_refresh_reuse_detected`. No token, code or hash is ever in `data`.

PostHog events are sent from the route that makes each decision, always after sign-in (the page sends none, and no server route sees anyone before sign-in, so drop-off before sign-in is not measured; the funnel starts at `mcp_oauth_authorize_started`). Every event carries `client` (the fixed label for the pinned client, `claude_ai`) and the distinct id is the actor id:

- `mcp_oauth_authorize_started`: preview succeeded. Also `workspace_count`.
- `mcp_oauth_preview_rejected`: preview refused. `reason` is one of the seven request codes or `rate_limited`; `client` is left out when the `client_id` did not match the pin. Flag off and switch off are not events.
- `mcp_oauth_consent_approved`: `workspace_id`, `grant_id`.
- `mcp_oauth_consent_denied`: `workspace_id` only when the person had picked one of their own.
- `mcp_oauth_token_issued`: the code was traded. `workspace_id`, `grant_id`, `grant_type` (`authorization_code`).
- `mcp_oauth_token_refreshed`: `workspace_id`, `grant_id`.
- `mcp_oauth_token_rejected`: `reason` is one of `invalid_request`, `unsupported_grant_type`, `code_unknown_or_expired`, `code_reuse`, `pkce_failed`, `redirect_mismatch`, `resource_mismatch`, `refresh_unknown_or_expired`, `refresh_revoked`, `rate_limited`; `grant_id` when a grant resolved. With no grant to attribute it to, the distinct id is the fixed string `oauth-unresolved` with `$process_person_profile` false.
- `oauth_refresh_reuse_revoked`: `grant_id`, `grant_age_s`, `seconds_since_first_use`. Refresh reuse is not a reason on `mcp_oauth_token_rejected`.

Never in any property: a token, code, state, code challenge, verifier, redirect address or hash. `mat_` and `mrt_` values are also blanked in Sentry (`apps/dev/src/lib/sentry-scrub.ts`) and in the agent-server log redaction.
