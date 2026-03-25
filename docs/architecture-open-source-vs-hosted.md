# Architecture: Open Source vs Hosted

## What We Already Have

The codebase uses provider-agnostic abstractions throughout:

- **Database**: Drizzle ORM + `DATABASE_URL` environment variable. Works with any PostgreSQL — local, Supabase, Neon, etc. Standard SQL, no provider-specific features.
- **Storage**: `StorageProvider` interface (`packages/storage`) with S3 implementation. Works with SeaweedFS (local dev), AWS S3, Cloudflare R2, Supabase Storage (S3-compatible), or any S3-compatible service. Just swap the endpoint and credentials.
- **Container Sessions**: `ContainerManager` wraps dockerode for agent execution. This is the one area most likely to differ between self-hosted and hosted.
- **Auth**: API keys (`ank_` prefix). Simple, stateless, works everywhere.

## The Separation Pattern

```
maskin/                          <- open source (public GitHub repo)
  apps/dev/                      Backend (Hono + Drizzle + PostgreSQL)
  apps/web/                      Frontend (Vite + React + TanStack)
  packages/                      Shared libraries (db, auth, mcp, storage, realtime)
  modules/                       Toggleable feature modules (work, notetaker, etc.)
  docker-compose.yml             Local dev: Postgres + SeaweedFS
  .env.example                   Template with all env vars

maskin-cloud/                    <- private repo (not open source)
  coolify/                       Coolify deployment configs
  supabase/                      Supabase migrations, RLS policies, edge functions
  docker/                        Production Dockerfiles
  scripts/                       Deploy scripts, CI/CD
  .env.production                Supabase URL, S3 creds, etc.
```

## How It Works

The open source repo has zero knowledge of Supabase or Coolify. Switching between self-hosted and our hosted offering is just environment variables:

```bash
# Self-hosted (open source user)
DATABASE_URL=postgresql://localhost:5432/maskin
S3_ENDPOINT=http://localhost:8333
S3_BUCKET=agent-files

# Hosted (our commercial offering)
DATABASE_URL=postgresql://db.xxxx.supabase.co:5432/postgres
S3_ENDPOINT=https://xxxx.supabase.co/storage/v1/s3
S3_BUCKET=agent-files
S3_ACCESS_KEY=<supabase-service-key>
```

The private repo references the open source codebase and adds deployment configuration on top. Open source users self-host with plain Postgres and whatever S3-compatible storage they want. Our hosted version uses Supabase + Coolify without any changes to the core code.

## What Doesn't Need to Change

- **Database layer**: Drizzle generates standard SQL. Supabase is just managed Postgres. Migrations, queries, and the module system all work identically.
- **Storage**: Any S3-compatible service works with the existing `S3StorageProvider`. No code changes needed.
- **Module system**: Completely independent of deployment. Modules use the same abstract interfaces whether running locally or on Supabase.
- **MCP server**: Wraps the HTTP API. Works the same regardless of hosting.
- **Frontend**: Static build served by the backend. Deploy anywhere.

## What Might Differ for the Hosted Version

1. **Auth enhancement**: The hosted version may add OAuth/SSO (Supabase Auth, social logins) on top of the existing API key auth. This would be additional middleware in the private repo, not a replacement.

2. **Agent execution**: The Docker-based `ContainerManager` works for self-hosted. The hosted version on Coolify may need a different execution model — managed containers, a worker service, or a serverless approach. Could be handled via an `ExecutionProvider` interface.

3. **Row Level Security**: Supabase supports Postgres RLS policies. The hosted version could add RLS as an extra security layer. The open source version relies on application-level workspace isolation (which already works).

4. **Billing & usage tracking**: Hosted-only middleware that counts API calls, storage usage, and active modules per workspace.

5. **Module marketplace UI**: A nicer interface for enabling/disabling modules (vs env vars or API calls in the open source version).

## Key Principle

All modules and features must use abstract interfaces (`StorageProvider`, Drizzle db, `DATABASE_URL`), never provider-specific APIs. This ensures the open source version stays clean and the hosted version is purely a deployment/configuration layer on top.
