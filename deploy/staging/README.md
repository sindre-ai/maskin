# Staging

A second Maskin stack that sits next to production on the same hardware. It
exists for measurements that must not run against production (Spike 0 of the
Agent Keychain bet, and later the Keychain smoke rows).

Two parts:

1. **App, Postgres and storage** in Coolify, from `docker-compose.staging.yml`.
2. **Agent server** as a second systemd unit on the production agent host,
   installed by `.github/workflows/agent-server-staging-deploy.yml`.

## Hard rules

- **AGENT_SERVER_ID stays unset** on the staging agent server. Set, it runs the
  boot-time reconcile pass, which does a host-wide `msb list` and
  `msb remove -f` on every sandbox the staging database does not own. That is
  every live production sandbox. The workflow refuses to deploy if it is set.
- **Nothing for staging goes under `apps/agent-server/**`.** The production
  deploy triggers on that path, and a production agent-server redeploy reports
  staging sandboxes to production, which removes them. Do not run
  measurements during a production agent-server deploy.
- **The staging database holds one agent server row**, the staging one, so
  dispatch can never pick production's server on :3001.

## One-time setup (Coolify)

1. New app from this repo, compose file `/docker-compose.staging.yml`, own
   domain, own volumes (the compose creates per-app ones).
2. Env on the app (secrets pasted, never in the repo):
   - `POSTGRES_PASSWORD`, `INTEGRATION_ENCRYPTION_KEY`
   - `AGENT_SERVER_SECRET` (16+ chars, same value as the GitHub secret below)
   - `AGENT_SERVERS`, only the staging server:
     `http://<agent-host>:3002|<AGENT_SERVER_SECRET value>`
   - `AGENT_SERVER_MAX_SESSIONS=5`
   - `MASKIN_BACKEND_URL`, `MASKIN_PUBLIC_URL`, `APP_URL`: the staging URL
   - `MASKIN_FALLBACK_OPENROUTER_KEY` (model login, a static key)
3. The staging app must reach `<agent-host>:3002`, and the agent host must
   reach the staging URL.

## One-time setup (GitHub)

- Repo secret `STAGING_AGENT_SERVER_SECRET`: same value as `AGENT_SERVER_SECRET`.
- Repo variable `STAGING_MASKIN_BASE_URL`: the staging URL, `https://...`
  (or pass `maskin_base_url` when dispatching).
- Optional: `STAGING_S3_ENDPOINT`, `STAGING_S3_BUCKET`, `STAGING_S3_REGION`
  (variables) and `STAGING_S3_ACCESS_KEY`, `STAGING_S3_SECRET_KEY` (secrets).
- The existing `AGENT_SERVER_HOST`, `AGENT_SERVER_USER`,
  `AGENT_SERVER_SSH_KEY` secrets are reused.

## Deploy

Actions, "Deploy agent-server (staging)", Run workflow (default ref: main).
Dispatch is the only trigger. To deploy a branch, put it in the `ref` input.
The workflow bootstraps `/opt/maskin-staging`, writes
`/etc/maskin-staging/agent-server.env`, installs
`maskin-agent-server-staging.service` (port 3002, metrics off), restarts only
that unit and health-checks `:3002`.

## Staging workspace

After the app is up, create a workspace and agent actors with API keys in
staging. Session launch throws if an agent's API key is null.
