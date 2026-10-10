# Data Model

Maskin uses a unified object model — insights, bets, tasks, and any custom types all share the same table with a `type` discriminator. This keeps the schema flat and lets agents reason across object types uniformly.

## Tables overview

| Table | Purpose |
|-------|---------|
| **actors** | Humans and AI agents. Both are first-class citizens |
| **workspaces** | Isolated environments with configurable settings |
| **workspace_members** | Many-to-many join between actors and workspaces with roles |
| **objects** | The core table — every insight, bet, task, and custom type |
| **relationships** | Typed edges between objects |
| **events** | Append-only activity log for audit and real-time feed |
| **triggers** | Automation rules (cron or event-based) |
| **integrations** | External service connections per workspace |
| **sessions** | Container-based agent execution sessions |
| **session_logs** | Append-only log output from container sessions |
| **agent_files** | Metadata index for agent files stored in S3 |

## Core tables

### actors

Humans and AI agents share the same identity model. Agent actors can have system prompts, tool configurations, and LLM settings.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key (auto-generated) |
| `type` | text | `"human"` or `"agent"` |
| `name` | text | Display name |
| `email` | text | Unique, optional |
| `api_key` | text | API key for authentication |
| `password_hash` | text | Password hash (for human actors) |
| `system_prompt` | text | Agent system prompt |
| `tools` | JSONB | Agent tool configuration |
| `memory` | JSONB | Agent persistent memory |
| `llm_provider` | text | LLM provider name |
| `llm_config` | JSONB | LLM configuration (model, temperature, etc.) |
| `created_by` | UUID | Self-referential FK to actors |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

### workspaces

Isolated environments. Each workspace has its own settings including valid statuses per object type, enabled modules, display names, and field definitions.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `name` | text | Workspace name |
| `settings` | JSONB | Configuration: `enabled_modules`, `statuses`, `display_names`, `field_definitions` |
| `created_by` | UUID | FK to actors |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

### objects

The core table. Every insight, bet, task, and custom extension type is stored here with a `type` discriminator.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `workspace_id` | UUID | FK to workspaces |
| `type` | text | Object type: `"insight"`, `"bet"`, `"task"`, or custom types |
| `title` | text | Object title |
| `content` | text | Object content (markdown) |
| `status` | text | Current status (validated against workspace settings) |
| `metadata` | JSONB | Custom fields defined by extensions |
| `owner` | UUID | FK to actors (assigned owner) |
| `active_session_id` | UUID | Currently running agent session |
| `created_by` | UUID | FK to actors |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

Indexed on `(workspace_id, type, status)` for fast filtered queries.

### relationships

Universal edge table connecting objects. Each relationship has a type that describes the connection.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `source_type` | text | Source entity type |
| `source_id` | UUID | Source entity ID |
| `target_type` | text | Target entity type |
| `target_id` | UUID | Target entity ID |
| `type` | text | Relationship type |
| `created_by` | UUID | FK to actors |
| `created_at` | timestamp | Creation time |

**Relationship types:**
- `informs` — an insight informs a bet
- `breaks_into` — a bet breaks into tasks
- `blocks` — one object blocks another
- `relates_to` — general association
- `duplicates` — marks a duplicate

Unique constraint on `(source_id, target_id, type)`.

### events

Append-only activity log. Every create, update, and delete operation is logged. A PostgreSQL trigger fires `NOTIFY` on insert, which powers the real-time SSE stream.

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigserial | Auto-incrementing ID |
| `workspace_id` | UUID | FK to workspaces |
| `actor_id` | UUID | FK to actors (who performed the action) |
| `action` | text | Action performed (e.g., `"created"`, `"status_changed"`) |
| `entity_type` | text | Entity type affected |
| `entity_id` | UUID | Entity ID affected |
| `data` | JSONB | Action payload (old/new values, etc.) |
| `created_at` | timestamp | Event time |

## Automation tables

### triggers

Automation rules. Either cron-based (runs on schedule) or event-based (fires when a matching event occurs). Each trigger is assigned to an agent actor.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `workspace_id` | UUID | FK to workspaces |
| `name` | text | Trigger name |
| `type` | text | `"cron"` or `"event"` |
| `enabled` | boolean | Whether the trigger is active |
| `actor_id` | UUID | FK to actors (agent to run) |
| `config` | JSONB | Trigger configuration (schedule or event conditions) |
| `action_prompt` | text | Prompt sent to the agent when triggered |
| `created_by` | UUID | FK to actors |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

### sessions

Container-based agent execution sessions. Each session runs in an ephemeral Docker container.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `workspace_id` | UUID | FK to workspaces |
| `actor_id` | UUID | FK to actors |
| `trigger_id` | UUID | FK to triggers (optional) |
| `status` | text | `"pending"`, `"running"`, `"completed"`, `"paused"`, `"failed"`, `"timeout"` |
| `config` | JSONB | Container configuration (image, env, timeout, working directory) |
| `started_at` | timestamp | Session start time |
| `completed_at` | timestamp | Session end time |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

### session_logs

Append-only log output from container sessions, used for SSE streaming.

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigserial | Auto-incrementing ID |
| `session_id` | UUID | FK to sessions |
| `type` | text | `"stdout"`, `"stderr"`, or `"system"` |
| `content` | text | Log line content |
| `created_at` | timestamp | Log time |

## Storage tables

### agent_files

Metadata index for agent files stored in S3-compatible storage. Agents persist skills, learnings, and memory across sessions.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `actor_id` | UUID | FK to actors |
| `workspace_id` | UUID | FK to workspaces |
| `file_type` | text | File category (e.g., `"skill"`, `"learning"`, `"memory"`) |
| `file_path` | text | S3 object key |
| `metadata` | JSONB | File metadata |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

### integrations

External service connections per workspace (OAuth-based).

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `workspace_id` | UUID | FK to workspaces |
| `provider` | text | Integration provider name |
| `credentials` | JSONB | Encrypted OAuth credentials |
| `external_id` | text | External account/team identifier |
| `metadata` | JSONB | Provider-specific metadata |
| `created_by` | UUID | FK to actors |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

## Key design decisions

- **Unified objects** — all product work types share one table, making it easy for agents to query across types
- **Event sourcing** — every mutation is logged, providing a complete audit trail and powering real-time updates
- **JSONB metadata** — custom fields live in JSONB, so extensions don't require schema migrations
- **Universal relationships** — the relationship table connects any objects, supporting flexible graph structures
- **Agent-first auth** — API keys (not sessions/cookies) make it easy for agents to authenticate
