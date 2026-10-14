---
title: MCP sign-in for Claude (OAuth)
slug: mcp-oauth
description: How Claude discovers Maskin's MCP sign-in, what /mcp answers without a credential, the pinned Claude client record, and the two environment variables that control it.
last_updated: 2026-10-14
---

# MCP sign-in for Claude (OAuth)

The MCP server at `/mcp` accepts API keys (`ank_`) and, when the switch below is on, Claude connector tokens (`mat_`). This page covers what Claude needs in order to find the sign-in. The token side lives in `packages/auth`.

## Environment variables

- `MASKIN_MCP_OAUTH_ENABLED` — the kill switch. Unset or anything other than `true` / `1` means off. Both variables are passed through `turbo.json` (`globalPassThroughEnv`) and listed on the `apps/dev` service in `docker-compose.yml` and `docker-compose.prod.yml`.
- `MASKIN_OAUTH_ISSUER` — optional origin override, no trailing slash needed. Defaults to the web app origin (`WEB_APP_URL`, then `FRONTEND_URL`, then `https://maskin.io`). Set it in local dev, for example `http://localhost:3000`. The issuer and the `/mcp` resource in every document below follow it, per request.

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
