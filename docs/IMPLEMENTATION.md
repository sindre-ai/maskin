# AI-Native OSS Workspace — Implementation Reference

## Table of Contents

- [Project Structure](#project-structure)
- [Configuration Files](#configuration-files)
  - [package.json](#packagejson)
  - [pnpm-workspace.yaml](#pnpm-workspaceyaml)
  - [turbo.json](#turbojson)
  - [biome.json](#biomejson)
  - [tsconfig.json](#tsconfigjson)
  - [.gitignore](#gitignore)
  - [.env.example](#envexample)
  - [docker-compose.yml](#docker-composeyml)
- [packages/db — Database Layer](#packagesdb--database-layer)
  - [packages/db/package.json](#packagesdbpackagejson)
  - [packages/db/drizzle.config.ts](#packagesdbdrizzleconfigts)
  - [packages/db/src/schema.ts](#packagesdbsrcschemats)
  - [packages/db/src/connection.ts](#packagesdbsrcconnectionts)
  - [packages/db/src/migrate.ts](#packagesdbsrcmigratets)
  - [packages/db/src/seed.ts](#packagesdbsrcseedts)
  - [packages/db/src/index.ts](#packagesdbsrcindexts)
  - [packages/db/drizzle/0000_setup.sql](#packagesdbdrizzle0000_setupsql)
  - [packages/db/tsconfig.json](#packagesdbtsconfigjson)
- [packages/shared — Zod Schemas](#packagesshared--zod-schemas)
  - [packages/shared/package.json](#packagessharedpackagejson)
  - [packages/shared/src/schemas/objects.ts](#packagessharedsrcschemasobjectsts)
  - [packages/shared/src/schemas/actors.ts](#packagessharedsrcschemasactorsts)
  - [packages/shared/src/schemas/workspaces.ts](#packagessharedsrcschemasworkspacests)
  - [packages/shared/src/schemas/relationships.ts](#packagessharedsrcschemasrelationshipsts)
  - [packages/shared/src/schemas/events.ts](#packagessharedsrcschemaseventsts)
  - [packages/shared/src/schemas/triggers.ts](#packagessharedsrcschemastriggersts)
  - [packages/shared/src/schemas/index.ts](#packagessharedsrcschemasindexts)
  - [packages/shared/src/index.ts](#packagessharedsrcindexts)
  - [packages/shared/tsconfig.json](#packagessharedtsconfigjson)
- [packages/auth — Authentication](#packagesauth--authentication)
  - [packages/auth/package.json](#packagesauthpackagejson)
  - [packages/auth/src/auth.ts](#packagesauthsrcauthts)
  - [packages/auth/src/api-keys.ts](#packagesauthsrcapi-keysts)
  - [packages/auth/src/middleware.ts](#packagesauthsrcmiddlewarets)
  - [packages/auth/src/index.ts](#packagesauthsrcindexts)
  - [packages/auth/tsconfig.json](#packagesauthtsconfigjson)
- [packages/realtime — PG NOTIFY + SSE](#packagesrealtime--pg-notify--sse)
  - [packages/realtime/package.json](#packagesrealtimepackagejson)
  - [packages/realtime/src/notify.ts](#packagesrealtimesrcnotifyts)
  - [packages/realtime/src/sse.ts](#packagesrealtimesrcssest)
  - [packages/realtime/src/index.ts](#packagesrealtimesrcindexts)
  - [packages/realtime/tsconfig.json](#packagesrealtimetsconfigjson)
- [packages/mcp — MCP Server](#packagesmcp--mcp-server)
  - [packages/mcp/package.json](#packagesmcppackagejson)
  - [packages/mcp/src/server.ts](#packagesmcpsrcserverts)
  - [packages/mcp/src/tools.ts](#packagesmcpsrctoolsts)
  - [packages/mcp/src/index.ts](#packagesmcpsrcindexts)
  - [packages/mcp/tsconfig.json](#packagesmcptsconfigjson)
- [apps/dev — Dev Workspace API](#appsdev--dev-workspace-api)
  - [apps/dev/package.json](#appsdevpackagejson)
  - [apps/dev/src/index.ts](#appsdevsrcindexts)
  - [apps/dev/src/routes/objects.ts](#appsdevsrcroutesobjectsts)
  - [apps/dev/src/routes/actors.ts](#appsdevsrroutesactorsts)
  - [apps/dev/src/routes/workspaces.ts](#appsdevsrcroutesworkspacests)
  - [apps/dev/src/routes/relationships.ts](#appsdevsrcroutesrelationshipsts)
  - [apps/dev/src/routes/triggers.ts](#appsdevsrcroutestriggersts)
  - [apps/dev/src/routes/events.ts](#appsdevsrcrouteseventsts)
  - [apps/dev/src/services/agent-runner.ts](#appsdevsrcservicesagent-runnerts)
  - [apps/dev/src/services/trigger-runner.ts](#appsdevsrcservicestrigger-runnerts)
  - [apps/dev/src/lib/llm/adapter.ts](#appsdevsrclibllmadapterts)
  - [apps/dev/src/lib/llm/openai.ts](#appsdevsrclibllmopenaits)
  - [apps/dev/src/lib/llm/anthropic.ts](#appsdevsrclibllmanthropicts)
  - [apps/dev/src/lib/llm/index.ts](#appsdevsrclibllmindexts)
  - [apps/dev/Dockerfile](#appsdevdockerfile)
  - [apps/dev/vitest.config.ts](#appsdevvitestconfigts)
  - [apps/dev/tsconfig.json](#appsdevtsconfigjson)

---

## Project Structure

```
ai-native-oss/
├── .env.example
├── .gitignore
├── biome.json
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── turbo.json
├── apps/
│   └── dev/
│       ├── Dockerfile
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── src/
│           ├── index.ts
│           ├── lib/
│           │   └── llm/
│           │       ├── adapter.ts
│           │       ├── anthropic.ts
│           │       ├── index.ts
│           │       └── openai.ts
│           ├── routes/
│           │   ├── actors.ts
│           │   ├── events.ts
│           │   ├── objects.ts
│           │   ├── relationships.ts
│           │   ├── triggers.ts
│           │   └── workspaces.ts
│           └── services/
│               ├── agent-runner.ts
│               └── trigger-runner.ts
└── packages/
    ├── auth/
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── api-keys.ts
    │       ├── auth.ts
    │       ├── index.ts
    │       └── middleware.ts
    ├── db/
    │   ├── drizzle.config.ts
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── drizzle/
    │   │   └── 0000_setup.sql
    │   └── src/
    │       ├── connection.ts
    │       ├── index.ts
    │       ├── migrate.ts
    │       ├── schema.ts
    │       └── seed.ts
    ├── mcp/
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts
    │       ├── server.ts
    │       └── tools.ts
    ├── realtime/
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts
    │       ├── notify.ts
    │       └── sse.ts
    └── shared/
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.ts
            └── schemas/
                ├── actors.ts
                ├── events.ts
                ├── index.ts
                ├── objects.ts
                ├── relationships.ts
                ├── triggers.ts
                └── workspaces.ts
```

---

## Configuration Files

### `package.json`

```json
{
	"name": "ai-native-oss",
	"private": true,
	"scripts": {
		"dev": "turbo dev",
		"build": "turbo build",
		"test": "turbo test",
		"lint": "biome check .",
		"lint:fix": "biome check --write .",
		"format": "biome format --write .",
		"db:generate": "turbo db:generate",
		"db:migrate": "turbo db:migrate",
		"db:seed": "turbo db:seed"
	},
	"devDependencies": {
		"@biomejs/biome": "^1.9.0",
		"@types/node": "^25.5.0",
		"turbo": "^2.3.0",
		"typescript": "^5.7.0"
	},
	"packageManager": "pnpm@9.15.0",
	"engines": {
		"node": ">=20"
	}
}
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### `turbo.json`

```json
{
	"$schema": "https://turbo.build/schema.json",
	"tasks": {
		"build": {
			"dependsOn": ["^build"],
			"outputs": ["dist/**"]
		},
		"dev": {
			"cache": false,
			"persistent": true
		},
		"test": {
			"dependsOn": ["^build"]
		},
		"lint": {},
		"db:generate": {
			"cache": false
		},
		"db:migrate": {
			"cache": false
		},
		"db:seed": {
			"cache": false
		}
	}
}
```

### `biome.json`

```json
{
	"$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
	"organizeImports": {
		"enabled": true
	},
	"linter": {
		"enabled": true,
		"rules": {
			"recommended": true
		}
	},
	"formatter": {
		"enabled": true,
		"indentStyle": "tab",
		"lineWidth": 100
	},
	"javascript": {
		"formatter": {
			"quoteStyle": "single",
			"semicolons": "asNeeded"
		}
	},
	"files": {
		"ignore": ["node_modules", "dist", "drizzle", ".turbo"]
	}
}
```

### `tsconfig.json`

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"esModuleInterop": true,
		"strict": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"resolveJsonModule": true,
		"declaration": true,
		"declarationMap": true,
		"sourceMap": true,
		"outDir": "dist",
		"rootDir": "src"
	},
	"exclude": ["node_modules", "dist"]
}
```

### `.gitignore`

```
node_modules/
dist/
.turbo/
*.env
.env.*
!.env.example
.DS_Store
```

### `.env.example`

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_native_oss
BETTER_AUTH_SECRET=change-me-in-production
BETTER_AUTH_URL=http://localhost:3000
```

### `docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ai_native_oss
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  dev:
    build:
      context: .
      dockerfile: apps/dev/Dockerfile
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/ai_native_oss
      BETTER_AUTH_SECRET: dev-secret-change-in-production
      BETTER_AUTH_URL: http://localhost:3000
      PORT: "3000"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  pgdata:
```

---

## packages/db — Database Layer

### `packages/db/package.json`

```json
{
	"name": "@ai-native/db",
	"version": "0.0.1",
	"private": true,
	"type": "module",
	"exports": {
		".": "./src/index.ts",
		"./schema": "./src/schema.ts",
		"./connection": "./src/connection.ts"
	},
	"scripts": {
		"db:generate": "drizzle-kit generate",
		"db:migrate": "tsx src/migrate.ts",
		"db:seed": "tsx src/seed.ts",
		"build": "tsc"
	},
	"dependencies": {
		"drizzle-orm": "^0.38.0",
		"postgres": "^3.4.0"
	},
	"devDependencies": {
		"drizzle-kit": "^0.30.0",
		"tsx": "^4.19.0",
		"typescript": "^5.7.0"
	}
}
```

### `packages/db/drizzle.config.ts`

```typescript
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
	schema: './src/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		url: process.env.DATABASE_URL!,
	},
})
```

### `packages/db/src/schema.ts`

```typescript
import {
	bigserial,
	boolean,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from 'drizzle-orm/pg-core'

// ── Actors ──────────────────────────────────────────────────────────────────

export const actors = pgTable('actors', {
	id: uuid('id').defaultRandom().primaryKey(),
	type: text('type').notNull(),
	name: text('name').notNull(),
	email: text('email').unique(),
	apiKeyHash: text('api_key_hash'),
	systemPrompt: text('system_prompt'),
	tools: jsonb('tools'),
	memory: jsonb('memory'),
	llmProvider: text('llm_provider'),
	llmConfig: jsonb('llm_config'),
	createdBy: uuid('created_by').references((): any => actors.id),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// ── Workspaces ──────────────────────────────────────────────────────────────

export const workspaces = pgTable('workspaces', {
	id: uuid('id').defaultRandom().primaryKey(),
	name: text('name').notNull(),
	settings: jsonb('settings').notNull().default({}),
	createdBy: uuid('created_by').references(() => actors.id),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// ── Workspace Members ───────────────────────────────────────────────────────

export const workspaceMembers = pgTable(
	'workspace_members',
	{
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		role: text('role').notNull(),
		joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.workspaceId, t.actorId] })],
)

// ── Objects ─────────────────────────────────────────────────────────────────

export const objects = pgTable(
	'objects',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		type: text('type').notNull(),
		title: text('title'),
		content: text('content'),
		status: text('status').notNull(),
		metadata: jsonb('metadata'),
		owner: uuid('owner').references(() => actors.id),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [index('objects_ws_type_status_idx').on(t.workspaceId, t.type, t.status)],
)

// ── Relationships ───────────────────────────────────────────────────────────

export const relationships = pgTable(
	'relationships',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		sourceType: text('source_type').notNull(),
		sourceId: uuid('source_id').notNull(),
		targetType: text('target_type').notNull(),
		targetId: uuid('target_id').notNull(),
		type: text('type').notNull(),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [unique('relationships_src_tgt_type_uniq').on(t.sourceId, t.targetId, t.type)],
)

// ── Events ──────────────────────────────────────────────────────────────────

export const events = pgTable(
	'events',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		action: text('action').notNull(),
		entityType: text('entity_type').notNull(),
		entityId: uuid('entity_id').notNull(),
		data: jsonb('data'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [index('events_ws_created_at_idx').on(t.workspaceId, t.createdAt)],
)

// ── Triggers ────────────────────────────────────────────────────────────────

export const triggers = pgTable('triggers', {
	id: uuid('id').defaultRandom().primaryKey(),
	workspaceId: uuid('workspace_id')
		.references(() => workspaces.id)
		.notNull(),
	name: text('name').notNull(),
	type: text('type').notNull(),
	config: jsonb('config').notNull(),
	actionPrompt: text('action_prompt').notNull(),
	targetActorId: uuid('target_actor_id')
		.references(() => actors.id)
		.notNull(),
	enabled: boolean('enabled').notNull().default(true),
	createdBy: uuid('created_by')
		.references(() => actors.id)
		.notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})
```

### `packages/db/src/connection.ts`

```typescript
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export function createDb(url: string) {
	const client = postgres(url)
	return drizzle(client, { schema })
}

export type Database = ReturnType<typeof createDb>
```

### `packages/db/src/migrate.ts`

```typescript
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '..', 'drizzle')

const sql = postgres(process.env.DATABASE_URL!)

const files = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()

for (const file of files) {
	const content = readFileSync(join(migrationsDir, file), 'utf-8')
	console.log(`Running migration: ${file}`)
	await sql.unsafe(content)
}

console.log('Migrations complete')
await sql.end()
process.exit(0)
```

### `packages/db/src/seed.ts`

```typescript
import { createDb } from './connection'
import { actors, objects, relationships, workspaceMembers, workspaces } from './schema'

const db = createDb(process.env.DATABASE_URL!)

// ── Actor ───────────────────────────────────────────────────────────────────

const [demoUser] = await db
	.insert(actors)
	.values({
		type: 'human',
		name: 'Demo User',
		email: 'demo@example.com',
	})
	.returning()

// ── Workspace ───────────────────────────────────────────────────────────────

const [demoWorkspace] = await db
	.insert(workspaces)
	.values({
		name: 'Demo Workspace',
		createdBy: demoUser.id,
	})
	.returning()

// ── Membership ──────────────────────────────────────────────────────────────

await db.insert(workspaceMembers).values({
	workspaceId: demoWorkspace.id,
	actorId: demoUser.id,
	role: 'owner',
})

// ── Insights ────────────────────────────────────────────────────────────────

const [insight1, insight2, insight3] = await db
	.insert(objects)
	.values([
		{
			workspaceId: demoWorkspace.id,
			type: 'insight',
			title: 'Users abandon onboarding at step 3',
			content: 'Analytics show a 60% drop-off at the team-invite step.',
			status: 'open',
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'insight',
			title: 'Most active users rely on keyboard shortcuts',
			content: 'Power users complete tasks 3x faster with shortcuts.',
			status: 'open',
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'insight',
			title: 'API latency spikes during peak hours',
			content: 'P99 latency exceeds 2s between 9-11 AM UTC.',
			status: 'archived',
			createdBy: demoUser.id,
		},
	])
	.returning()

// ── Bets ────────────────────────────────────────────────────────────────────

const [bet1, bet2] = await db
	.insert(objects)
	.values([
		{
			workspaceId: demoWorkspace.id,
			type: 'bet',
			title: 'Simplify onboarding to 2 steps',
			content: 'Merge team-invite into post-signup flow to reduce drop-off.',
			status: 'active',
			owner: demoUser.id,
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'bet',
			title: 'Add command palette',
			content: 'Expose all actions via Cmd+K palette for power users.',
			status: 'proposed',
			owner: demoUser.id,
			createdBy: demoUser.id,
		},
	])
	.returning()

// ── Tasks ───────────────────────────────────────────────────────────────────

const [task1, task2, task3] = await db
	.insert(objects)
	.values([
		{
			workspaceId: demoWorkspace.id,
			type: 'task',
			title: 'Remove team-invite step from onboarding',
			status: 'in_progress',
			owner: demoUser.id,
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'task',
			title: 'Design command palette UI',
			status: 'todo',
			owner: demoUser.id,
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'task',
			title: 'Investigate API caching strategy',
			status: 'todo',
			createdBy: demoUser.id,
		},
	])
	.returning()

// ── Relationships ───────────────────────────────────────────────────────────

await db.insert(relationships).values([
	{
		sourceType: 'insight',
		sourceId: insight1.id,
		targetType: 'bet',
		targetId: bet1.id,
		type: 'informs',
		createdBy: demoUser.id,
	},
	{
		sourceType: 'insight',
		sourceId: insight2.id,
		targetType: 'bet',
		targetId: bet2.id,
		type: 'informs',
		createdBy: demoUser.id,
	},
	{
		sourceType: 'bet',
		sourceId: bet1.id,
		targetType: 'task',
		targetId: task1.id,
		type: 'breaks_into',
		createdBy: demoUser.id,
	},
	{
		sourceType: 'bet',
		sourceId: bet2.id,
		targetType: 'task',
		targetId: task2.id,
		type: 'breaks_into',
		createdBy: demoUser.id,
	},
	{
		sourceType: 'insight',
		sourceId: insight3.id,
		targetType: 'task',
		targetId: task3.id,
		type: 'informs',
		createdBy: demoUser.id,
	},
])

console.log('Seed complete')
process.exit(0)
```

### `packages/db/src/index.ts`

```typescript
export * from './schema'
export * from './connection'
```

### `packages/db/drizzle/0000_setup.sql`

```sql
-- Create all tables

CREATE TABLE IF NOT EXISTS "actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"type" text NOT NULL,
	"name" text NOT NULL,
	"email" text UNIQUE,
	"api_key_hash" text,
	"system_prompt" text,
	"tools" jsonb,
	"memory" jsonb,
	"llm_provider" text,
	"llm_config" jsonb,
	"created_by" uuid REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"settings" jsonb NOT NULL DEFAULT '{}',
	"created_by" uuid REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "workspace_members" (
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now(),
	PRIMARY KEY ("workspace_id", "actor_id")
);

CREATE TABLE IF NOT EXISTS "objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"type" text NOT NULL,
	"title" text,
	"content" text,
	"status" text NOT NULL,
	"metadata" jsonb,
	"owner" uuid REFERENCES "actors"("id"),
	"created_by" uuid NOT NULL REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "objects_ws_type_status_idx" ON "objects" ("workspace_id", "type", "status");

CREATE TABLE IF NOT EXISTS "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	UNIQUE ("source_id", "target_id", "type")
);

CREATE TABLE IF NOT EXISTS "events" (
	"id" bigserial PRIMARY KEY,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "events_ws_created_at_idx" ON "events" ("workspace_id", "created_at");

CREATE TABLE IF NOT EXISTS "triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"action_prompt" text NOT NULL,
	"target_actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"enabled" boolean NOT NULL DEFAULT true,
	"created_by" uuid NOT NULL REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

-- PG NOTIFY trigger: fires on every event insert, broadcasts to SSE
CREATE OR REPLACE FUNCTION notify_event() RETURNS trigger AS $$
BEGIN
	PERFORM pg_notify('events', json_build_object(
		'event_id', NEW.id::text,
		'workspace_id', NEW.workspace_id::text,
		'actor_id', NEW.actor_id::text,
		'action', NEW.action,
		'entity_type', NEW.entity_type,
		'entity_id', NEW.entity_id::text,
		'data', NEW.data
	)::text);
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER events_notify
	AFTER INSERT ON "events"
	FOR EACH ROW
	EXECUTE FUNCTION notify_event();
```

### `packages/db/tsconfig.json`

```json
{
	"extends": "../../tsconfig.json",
	"compilerOptions": {
		"outDir": "dist",
		"rootDir": "src"
	},
	"include": ["src"]
}
```

---

## packages/shared — Zod Schemas

### `packages/shared/package.json`

```json
{
	"name": "@ai-native/shared",
	"version": "0.0.1",
	"private": true,
	"type": "module",
	"exports": {
		".": "./src/index.ts",
		"./schemas": "./src/schemas/index.ts"
	},
	"scripts": {
		"build": "tsc"
	},
	"dependencies": {
		"zod": "^3.24.0"
	},
	"devDependencies": {
		"typescript": "^5.7.0"
	}
}
```

### `packages/shared/src/schemas/objects.ts`

```typescript
import { z } from 'zod'

export const objectTypeSchema = z.enum(['insight', 'bet', 'task'])
export type ObjectType = z.infer<typeof objectTypeSchema>

export const createObjectSchema = z.object({
	type: objectTypeSchema,
	title: z.string().optional(),
	content: z.string().optional(),
	status: z.string(),
	metadata: z.record(z.unknown()).optional(),
	owner: z.string().uuid().optional(),
})

export const updateObjectSchema = z.object({
	title: z.string().optional(),
	content: z.string().optional(),
	status: z.string().optional(),
	metadata: z.record(z.unknown()).optional(),
	owner: z.string().uuid().nullable().optional(),
})

export const objectQuerySchema = z.object({
	type: objectTypeSchema.optional(),
	status: z.string().optional(),
	owner: z.string().uuid().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})

export const objectParamsSchema = z.object({
	id: z.string().uuid(),
})
```

### `packages/shared/src/schemas/actors.ts`

```typescript
import { z } from 'zod'

export const actorTypeSchema = z.enum(['human', 'agent'])

export const createActorSchema = z.object({
	type: actorTypeSchema,
	name: z.string().min(1),
	email: z.string().email().optional(),
	system_prompt: z.string().optional(),
	tools: z.record(z.unknown()).optional(),
	llm_provider: z.string().optional(),
	llm_config: z.record(z.unknown()).optional(),
})

export const updateActorSchema = z.object({
	name: z.string().min(1).optional(),
	email: z.string().email().optional(),
	system_prompt: z.string().optional(),
	tools: z.record(z.unknown()).optional(),
	memory: z.record(z.unknown()).optional(),
	llm_provider: z.string().optional(),
	llm_config: z.record(z.unknown()).optional(),
})

export const actorParamsSchema = z.object({
	id: z.string().uuid(),
})
```

### `packages/shared/src/schemas/workspaces.ts`

```typescript
import { z } from 'zod'

const fieldDefinitionSchema = z.object({
	name: z.string(),
	type: z.enum(['text', 'number', 'date', 'enum', 'boolean']),
	required: z.boolean().default(false),
	values: z.array(z.string()).optional(),
})

export const workspaceSettingsSchema = z.object({
	display_names: z.record(z.string()).default({
		insight: 'Insight',
		bet: 'Bet',
		task: 'Task',
	}),
	statuses: z.record(z.array(z.string())).default({
		insight: ['new', 'processing', 'clustered', 'discarded'],
		bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
		task: ['todo', 'in_progress', 'done', 'blocked'],
	}),
	field_definitions: z.record(z.array(fieldDefinitionSchema)).default({}),
	relationship_types: z
		.array(z.string())
		.default(['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates']),
})

export const createWorkspaceSchema = z.object({
	name: z.string().min(1),
	settings: workspaceSettingsSchema.optional(),
})

export const updateWorkspaceSchema = z.object({
	name: z.string().min(1).optional(),
	settings: workspaceSettingsSchema.partial().optional(),
})

export const workspaceParamsSchema = z.object({
	id: z.string().uuid(),
})
```

### `packages/shared/src/schemas/relationships.ts`

```typescript
import { z } from 'zod'

export const createRelationshipSchema = z.object({
	source_type: z.string(),
	source_id: z.string().uuid(),
	target_type: z.string(),
	target_id: z.string().uuid(),
	type: z.string(),
})

export const relationshipQuerySchema = z.object({
	source_id: z.string().uuid().optional(),
	target_id: z.string().uuid().optional(),
	type: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})

export const relationshipParamsSchema = z.object({
	id: z.string().uuid(),
})
```

### `packages/shared/src/schemas/events.ts`

```typescript
import { z } from 'zod'

export const eventQuerySchema = z.object({
	entity_type: z.string().optional(),
	entity_id: z.string().uuid().optional(),
	action: z.string().optional(),
	since: z.coerce.number().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})
```

### `packages/shared/src/schemas/triggers.ts`

```typescript
import { z } from 'zod'

export const triggerTypeSchema = z.enum(['cron', 'event'])

export const cronConfigSchema = z.object({
	expression: z.string(),
})

export const eventConfigSchema = z.object({
	entity_type: z.string(),
	action: z.string(),
	filter: z.record(z.unknown()).optional(),
})

export const triggerConfigSchema = z.union([cronConfigSchema, eventConfigSchema])

export const createTriggerSchema = z.object({
	name: z.string().min(1),
	type: triggerTypeSchema,
	config: triggerConfigSchema,
	action_prompt: z.string().min(1),
	target_actor_id: z.string().uuid(),
	enabled: z.boolean().default(true),
})

export const updateTriggerSchema = z.object({
	name: z.string().min(1).optional(),
	config: triggerConfigSchema.optional(),
	action_prompt: z.string().min(1).optional(),
	target_actor_id: z.string().uuid().optional(),
	enabled: z.boolean().optional(),
})

export const triggerParamsSchema = z.object({
	id: z.string().uuid(),
})
```

### `packages/shared/src/schemas/index.ts`

```typescript
export * from './objects'
export * from './actors'
export * from './workspaces'
export * from './relationships'
export * from './events'
export * from './triggers'
```

### `packages/shared/src/index.ts`

```typescript
export * from './schemas/index'
```

### `packages/shared/tsconfig.json`

```json
{
	"extends": "../../tsconfig.json",
	"compilerOptions": {
		"outDir": "dist",
		"rootDir": "src"
	},
	"include": ["src"]
}
```

---

## packages/auth — Authentication

### `packages/auth/package.json`

```json
{
	"name": "@ai-native/auth",
	"version": "0.0.1",
	"private": true,
	"type": "module",
	"exports": {
		".": "./src/index.ts",
		"./middleware": "./src/middleware.ts"
	},
	"scripts": {
		"build": "tsc"
	},
	"dependencies": {
		"@ai-native/db": "workspace:*",
		"better-auth": "^1.2.0",
		"drizzle-orm": "^0.38.0",
		"hono": "^4.7.0"
	},
	"devDependencies": {
		"typescript": "^5.7.0"
	}
}
```

### `packages/auth/src/auth.ts`

```typescript
import { betterAuth } from 'better-auth'

export function createAuth(options: {
	secret: string
	baseURL: string
	database: {
		url: string
	}
}) {
	return betterAuth({
		secret: options.secret,
		baseURL: options.baseURL,
		database: {
			type: 'postgres',
			url: options.database.url,
		},
		emailAndPassword: {
			enabled: true,
		},
	})
}

export type Auth = ReturnType<typeof createAuth>
```

### `packages/auth/src/api-keys.ts`

```typescript
import type { Database } from '@ai-native/db'
import { actors } from '@ai-native/db/schema'
import { eq, isNotNull } from 'drizzle-orm'

async function sha256(input: string): Promise<string> {
	const encoder = new TextEncoder()
	const data = encoder.encode(input)
	const hash = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

export async function generateApiKey(): Promise<{ key: string; hash: string }> {
	const key = `ank_${crypto.randomUUID().replace(/-/g, '')}`
	const hash = await sha256(key)
	return { key, hash }
}

export async function validateApiKey(
	db: Database,
	apiKey: string,
): Promise<{ actorId: string; type: string } | null> {
	const hash = await sha256(apiKey)
	const [actor] = await db
		.select({ id: actors.id, type: actors.type })
		.from(actors)
		.where(eq(actors.apiKeyHash, hash))
		.limit(1)

	return actor ? { actorId: actor.id, type: actor.type } : null
}
```

### `packages/auth/src/middleware.ts`

```typescript
import type { Database } from '@ai-native/db'
import { createMiddleware } from 'hono/factory'
import { validateApiKey } from './api-keys'

export function authMiddleware(db: Database) {
	return createMiddleware(async (c, next) => {
		const authHeader = c.req.header('Authorization')
		if (!authHeader?.startsWith('Bearer ')) {
			return c.json({ error: 'Missing or invalid Authorization header' }, 401)
		}

		const token = authHeader.slice(7)

		// API key auth
		if (token.startsWith('ank_')) {
			const result = await validateApiKey(db, token)
			if (!result) {
				return c.json({ error: 'Invalid API key' }, 401)
			}
			c.set('actorId', result.actorId)
			c.set('actorType', result.type)
			return next()
		}

		// Future: Better Auth session validation
		return c.json({ error: 'Invalid token format' }, 401)
	})
}
```

### `packages/auth/src/index.ts`

```typescript
export { createAuth, type Auth } from './auth'
export { generateApiKey, validateApiKey } from './api-keys'
export { authMiddleware } from './middleware'
```

### `packages/auth/tsconfig.json`

```json
{
	"extends": "../../tsconfig.json",
	"compilerOptions": {
		"outDir": "dist",
		"rootDir": "src"
	},
	"include": ["src"]
}
```

---

## packages/realtime — PG NOTIFY + SSE

### `packages/realtime/package.json`

```json
{
	"name": "@ai-native/realtime",
	"version": "0.0.1",
	"private": true,
	"type": "module",
	"exports": {
		".": "./src/index.ts",
		"./notify": "./src/notify.ts",
		"./sse": "./src/sse.ts"
	},
	"scripts": {
		"build": "tsc"
	},
	"dependencies": {
		"postgres": "^3.4.0",
		"hono": "^4.7.0"
	},
	"devDependencies": {
		"typescript": "^5.7.0"
	}
}
```

### `packages/realtime/src/notify.ts`

```typescript
import { EventEmitter } from 'node:events'
import postgres from 'postgres'

export interface PgEvent {
	workspace_id: string
	actor_id: string
	action: string
	entity_type: string
	entity_id: string
	event_id: string
	data: Record<string, unknown> | null
}

export class PgNotifyBridge extends EventEmitter {
	private sql: postgres.Sql

	constructor(databaseUrl: string) {
		super()
		this.sql = postgres(databaseUrl, {
			max: 1,
		})
	}

	async start() {
		await this.sql.listen('events', (payload) => {
			try {
				const event = JSON.parse(payload) as PgEvent
				this.emit('event', event)
			} catch {
				// ignore malformed payloads
			}
		})
	}

	async stop() {
		await this.sql.end()
	}
}
```

### `packages/realtime/src/sse.ts`

```typescript
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { PgEvent, PgNotifyBridge } from './notify'

export function createSSEHandler(bridge: PgNotifyBridge) {
	return (c: Context) => {
		const workspaceId = c.req.query('workspace_id')

		return streamSSE(c, async (stream) => {
			const handler = (event: PgEvent) => {
				if (workspaceId && event.workspace_id !== workspaceId) return

				stream.writeSSE({
					id: event.event_id,
					event: event.action,
					data: JSON.stringify(event),
				})
			}

			bridge.on('event', handler)

			stream.onAbort(() => {
				bridge.off('event', handler)
			})

			// Keep connection alive
			while (true) {
				await stream.sleep(30000)
			}
		})
	}
}
```

### `packages/realtime/src/index.ts`

```typescript
export { PgNotifyBridge, type PgEvent } from './notify'
export { createSSEHandler } from './sse'
```

### `packages/realtime/tsconfig.json`

```json
{
	"extends": "../../tsconfig.json",
	"compilerOptions": {
		"outDir": "dist",
		"rootDir": "src"
	},
	"include": ["src"]
}
```

---

## packages/mcp — MCP Server

### `packages/mcp/package.json`

```json
{
	"name": "@ai-native/mcp",
	"version": "0.0.1",
	"private": true,
	"type": "module",
	"exports": {
		".": "./src/index.ts"
	},
	"scripts": {
		"build": "tsc"
	},
	"dependencies": {
		"@modelcontextprotocol/sdk": "^1.6.0",
		"zod": "^3.24.0"
	},
	"devDependencies": {
		"typescript": "^5.7.0"
	}
}
```

### `packages/mcp/src/server.ts`

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { tools } from './tools.js'

interface McpConfig {
	apiBaseUrl: string
	apiKey: string
	workspaceId: string
}

async function apiCall(
	config: McpConfig,
	method: string,
	path: string,
	body?: unknown,
): Promise<unknown> {
	const url = `${config.apiBaseUrl}${path}`
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${config.apiKey}`,
		'X-Workspace-Id': config.workspaceId,
	}

	const response = await fetch(url, {
		method,
		headers,
		...(body ? { body: JSON.stringify(body) } : {}),
	})

	if (!response.ok) {
		const error = await response.text()
		throw new Error(`API error ${response.status}: ${error}`)
	}

	return response.json()
}

export function createMcpServer(config: McpConfig) {
	const server = new McpServer({
		name: 'ai-native-oss',
		version: '0.1.0',
	})

	// Objects
	server.tool(
		'create_object',
		tools.create_object.description,
		tools.create_object.inputSchema.shape,
		async (args) => {
			const result = await apiCall(config, 'POST', '/api/objects', args)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	server.tool(
		'update_object',
		tools.update_object.description,
		tools.update_object.inputSchema.shape,
		async (args) => {
			const { id, ...body } = args
			const result = await apiCall(config, 'PATCH', `/api/objects/${id}`, body)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	server.tool(
		'get_object',
		tools.get_object.description,
		tools.get_object.inputSchema.shape,
		async (args) => {
			const result = await apiCall(config, 'GET', `/api/objects/${args.id}`)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	server.tool(
		'list_objects',
		tools.list_objects.description,
		tools.list_objects.inputSchema.shape,
		async (args) => {
			const params = new URLSearchParams()
			if (args.type) params.set('type', args.type)
			if (args.status) params.set('status', args.status)
			if (args.limit) params.set('limit', String(args.limit))
			if (args.offset) params.set('offset', String(args.offset))
			const result = await apiCall(config, 'GET', `/api/objects?${params}`)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	server.tool(
		'delete_object',
		tools.delete_object.description,
		tools.delete_object.inputSchema.shape,
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/objects/${args.id}`)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// Relationships
	server.tool(
		'create_relationship',
		tools.create_relationship.description,
		tools.create_relationship.inputSchema.shape,
		async (args) => {
			const result = await apiCall(config, 'POST', '/api/relationships', args)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	server.tool(
		'list_relationships',
		tools.list_relationships.description,
		tools.list_relationships.inputSchema.shape,
		async (args) => {
			const params = new URLSearchParams()
			if (args.source_id) params.set('source_id', args.source_id)
			if (args.target_id) params.set('target_id', args.target_id)
			if (args.type) params.set('type', args.type)
			const result = await apiCall(config, 'GET', `/api/relationships?${params}`)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	server.tool(
		'delete_relationship',
		tools.delete_relationship.description,
		tools.delete_relationship.inputSchema.shape,
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/relationships/${args.id}`)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// Actors
	server.tool(
		'list_actors',
		tools.list_actors.description,
		tools.list_actors.inputSchema.shape,
		async () => {
			const result = await apiCall(config, 'GET', '/api/actors')
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	server.tool(
		'get_actor',
		tools.get_actor.description,
		tools.get_actor.inputSchema.shape,
		async (args) => {
			const result = await apiCall(config, 'GET', `/api/actors/${args.id}`)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// Workspaces
	server.tool(
		'list_workspaces',
		tools.list_workspaces.description,
		tools.list_workspaces.inputSchema.shape,
		async () => {
			const result = await apiCall(config, 'GET', '/api/workspaces')
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// Events
	server.tool(
		'get_events',
		tools.get_events.description,
		tools.get_events.inputSchema.shape,
		async (args) => {
			const params = new URLSearchParams()
			if (args.entity_type) params.set('entity_type', args.entity_type)
			if (args.action) params.set('action', args.action)
			if (args.limit) params.set('limit', String(args.limit))
			const result = await apiCall(config, 'GET', `/api/events/history?${params}`)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// Triggers
	server.tool(
		'create_trigger',
		tools.create_trigger.description,
		tools.create_trigger.inputSchema.shape,
		async (args) => {
			const result = await apiCall(config, 'POST', '/api/triggers', args)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	server.tool(
		'list_triggers',
		tools.list_triggers.description,
		tools.list_triggers.inputSchema.shape,
		async () => {
			const result = await apiCall(config, 'GET', '/api/triggers')
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	return server
}

// CLI entry point
async function main() {
	const config: McpConfig = {
		apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
		apiKey: process.env.API_KEY || '',
		workspaceId: process.env.WORKSPACE_ID || '',
	}

	if (!config.apiKey) {
		console.error('API_KEY environment variable is required')
		process.exit(1)
	}

	if (!config.workspaceId) {
		console.error('WORKSPACE_ID environment variable is required')
		process.exit(1)
	}

	const server = createMcpServer(config)
	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error('MCP server started (stdio transport)')
}

main().catch(console.error)
```

### `packages/mcp/src/tools.ts`

```typescript
import { z } from 'zod'

export const tools = {
	create_object: {
		description: 'Create a new object (insight, bet, or task) in the workspace',
		inputSchema: z.object({
			type: z.enum(['insight', 'bet', 'task']),
			title: z.string().optional(),
			content: z.string().optional(),
			status: z.string(),
			metadata: z.record(z.unknown()).optional(),
		}),
	},
	update_object: {
		description: 'Update an existing object by ID',
		inputSchema: z.object({
			id: z.string().uuid(),
			title: z.string().optional(),
			content: z.string().optional(),
			status: z.string().optional(),
			metadata: z.record(z.unknown()).optional(),
		}),
	},
	get_object: {
		description: 'Get a single object by ID',
		inputSchema: z.object({
			id: z.string().uuid(),
		}),
	},
	list_objects: {
		description: 'List objects with optional filters',
		inputSchema: z.object({
			type: z.enum(['insight', 'bet', 'task']).optional(),
			status: z.string().optional(),
			limit: z.number().int().min(1).max(100).default(50),
			offset: z.number().int().min(0).default(0),
		}),
	},
	delete_object: {
		description: 'Delete an object by ID',
		inputSchema: z.object({
			id: z.string().uuid(),
		}),
	},
	create_relationship: {
		description: 'Create a relationship between two objects',
		inputSchema: z.object({
			source_type: z.string(),
			source_id: z.string().uuid(),
			target_type: z.string(),
			target_id: z.string().uuid(),
			type: z
				.string()
				.describe('Relationship type: informs, breaks_into, blocks, relates_to, duplicates'),
		}),
	},
	list_relationships: {
		description: 'List relationships with optional filters',
		inputSchema: z.object({
			source_id: z.string().uuid().optional(),
			target_id: z.string().uuid().optional(),
			type: z.string().optional(),
		}),
	},
	delete_relationship: {
		description: 'Delete a relationship by ID',
		inputSchema: z.object({
			id: z.string().uuid(),
		}),
	},
	list_actors: {
		description: 'List all actors in the workspace',
		inputSchema: z.object({}),
	},
	get_actor: {
		description: 'Get actor details by ID',
		inputSchema: z.object({
			id: z.string().uuid(),
		}),
	},
	list_workspaces: {
		description: 'List workspaces accessible to the authenticated actor',
		inputSchema: z.object({}),
	},
	get_events: {
		description: 'Get recent events (activity log)',
		inputSchema: z.object({
			entity_type: z.string().optional(),
			action: z.string().optional(),
			limit: z.number().int().min(1).max(100).default(50),
		}),
	},
	create_trigger: {
		description: 'Create an automation trigger',
		inputSchema: z.object({
			name: z.string(),
			type: z.enum(['cron', 'event']),
			config: z.record(z.unknown()),
			action_prompt: z.string(),
			target_actor_id: z.string().uuid(),
			enabled: z.boolean().default(true),
		}),
	},
	list_triggers: {
		description: 'List all triggers in the workspace',
		inputSchema: z.object({}),
	},
} as const
```

### `packages/mcp/src/index.ts`

```typescript
export { createMcpServer } from './server.js'
export { tools } from './tools.js'
```

### `packages/mcp/tsconfig.json`

```json
{
	"extends": "../../tsconfig.json",
	"compilerOptions": {
		"outDir": "dist",
		"rootDir": "src"
	},
	"include": ["src"]
}
```

---

## apps/dev — Dev Workspace API

### `apps/dev/package.json`

```json
{
	"name": "@ai-native/dev",
	"version": "0.0.1",
	"private": true,
	"type": "module",
	"scripts": {
		"dev": "tsx watch src/index.ts",
		"build": "tsc",
		"start": "node dist/index.js",
		"test": "vitest"
	},
	"dependencies": {
		"@ai-native/auth": "workspace:*",
		"@ai-native/db": "workspace:*",
		"@ai-native/realtime": "workspace:*",
		"@ai-native/shared": "workspace:*",
		"@hono/node-server": "^1.13.0",
		"@hono/zod-openapi": "^0.18.0",
		"bcryptjs": "^2.4.3",
		"drizzle-orm": "^0.38.0",
		"hono": "^4.7.0",
		"postgres": "^3.4.0",
		"zod": "^3.24.0"
	},
	"devDependencies": {
		"@types/bcryptjs": "^2.4.6",
		"@types/node": "^25.5.0",
		"tsx": "^4.19.0",
		"typescript": "^5.7.0",
		"vitest": "^3.0.0"
	}
}
```

### `apps/dev/src/index.ts`

```typescript
import { authMiddleware } from '@ai-native/auth'
import { createDb } from '@ai-native/db'
import type { Database } from '@ai-native/db'
import { PgNotifyBridge } from '@ai-native/realtime'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import actorsRoutes from './routes/actors'
import eventsRoutes from './routes/events'
import objectsRoutes from './routes/objects'
import relationshipsRoutes from './routes/relationships'
import triggersRoutes from './routes/triggers'
import workspacesRoutes from './routes/workspaces'
import { TriggerRunner } from './services/trigger-runner'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
	}
}

const app = new Hono<Env>()

// Global middleware
app.use('*', cors())
app.use('*', logger())

// Database connection
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
	throw new Error('DATABASE_URL environment variable is required')
}
const db = createDb(databaseUrl)

// Real-time: PG NOTIFY → SSE bridge
const notifyBridge = new PgNotifyBridge(databaseUrl)
notifyBridge.start().then(() => {
	console.log('PG NOTIFY bridge started')
})

// Inject db and bridge into context
app.use('*', async (c, next) => {
	c.set('db', db)
	c.set('notifyBridge', notifyBridge)
	await next()
})

// Public routes (no auth required)
app.get('/api/health', (c) => {
	return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.get('/api/openapi.json', (c) => {
	return c.json({
		openapi: '3.1.0',
		info: {
			title: 'AI-Native OSS Dev Workspace API',
			version: '0.1.0',
			description: 'Unified API for insights, bets, tasks, actors, and automation',
		},
		servers: [{ url: process.env.BETTER_AUTH_URL || 'http://localhost:3000' }],
		paths: {},
	})
})

// Auth middleware for /api/* — skips public routes
const auth = authMiddleware(db)
app.use('/api/*', async (c, next) => {
	const path = c.req.path
	const method = c.req.method
	if (path === '/api/health' || path === '/api/openapi.json') return next()
	if (path === '/api/actors' && method === 'POST') return next()

	return auth(c, next)
})

// Mount routes
app.route('/api/objects', objectsRoutes)
app.route('/api/actors', actorsRoutes)
app.route('/api/workspaces', workspacesRoutes)
app.route('/api/relationships', relationshipsRoutes)
app.route('/api/triggers', triggersRoutes)
app.route('/api/events', eventsRoutes)

// Start trigger runner (cron + event-based automation)
const triggerRunner = new TriggerRunner(db, notifyBridge)
triggerRunner.start().then(() => {
	console.log('Trigger runner started')
})

const port = Number(process.env.PORT) || 3000
console.log(`Starting dev server on port ${port}`)

serve({ fetch: app.fetch, port })

export default app
export type AppType = typeof app
```

### `apps/dev/src/routes/objects.ts`

```typescript
import type { Database } from '@ai-native/db'
import { events, objects, workspaces } from '@ai-native/db/schema'
import { createObjectSchema, objectQuerySchema, updateObjectSchema } from '@ai-native/shared'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new Hono<Env>()

// POST /api/objects - Create object
app.post('/', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = createObjectSchema.parse(await c.req.json())

	// Validate status against workspace settings
	// Get workspace_id from header (X-Workspace-Id)
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) {
		return c.json({ error: 'X-Workspace-Id header required' }, 400)
	}

	// Fetch workspace to validate status
	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json({ error: 'Workspace not found' }, 404)
	}

	const settings = workspace.settings as any
	const validStatuses = settings?.statuses?.[body.type]
	if (validStatuses && !validStatuses.includes(body.status)) {
		return c.json(
			{
				error: `Invalid status '${body.status}' for type '${body.type}'`,
				valid_statuses: validStatuses,
			},
			400,
		)
	}

	const [created] = await db
		.insert(objects)
		.values({
			workspaceId,
			type: body.type,
			title: body.title,
			content: body.content,
			status: body.status,
			metadata: body.metadata,
			owner: body.owner,
			createdBy: actorId,
		})
		.returning()

	// Log event
	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'created',
		entityType: body.type,
		entityId: created.id,
		data: created,
	})

	return c.json(created, 201)
})

// GET /api/objects - List objects
app.get('/', async (c) => {
	const db = c.get('db')
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) {
		return c.json({ error: 'X-Workspace-Id header required' }, 400)
	}

	const query = objectQuerySchema.parse(c.req.query())

	const conditions = [eq(objects.workspaceId, workspaceId)]
	if (query.type) conditions.push(eq(objects.type, query.type))
	if (query.status) conditions.push(eq(objects.status, query.status))
	if (query.owner) conditions.push(eq(objects.owner, query.owner))

	const results = await db
		.select()
		.from(objects)
		.where(and(...conditions))
		.limit(query.limit)
		.offset(query.offset)
		.orderBy(objects.createdAt)

	return c.json(results)
})

// GET /api/objects/:id - Get object by ID
app.get('/:id', async (c) => {
	const db = c.get('db')
	const id = c.req.param('id')

	const [object] = await db.select().from(objects).where(eq(objects.id, id)).limit(1)

	if (!object) {
		return c.json({ error: 'Object not found' }, 404)
	}

	return c.json(object)
})

// PATCH /api/objects/:id - Update object
app.patch('/:id', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const id = c.req.param('id')
	const body = updateObjectSchema.parse(await c.req.json())

	// Get existing object for workspace context
	const [existing] = await db.select().from(objects).where(eq(objects.id, id)).limit(1)

	if (!existing) {
		return c.json({ error: 'Object not found' }, 404)
	}

	// If status is being updated, validate against workspace settings
	if (body.status) {
		const [workspace] = await db
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, existing.workspaceId))
			.limit(1)

		if (workspace) {
			const settings = workspace.settings as any
			const validStatuses = settings?.statuses?.[existing.type]
			if (validStatuses && !validStatuses.includes(body.status)) {
				return c.json(
					{
						error: `Invalid status '${body.status}' for type '${existing.type}'`,
						valid_statuses: validStatuses,
					},
					400,
				)
			}
		}
	}

	const [updated] = await db
		.update(objects)
		.set({
			...body,
			updatedAt: new Date(),
		})
		.where(eq(objects.id, id))
		.returning()

	// Log event
	const action = body.status && body.status !== existing.status ? 'status_changed' : 'updated'
	await db.insert(events).values({
		workspaceId: existing.workspaceId,
		actorId,
		action,
		entityType: existing.type,
		entityId: id,
		data: { previous: existing, updated },
	})

	return c.json(updated)
})

// DELETE /api/objects/:id
app.delete('/:id', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const id = c.req.param('id')

	const [existing] = await db.select().from(objects).where(eq(objects.id, id)).limit(1)

	if (!existing) {
		return c.json({ error: 'Object not found' }, 404)
	}

	await db.delete(objects).where(eq(objects.id, id))

	await db.insert(events).values({
		workspaceId: existing.workspaceId,
		actorId,
		action: 'deleted',
		entityType: existing.type,
		entityId: id,
		data: existing,
	})

	return c.json({ deleted: true })
})

export default app
```

### `apps/dev/src/routes/actors.ts`

```typescript
import { generateApiKey } from '@ai-native/auth'
import type { Database } from '@ai-native/db'
import { actors, workspaceMembers, workspaces } from '@ai-native/db/schema'
import { createActorSchema, updateActorSchema } from '@ai-native/shared'
import { workspaceSettingsSchema } from '@ai-native/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new Hono<Env>()

// POST /api/actors - Create actor (signup)
// This is a special route - it doesn't require auth for initial creation
app.post('/', async (c) => {
	const db = c.get('db')
	const body = createActorSchema.parse(await c.req.json())

	// Generate API key
	const { key, hash } = await generateApiKey()

	const [actor] = await db
		.insert(actors)
		.values({
			type: body.type,
			name: body.name,
			email: body.email,
			apiKeyHash: hash,
			systemPrompt: body.system_prompt,
			tools: body.tools,
			llmProvider: body.llm_provider,
			llmConfig: body.llm_config,
		})
		.returning()

	// Auto-create personal workspace for humans
	if (body.type === 'human') {
		const defaultSettings = workspaceSettingsSchema.parse({})
		const [workspace] = await db
			.insert(workspaces)
			.values({
				name: `${body.name}'s Workspace`,
				settings: defaultSettings,
				createdBy: actor.id,
			})
			.returning()

		await db.insert(workspaceMembers).values({
			workspaceId: workspace.id,
			actorId: actor.id,
			role: 'owner',
		})
	}

	// Return actor WITHOUT api_key_hash, but WITH the actual key (only time it's shown)
	const { apiKeyHash, ...actorWithoutHash } = actor
	return c.json({ ...actorWithoutHash, api_key: key }, 201)
})

// GET /api/actors - List actors (within workspace)
app.get('/', async (c) => {
	const db = c.get('db')
	const workspaceId = c.req.header('X-Workspace-Id')

	if (workspaceId) {
		// List actors in workspace
		const members = await db
			.select({
				id: actors.id,
				type: actors.type,
				name: actors.name,
				email: actors.email,
				role: workspaceMembers.role,
			})
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(eq(workspaceMembers.workspaceId, workspaceId))

		return c.json(members)
	}

	// List all actors (admin)
	const allActors = await db
		.select({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
		})
		.from(actors)

	return c.json(allActors)
})

// GET /api/actors/:id - Get actor
app.get('/:id', async (c) => {
	const db = c.get('db')
	const id = c.req.param('id')

	const [actor] = await db
		.select({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			systemPrompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llmProvider: actors.llmProvider,
			llmConfig: actors.llmConfig,
			createdAt: actors.createdAt,
			updatedAt: actors.updatedAt,
		})
		.from(actors)
		.where(eq(actors.id, id))
		.limit(1)

	if (!actor) {
		return c.json({ error: 'Actor not found' }, 404)
	}

	return c.json(actor)
})

// PATCH /api/actors/:id - Update actor
app.patch('/:id', async (c) => {
	const db = c.get('db')
	const id = c.req.param('id')
	const body = updateActorSchema.parse(await c.req.json())

	const [updated] = await db
		.update(actors)
		.set({
			...(body.name && { name: body.name }),
			...(body.email && { email: body.email }),
			...(body.system_prompt !== undefined && { systemPrompt: body.system_prompt }),
			...(body.tools !== undefined && { tools: body.tools }),
			...(body.memory !== undefined && { memory: body.memory }),
			...(body.llm_provider !== undefined && { llmProvider: body.llm_provider }),
			...(body.llm_config !== undefined && { llmConfig: body.llm_config }),
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			systemPrompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llmProvider: actors.llmProvider,
			llmConfig: actors.llmConfig,
			updatedAt: actors.updatedAt,
		})

	if (!updated) {
		return c.json({ error: 'Actor not found' }, 404)
	}

	return c.json(updated)
})

// POST /api/actors/:id/api-keys - Regenerate API key
app.post('/:id/api-keys', async (c) => {
	const db = c.get('db')
	const id = c.req.param('id')

	const { key, hash } = await generateApiKey()

	const [updated] = await db
		.update(actors)
		.set({ apiKeyHash: hash, updatedAt: new Date() })
		.where(eq(actors.id, id))
		.returning({ id: actors.id })

	if (!updated) {
		return c.json({ error: 'Actor not found' }, 404)
	}

	return c.json({ api_key: key })
})

export default app
```

### `apps/dev/src/routes/workspaces.ts`

```typescript
import type { Database } from '@ai-native/db'
import { actors, workspaceMembers, workspaces } from '@ai-native/db/schema'
import {
	createWorkspaceSchema,
	updateWorkspaceSchema,
	workspaceSettingsSchema,
} from '@ai-native/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new Hono<Env>()

// POST /api/workspaces
app.post('/', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = createWorkspaceSchema.parse(await c.req.json())

	const settings = workspaceSettingsSchema.parse(body.settings ?? {})

	const [workspace] = await db
		.insert(workspaces)
		.values({
			name: body.name,
			settings,
			createdBy: actorId,
		})
		.returning()

	// Auto-add creator as owner
	await db.insert(workspaceMembers).values({
		workspaceId: workspace.id,
		actorId,
		role: 'owner',
	})

	return c.json(workspace, 201)
})

// GET /api/workspaces - List workspaces for current actor
app.get('/', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')

	const results = await db
		.select({
			id: workspaces.id,
			name: workspaces.name,
			settings: workspaces.settings,
			role: workspaceMembers.role,
			createdAt: workspaces.createdAt,
		})
		.from(workspaceMembers)
		.innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
		.where(eq(workspaceMembers.actorId, actorId))

	return c.json(results)
})

// PATCH /api/workspaces/:id
app.patch('/:id', async (c) => {
	const db = c.get('db')
	const id = c.req.param('id')
	const body = updateWorkspaceSchema.parse(await c.req.json())

	const updateData: Record<string, unknown> = { updatedAt: new Date() }
	if (body.name) updateData.name = body.name
	if (body.settings) {
		// Merge settings with existing
		const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
		if (!existing) return c.json({ error: 'Workspace not found' }, 404)
		updateData.settings = {
			...(existing.settings as object),
			...body.settings,
		}
	}

	const [updated] = await db
		.update(workspaces)
		.set(updateData)
		.where(eq(workspaces.id, id))
		.returning()

	if (!updated) {
		return c.json({ error: 'Workspace not found' }, 404)
	}

	return c.json(updated)
})

// POST /api/workspaces/:id/members - Add member
app.post('/:id/members', async (c) => {
	const db = c.get('db')
	const workspaceId = c.req.param('id')
	const { actor_id, role } = await c.req.json()

	await db.insert(workspaceMembers).values({
		workspaceId,
		actorId: actor_id,
		role: role || 'member',
	})

	return c.json({ added: true }, 201)
})

// GET /api/workspaces/:id/members - List members
app.get('/:id/members', async (c) => {
	const db = c.get('db')
	const workspaceId = c.req.param('id')

	const members = await db
		.select({
			actorId: workspaceMembers.actorId,
			role: workspaceMembers.role,
			joinedAt: workspaceMembers.joinedAt,
			name: actors.name,
			type: actors.type,
		})
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(eq(workspaceMembers.workspaceId, workspaceId))

	return c.json(members)
})

export default app
```

### `apps/dev/src/routes/relationships.ts`

```typescript
import type { Database } from '@ai-native/db'
import { events, relationships } from '@ai-native/db/schema'
import { createRelationshipSchema, relationshipQuerySchema } from '@ai-native/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new Hono<Env>()

// POST /api/relationships
app.post('/', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ error: 'X-Workspace-Id header required' }, 400)

	const body = createRelationshipSchema.parse(await c.req.json())

	const [created] = await db
		.insert(relationships)
		.values({
			sourceType: body.source_type,
			sourceId: body.source_id,
			targetType: body.target_type,
			targetId: body.target_id,
			type: body.type,
			createdBy: actorId,
		})
		.returning()

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'relationship',
		entityId: created.id,
		data: created,
	})

	return c.json(created, 201)
})

// GET /api/relationships
app.get('/', async (c) => {
	const db = c.get('db')
	const query = relationshipQuerySchema.parse(c.req.query())

	const conditions = []
	if (query.source_id) conditions.push(eq(relationships.sourceId, query.source_id))
	if (query.target_id) conditions.push(eq(relationships.targetId, query.target_id))
	if (query.type) conditions.push(eq(relationships.type, query.type))

	const results = await db
		.select()
		.from(relationships)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.limit(query.limit)
		.offset(query.offset)
		.orderBy(relationships.createdAt)

	return c.json(results)
})

// DELETE /api/relationships/:id
app.delete('/:id', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('X-Workspace-Id')
	const id = c.req.param('id')

	const [existing] = await db.select().from(relationships).where(eq(relationships.id, id)).limit(1)

	if (!existing) return c.json({ error: 'Relationship not found' }, 404)

	await db.delete(relationships).where(eq(relationships.id, id))

	if (workspaceId) {
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'deleted',
			entityType: 'relationship',
			entityId: id,
			data: existing,
		})
	}

	return c.json({ deleted: true })
})

export default app
```

### `apps/dev/src/routes/triggers.ts`

```typescript
import type { Database } from '@ai-native/db'
import { triggers } from '@ai-native/db/schema'
import { createTriggerSchema, updateTriggerSchema } from '@ai-native/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new Hono<Env>()

// POST /api/triggers
app.post('/', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ error: 'X-Workspace-Id header required' }, 400)

	const body = createTriggerSchema.parse(await c.req.json())

	const [created] = await db
		.insert(triggers)
		.values({
			workspaceId,
			name: body.name,
			type: body.type,
			config: body.config,
			actionPrompt: body.action_prompt,
			targetActorId: body.target_actor_id,
			enabled: body.enabled,
			createdBy: actorId,
		})
		.returning()

	return c.json(created, 201)
})

// GET /api/triggers
app.get('/', async (c) => {
	const db = c.get('db')
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ error: 'X-Workspace-Id header required' }, 400)

	const results = await db.select().from(triggers).where(eq(triggers.workspaceId, workspaceId))

	return c.json(results)
})

// PATCH /api/triggers/:id
app.patch('/:id', async (c) => {
	const db = c.get('db')
	const id = c.req.param('id')
	const body = updateTriggerSchema.parse(await c.req.json())

	const updateData: Record<string, unknown> = { updatedAt: new Date() }
	if (body.name) updateData.name = body.name
	if (body.config) updateData.config = body.config
	if (body.action_prompt) updateData.actionPrompt = body.action_prompt
	if (body.target_actor_id) updateData.targetActorId = body.target_actor_id
	if (body.enabled !== undefined) updateData.enabled = body.enabled

	const [updated] = await db.update(triggers).set(updateData).where(eq(triggers.id, id)).returning()

	if (!updated) return c.json({ error: 'Trigger not found' }, 404)

	return c.json(updated)
})

// DELETE /api/triggers/:id
app.delete('/:id', async (c) => {
	const db = c.get('db')
	const id = c.req.param('id')

	const [existing] = await db.select().from(triggers).where(eq(triggers.id, id)).limit(1)
	if (!existing) return c.json({ error: 'Trigger not found' }, 404)

	await db.delete(triggers).where(eq(triggers.id, id))
	return c.json({ deleted: true })
})

export default app
```

### `apps/dev/src/routes/events.ts`

```typescript
import type { Database } from '@ai-native/db'
import { events } from '@ai-native/db/schema'
import type { PgEvent, PgNotifyBridge } from '@ai-native/realtime'
import { eventQuerySchema } from '@ai-native/shared'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
	}
}

const app = new Hono<Env>()

// GET /api/events - SSE stream
app.get('/', async (c) => {
	const db = c.get('db')
	const bridge = c.get('notifyBridge')
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ error: 'X-Workspace-Id header required' }, 400)

	const lastEventId = c.req.header('Last-Event-ID')

	return streamSSE(c, async (stream) => {
		// Replay missed events if Last-Event-ID is provided
		if (lastEventId) {
			const missed = await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, workspaceId), gt(events.id, Number(lastEventId))))
				.orderBy(asc(events.id))
				.limit(100)

			for (const event of missed) {
				await stream.writeSSE({
					id: String(event.id),
					event: event.action,
					data: JSON.stringify(event),
				})
			}
		}

		// Listen for new events
		const handler = (event: PgEvent) => {
			if (event.workspace_id !== workspaceId) return

			stream.writeSSE({
				id: event.event_id,
				event: event.action,
				data: JSON.stringify(event),
			})
		}

		bridge.on('event', handler)

		stream.onAbort(() => {
			bridge.off('event', handler)
		})

		// Keep connection alive
		while (true) {
			await stream.sleep(30000)
		}
	})
})

// GET /api/events/history - Paginated event history
app.get('/history', async (c) => {
	const db = c.get('db')
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ error: 'X-Workspace-Id header required' }, 400)

	const query = eventQuerySchema.parse(c.req.query())

	const conditions = [eq(events.workspaceId, workspaceId)]
	if (query.entity_type) conditions.push(eq(events.entityType, query.entity_type))
	if (query.entity_id) conditions.push(eq(events.entityId, query.entity_id))
	if (query.action) conditions.push(eq(events.action, query.action))
	if (query.since) conditions.push(gt(events.id, query.since))

	const results = await db
		.select()
		.from(events)
		.where(and(...conditions))
		.limit(query.limit)
		.offset(query.offset)
		.orderBy(desc(events.createdAt))

	return c.json(results)
})

export default app
```

### `apps/dev/src/services/agent-runner.ts`

```typescript
import type { Database } from '@ai-native/db'
import { events, actors, objects, relationships } from '@ai-native/db/schema'
import { eq } from 'drizzle-orm'
import type { LLMMessage, LLMTool, LLMToolCall } from '../lib/llm/adapter'
import { createLLMAdapter } from '../lib/llm/index'

interface AgentConfig {
	id: string
	systemPrompt: string
	tools: Record<string, unknown> | null
	memory: Record<string, unknown> | null
	llmProvider: string
	llmConfig: Record<string, unknown>
}

// Available tools that agents can use (mapped to DB operations)
function getAvailableTools(): LLMTool[] {
	return [
		{
			name: 'create_object',
			description: 'Create a new object (insight, bet, or task) in the workspace',
			parameters: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: ['insight', 'bet', 'task'] },
					title: { type: 'string' },
					content: { type: 'string' },
					status: { type: 'string' },
					metadata: { type: 'object' },
				},
				required: ['type', 'status'],
			},
		},
		{
			name: 'update_object',
			description: 'Update an existing object by ID',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', format: 'uuid' },
					title: { type: 'string' },
					content: { type: 'string' },
					status: { type: 'string' },
					metadata: { type: 'object' },
				},
				required: ['id'],
			},
		},
		{
			name: 'list_objects',
			description: 'List objects with optional filters',
			parameters: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: ['insight', 'bet', 'task'] },
					status: { type: 'string' },
					limit: { type: 'number', default: 50 },
				},
			},
		},
		{
			name: 'create_relationship',
			description: 'Create a relationship between two objects',
			parameters: {
				type: 'object',
				properties: {
					source_id: { type: 'string', format: 'uuid' },
					source_type: { type: 'string' },
					target_id: { type: 'string', format: 'uuid' },
					target_type: { type: 'string' },
					type: { type: 'string' },
				},
				required: ['source_id', 'source_type', 'target_id', 'target_type', 'type'],
			},
		},
		{
			name: 'update_memory',
			description: "Update the agent's persistent memory (survives across executions)",
			parameters: {
				type: 'object',
				properties: {
					memory: { type: 'object' },
				},
				required: ['memory'],
			},
		},
		{
			name: 'done',
			description: 'Signal that the agent has completed its task',
			parameters: {
				type: 'object',
				properties: {
					summary: { type: 'string' },
				},
			},
		},
	]
}

async function executeTool(
	db: Database,
	workspaceId: string,
	agentId: string,
	toolCall: LLMToolCall,
): Promise<string> {
	const args = toolCall.arguments

	switch (toolCall.name) {
		case 'create_object': {
			const [created] = await db
				.insert(objects)
				.values({
					workspaceId,
					type: args.type as string,
					title: args.title as string | undefined,
					content: args.content as string | undefined,
					status: args.status as string,
					metadata: args.metadata as Record<string, unknown> | undefined,
					createdBy: agentId,
				})
				.returning()

			await db.insert(events).values({
				workspaceId,
				actorId: agentId,
				action: 'created',
				entityType: args.type as string,
				entityId: created.id,
				data: created,
			})

			return JSON.stringify(created)
		}

		case 'update_object': {
			const updateData: Record<string, unknown> = { updatedAt: new Date() }
			if (args.title) updateData.title = args.title as string
			if (args.content) updateData.content = args.content as string
			if (args.status) updateData.status = args.status as string
			if (args.metadata) updateData.metadata = args.metadata

			const [updated] = await db
				.update(objects)
				.set(updateData)
				.where(eq(objects.id, args.id as string))
				.returning()

			if (!updated) return JSON.stringify({ error: 'Object not found' })

			await db.insert(events).values({
				workspaceId,
				actorId: agentId,
				action: 'updated',
				entityType: updated.type,
				entityId: updated.id,
				data: updated,
			})

			return JSON.stringify(updated)
		}

		case 'list_objects': {
			const conditions = [eq(objects.workspaceId, workspaceId)]
			if (args.type) conditions.push(eq(objects.type, args.type as string))
			if (args.status) conditions.push(eq(objects.status, args.status as string))

			const { and } = await import('drizzle-orm')
			const results = await db
				.select()
				.from(objects)
				.where(and(...conditions))
				.limit((args.limit as number) || 50)

			return JSON.stringify(results)
		}

		case 'create_relationship': {
			const [created] = await db
				.insert(relationships)
				.values({
					sourceType: args.source_type as string,
					sourceId: args.source_id as string,
					targetType: args.target_type as string,
					targetId: args.target_id as string,
					type: args.type as string,
					createdBy: agentId,
				})
				.returning()

			await db.insert(events).values({
				workspaceId,
				actorId: agentId,
				action: 'created',
				entityType: 'relationship',
				entityId: created.id,
				data: created,
			})

			return JSON.stringify(created)
		}

		case 'update_memory': {
			await db
				.update(actors)
				.set({ memory: args.memory as Record<string, unknown>, updatedAt: new Date() })
				.where(eq(actors.id, agentId))

			return JSON.stringify({ success: true })
		}

		case 'done':
			return JSON.stringify({ done: true, summary: args.summary })

		default:
			return JSON.stringify({ error: `Unknown tool: ${toolCall.name}` })
	}
}

export async function runAgent(
	db: Database,
	workspaceId: string,
	agentId: string,
	actionPrompt: string,
): Promise<{ success: boolean; summary?: string; error?: string }> {
	// Load agent config
	const [agent] = await db.select().from(actors).where(eq(actors.id, agentId)).limit(1)

	if (!agent || agent.type !== 'agent') {
		return { success: false, error: 'Agent not found or not an agent type' }
	}

	if (!agent.llmProvider || !agent.llmConfig) {
		return { success: false, error: 'Agent missing LLM configuration' }
	}

	const config: AgentConfig = {
		id: agent.id,
		systemPrompt: agent.systemPrompt || 'You are a helpful AI agent.',
		tools: agent.tools as Record<string, unknown> | null,
		memory: agent.memory as Record<string, unknown> | null,
		llmProvider: agent.llmProvider,
		llmConfig: agent.llmConfig as Record<string, unknown>,
	}

	const llm = createLLMAdapter(config.llmProvider, config.llmConfig)
	const tools = getAvailableTools()

	// Build initial messages
	const messages: LLMMessage[] = [{ role: 'system', content: config.systemPrompt }]

	// Include memory context if available
	if (config.memory) {
		messages.push({
			role: 'system',
			content: `Your persistent memory from previous executions:\n${JSON.stringify(config.memory, null, 2)}`,
		})
	}

	messages.push({ role: 'user', content: actionPrompt })

	// Log agent execution start
	await db.insert(events).values({
		workspaceId,
		actorId: agentId,
		action: 'agent_started',
		entityType: 'agent',
		entityId: agentId,
		data: { action_prompt: actionPrompt },
	})

	const maxIterations = 20
	let iteration = 0

	try {
		while (iteration < maxIterations) {
			iteration++

			const response = await llm.chat({
				model: (config.llmConfig.model as string) || 'claude-sonnet-4-20250514',
				messages,
				tools,
				temperature: config.llmConfig.temperature as number | undefined,
			})

			// If no tool calls, agent is done
			if (response.tool_calls.length === 0) {
				await db.insert(events).values({
					workspaceId,
					actorId: agentId,
					action: 'agent_completed',
					entityType: 'agent',
					entityId: agentId,
					data: { content: response.content, iterations: iteration },
				})
				return { success: true, summary: response.content || 'Agent completed' }
			}

			// Add assistant message with tool calls
			messages.push({
				role: 'assistant',
				content: response.content || '',
			})

			// Execute each tool call
			for (const toolCall of response.tool_calls) {
				const result = await executeTool(db, workspaceId, agentId, toolCall)

				messages.push({
					role: 'tool',
					content: result,
					tool_call_id: toolCall.id,
				})

				// Check if agent signaled done
				if (toolCall.name === 'done') {
					const parsed = JSON.parse(result)
					await db.insert(events).values({
						workspaceId,
						actorId: agentId,
						action: 'agent_completed',
						entityType: 'agent',
						entityId: agentId,
						data: { summary: parsed.summary, iterations: iteration },
					})
					return { success: true, summary: parsed.summary }
				}
			}
		}

		return { success: false, error: `Agent exceeded max iterations (${maxIterations})` }
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error'
		await db.insert(events).values({
			workspaceId,
			actorId: agentId,
			action: 'agent_failed',
			entityType: 'agent',
			entityId: agentId,
			data: { error: message },
		})
		return { success: false, error: message }
	}
}
```

### `apps/dev/src/services/trigger-runner.ts`

```typescript
import type { Database } from '@ai-native/db'
import { events, triggers } from '@ai-native/db/schema'
import type { PgEvent, PgNotifyBridge } from '@ai-native/realtime'
import { and, eq } from 'drizzle-orm'
import { runAgent } from './agent-runner'

export class TriggerRunner {
	private db: Database
	private bridge: PgNotifyBridge
	private cronIntervals: Map<string, NodeJS.Timeout> = new Map()

	constructor(db: Database, bridge: PgNotifyBridge) {
		this.db = db
		this.bridge = bridge
	}

	async start() {
		// Start event trigger listener
		this.bridge.on('event', (event: PgEvent) => {
			this.handleEvent(event).catch(console.error)
		})

		// Load and start cron triggers
		await this.loadCronTriggers()

		console.log('Trigger runner started')
	}

	async stop() {
		for (const [id, interval] of this.cronIntervals) {
			clearInterval(interval)
		}
		this.cronIntervals.clear()
	}

	private async handleEvent(event: PgEvent) {
		// Find matching event triggers for this workspace
		const matchingTriggers = await this.db
			.select()
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, event.workspace_id),
					eq(triggers.type, 'event'),
					eq(triggers.enabled, true),
				),
			)

		for (const trigger of matchingTriggers) {
			const config = trigger.config as Record<string, unknown>

			// Check if event matches trigger config
			if (config.entity_type && config.entity_type !== event.entity_type) continue
			if (config.action && config.action !== event.action) continue

			// Check filter conditions
			if (config.filter && event.data) {
				const filter = config.filter as Record<string, unknown>
				const data = event.data as Record<string, unknown>
				const matches = Object.entries(filter).every(([key, value]) => data[key] === value)
				if (!matches) continue
			}

			// Run the agent
			console.log(
				`Trigger '${trigger.name}' fired for event ${event.action} on ${event.entity_type}`,
			)

			// Log trigger fired event
			await this.db.insert(events).values({
				workspaceId: event.workspace_id,
				actorId: trigger.targetActorId,
				action: 'trigger_fired',
				entityType: 'trigger',
				entityId: trigger.id,
				data: {
					trigger_name: trigger.name,
					prompt: trigger.actionPrompt,
					target_actor_id: trigger.targetActorId,
					source_event: event,
				},
			})

			// Execute agent asynchronously (don't block event processing)
			runAgent(
				this.db,
				event.workspace_id,
				trigger.targetActorId,
				`${trigger.actionPrompt}\n\nTriggering event: ${JSON.stringify(event)}`,
			).catch(console.error)
		}
	}

	private async loadCronTriggers() {
		// Simple cron: parse expression to interval (MVP: only supports minute intervals)
		const cronTriggers = await this.db
			.select()
			.from(triggers)
			.where(and(eq(triggers.type, 'cron'), eq(triggers.enabled, true)))

		for (const trigger of cronTriggers) {
			this.scheduleCron(trigger)
		}
	}

	private scheduleCron(trigger: typeof triggers.$inferSelect) {
		const config = trigger.config as Record<string, unknown>
		const expression = config.expression as string

		// MVP: parse simple cron expressions (every N minutes)
		// Format: */N * * * * (every N minutes)
		const match = expression.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/)
		const intervalMinutes = match ? Number.parseInt(match[1]) : 60

		const interval = setInterval(
			async () => {
				console.log(`Cron trigger '${trigger.name}' firing`)

				await this.db.insert(events).values({
					workspaceId: trigger.workspaceId,
					actorId: trigger.targetActorId,
					action: 'trigger_fired',
					entityType: 'trigger',
					entityId: trigger.id,
					data: {
						trigger_name: trigger.name,
						prompt: trigger.actionPrompt,
						target_actor_id: trigger.targetActorId,
					},
				})

				runAgent(this.db, trigger.workspaceId, trigger.targetActorId, trigger.actionPrompt).catch(
					console.error,
				)
			},
			intervalMinutes * 60 * 1000,
		)

		this.cronIntervals.set(trigger.id, interval)
	}
}
```

### `apps/dev/src/lib/llm/adapter.ts`

```typescript
export interface LLMMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string
	tool_call_id?: string
}

export interface LLMToolCall {
	id: string
	name: string
	arguments: Record<string, unknown>
}

export interface LLMResponse {
	content: string | null
	tool_calls: LLMToolCall[]
	finish_reason: 'stop' | 'tool_calls' | 'length'
}

export interface LLMTool {
	name: string
	description: string
	parameters: Record<string, unknown> // JSON Schema
}

export interface LLMAdapter {
	chat(options: {
		model: string
		messages: LLMMessage[]
		tools?: LLMTool[]
		temperature?: number
	}): Promise<LLMResponse>
}
```

### `apps/dev/src/lib/llm/openai.ts`

```typescript
import type { LLMAdapter, LLMMessage, LLMResponse, LLMTool } from './adapter'

export class OpenAIAdapter implements LLMAdapter {
	private apiKey: string
	private baseUrl: string

	constructor(apiKey: string, baseUrl = 'https://api.openai.com/v1') {
		this.apiKey = apiKey
		this.baseUrl = baseUrl
	}

	async chat(options: {
		model: string
		messages: LLMMessage[]
		tools?: LLMTool[]
		temperature?: number
	}): Promise<LLMResponse> {
		const body: Record<string, unknown> = {
			model: options.model || 'gpt-4o',
			messages: options.messages.map((m) => ({
				role: m.role,
				content: m.content,
				...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
			})),
		}

		if (options.tools?.length) {
			body.tools = options.tools.map((t) => ({
				type: 'function',
				function: {
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				},
			}))
		}

		if (options.temperature !== undefined) {
			body.temperature = options.temperature
		}

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const error = await response.text()
			throw new Error(`OpenAI API error: ${response.status} ${error}`)
		}

		const data = (await response.json()) as Record<string, any>
		const choice = data.choices[0]

		const toolCalls = (choice.message.tool_calls || []).map((tc: any) => ({
			id: tc.id,
			name: tc.function.name,
			arguments: JSON.parse(tc.function.arguments),
		}))

		return {
			content: choice.message.content,
			tool_calls: toolCalls,
			finish_reason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
		}
	}
}
```

### `apps/dev/src/lib/llm/anthropic.ts`

```typescript
import type { LLMAdapter, LLMMessage, LLMResponse, LLMTool } from './adapter'

export class AnthropicAdapter implements LLMAdapter {
	private apiKey: string

	constructor(apiKey: string) {
		this.apiKey = apiKey
	}

	async chat(options: {
		model: string
		messages: LLMMessage[]
		tools?: LLMTool[]
		temperature?: number
	}): Promise<LLMResponse> {
		const systemMessage = options.messages.find((m) => m.role === 'system')
		const otherMessages = options.messages.filter((m) => m.role !== 'system')

		const body: Record<string, unknown> = {
			model: options.model || 'claude-sonnet-4-20250514',
			max_tokens: 4096,
			messages: otherMessages.map((m) => {
				if (m.role === 'tool') {
					return {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: m.tool_call_id,
								content: m.content,
							},
						],
					}
				}
				return { role: m.role, content: m.content }
			}),
		}

		if (systemMessage) {
			body.system = systemMessage.content
		}

		if (options.tools?.length) {
			body.tools = options.tools.map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters,
			}))
		}

		if (options.temperature !== undefined) {
			body.temperature = options.temperature
		}

		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this.apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const error = await response.text()
			throw new Error(`Anthropic API error: ${response.status} ${error}`)
		}

		const data = (await response.json()) as Record<string, any>

		const toolCalls = (data.content || [])
			.filter((block: any) => block.type === 'tool_use')
			.map((block: any) => ({
				id: block.id,
				name: block.name,
				arguments: block.input,
			}))

		const textContent = (data.content || [])
			.filter((block: any) => block.type === 'text')
			.map((block: any) => block.text)
			.join('')

		return {
			content: textContent || null,
			tool_calls: toolCalls,
			finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
		}
	}
}
```

### `apps/dev/src/lib/llm/index.ts`

```typescript
import type { LLMAdapter } from './adapter'
import { AnthropicAdapter } from './anthropic'
import { OpenAIAdapter } from './openai'

export function createLLMAdapter(provider: string, config: Record<string, unknown>): LLMAdapter {
	switch (provider) {
		case 'anthropic':
			return new AnthropicAdapter(config.api_key as string)
		case 'openai':
			return new OpenAIAdapter(config.api_key as string, config.base_url as string | undefined)
		case 'ollama':
			return new OpenAIAdapter('ollama', (config.base_url as string) || 'http://localhost:11434/v1')
		default:
			throw new Error(`Unsupported LLM provider: ${provider}`)
	}
}

export type { LLMAdapter, LLMMessage, LLMResponse, LLMTool, LLMToolCall } from './adapter'
```

### `apps/dev/Dockerfile`

```dockerfile
FROM node:20-alpine AS base
RUN corepack enable

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/realtime/package.json packages/realtime/package.json
COPY apps/dev/package.json apps/dev/package.json

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/dev/ apps/dev/
COPY tsconfig.json ./

RUN pnpm build

EXPOSE 3000
CMD ["node", "apps/dev/dist/index.js"]
```

### `apps/dev/vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
	},
})
```

### `apps/dev/tsconfig.json`

```json
{
	"extends": "../../tsconfig.json",
	"compilerOptions": {
		"outDir": "dist",
		"rootDir": "src"
	},
	"include": ["src"]
}
```
