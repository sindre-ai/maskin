# Input Validation at System Boundaries

All external inputs must be validated before use. This applies to HTTP parameters, environment variables, webhook payloads, database trigger payloads, and file contents.

## HTTP Query/Path Parameters

- **Always use safe numeric parsing.** `Number()` returns `NaN` for non-numeric strings, which silently propagates through arithmetic and into SQL queries.

  ```ts
  // WRONG — NaN propagates silently
  const limit = Number(req.query.limit)

  // RIGHT — safe default on invalid input
  const raw = Number(req.query.limit)
  const limit = Number.isFinite(raw) && raw > 0 ? raw : 20
  ```

- Validate and constrain all numeric params: check `Number.isFinite()`, enforce min/max bounds, and provide a sensible default.
- For string params used in queries, validate expected format (e.g., UUID regex) before passing to the database.
- Reference: PR #235 — `Number('abc')` produced `NaN` that propagated into SQL.

## Environment Variable Keys and Values

- **Never interpolate untrusted strings into shell commands.** This includes `export` statements, template literals passed to `exec()`, or any string that becomes part of a shell command.
- Validate env var keys match `[A-Za-z_][A-Za-z0-9_]*` before interpolation:

  ```ts
  // WRONG — allows shell injection via key
  const exports = vars.map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n')

  // RIGHT — validate key format first
  const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
  for (const [k] of vars) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`Invalid env var key: ${k}`)
  }
  ```

- When building shell commands programmatically, prefer array-based APIs (e.g., `spawn(cmd, args)`) over string interpolation.
- Reference: PR #230 — shell injection vulnerability via `buildEnvExports()`.

## Database Trigger Payloads (PG NOTIFY)

- **PG NOTIFY has an 8KB payload limit.** Any trigger that calls `pg_notify()` must ensure the payload stays under this limit.
- Always truncate or omit large fields (especially `content`, `description`, or any free-text column) before including them in the notification payload.
- When writing a new migration with `pg_notify()`, check existing migrations for prior art:
  - `0006_notify_drop_data.sql` already fixed this for the events table — follow the same pattern.
- Test with realistic data sizes, not just small test fixtures.
- Reference: PR #224 — `NEW.content` in `session_logs` trigger exceeded 8KB.

## Webhook and External API Payloads

- Validate webhook payloads with Zod schemas before processing. Check `packages/shared/src/schemas/` for existing schemas before writing inline validation.
- Never trust `Content-Length` headers or payload structure from external sources.
- Validate required fields exist and have expected types before accessing nested properties.

## General Rules

- **Validate at the boundary, trust internally.** Once data passes validation at the system edge (route handler, webhook endpoint, CLI argument parser), internal functions can trust it.
- Use Zod schemas from `packages/shared/src/schemas/` for request body validation — check for existing schemas before writing new inline validation.
- For any new DB trigger that uses `NOTIFY`, check payload size against the 8KB limit.
- When in doubt about whether an input is "external," treat it as external and validate it.
