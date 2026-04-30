/**
 * Maskin web app deep-link URL contract.
 *
 * **Treat the URL patterns in this file as a public contract.** MCP cards,
 * external integrations, notifications, and any other surface that links
 * back into the web app builds its hrefs via `buildWebAppPath`. Renaming or
 * restructuring a route requires updating both the TanStack Router file in
 * `apps/web/src/routes/` and the corresponding `case` below — and ideally a
 * server-side redirect from the old path so existing chat transcripts and
 * notification rows don't break.
 *
 * URL pattern per object type currently exposed by `packages/mcp`:
 *
 * | Object type      | Pattern                              | Target kind          |
 * | ---------------- | ------------------------------------ | -------------------- |
 * | insight          | /{ws}/objects/{id}                   | object               |
 * | bet              | /{ws}/objects/{id}                   | object               |
 * | task             | /{ws}/objects/{id}                   | object               |
 * | meeting          | /{ws}/objects/{id}                   | object               |
 * | document         | /{ws}/objects/{id}                   | object               |
 * | decision         | /{ws}/objects/{id}                   | object               |
 * | risk             | /{ws}/objects/{id}                   | object               |
 * | metric           | /{ws}/objects/{id}                   | object               |
 * | canvas           | /{ws}/objects/{id}                   | object               |
 * | organization     | /{ws}/objects/{id}                   | object               |
 * | person           | /{ws}/objects/{id}                   | object               |
 * | actor (= agent)  | /{ws}/agents/{id}                    | actor / agent        |
 * | trigger          | /{ws}/triggers/{id}                  | trigger              |
 * | session          | /{ws}/agents/{actorId}               | session              |
 * | notification     | /{ws}                                | notification / pulse |
 * | extension        | /{ws}/settings                       | extension / settings |
 * | relationship     | /{ws}/objects/{sourceId}             | relationship         |
 * | workspace        | /{ws}                                | workspace            |
 *
 * Types stored in the unified `objects` table all resolve through the
 * `object` kind. Types backed by their own table (actor, trigger, session,
 * notification, extension, relationship, workspace) each have a dedicated
 * kind; the resulting URL falls back to the closest existing route when no
 * dedicated detail page exists yet (sessions, notifications, extensions,
 * relationships are surfaced inside the parent context today).
 *
 * Unauthenticated callers hitting any `/{ws}/...` URL are redirected through
 * the `/login` route by `apps/web/src/routes/_authed.tsx`'s auth guard, then
 * bounced back to the requested path. Callers do not need to handle the auth
 * case explicitly.
 */

/**
 * Object types stored in the unified `objects` table. Every entry resolves to
 * `/{ws}/objects/{id}`. Add new entries here when introducing a new object
 * type (e.g. `goal`, `note`) so callers can validate inputs against this list.
 */
export const WEB_APP_OBJECT_TYPES = [
	'insight',
	'bet',
	'task',
	'meeting',
	'document',
	'decision',
	'risk',
	'metric',
	'canvas',
	'organization',
	'person',
] as const

export type WebAppObjectType = (typeof WEB_APP_OBJECT_TYPES)[number]

/**
 * Sub-sections inside the workspace settings page. Mirrors the file tree
 * under `apps/web/src/routes/_authed/$workspaceId/settings/`.
 */
export type WebAppSettingsSection =
	| 'integrations'
	| 'keys'
	| 'mcp'
	| 'members'
	| 'skills'
	| 'objects'

/**
 * Discriminated union covering every deep-link target the MCP surface
 * (or any other web-app caller) can produce. Adding a new case here is
 * additive — older clients that don't understand the new kind will hide
 * the link via `useWebAppHref` returning `null`, which is the documented
 * graceful-degradation contract.
 */
export type WebAppTarget =
	/** Workspace root — currently the Pulse Dashboard. */
	| { kind: 'workspace' }
	/** Pulse dashboard — alias for the workspace root, kept distinct so the
	 * intent of the link survives if the dashboard moves. */
	| { kind: 'pulse' }
	/** Cross-workspace activity feed (`/_authed/$workspaceId/activity`). */
	| { kind: 'activity' }
	/** Detail page for any object stored in the unified `objects` table. */
	| { kind: 'object'; id: string; type?: WebAppObjectType }
	/** Actor detail (humans + agents share the same identity model — both
	 * resolve via `/agents/{id}`). `agent` is kept as an alias of `actor`
	 * for callers that have already adopted the older name. */
	| { kind: 'actor'; id?: string }
	| { kind: 'agent'; id?: string }
	/** Trigger list or detail. */
	| { kind: 'trigger'; id?: string }
	/** Container session — no dedicated detail page yet, falls back to the
	 * actor that ran it. Pass `actorId` so the link lands on the right page;
	 * if omitted we link to the activity feed where sessions surface. */
	| { kind: 'session'; id: string; actorId?: string }
	/** Notification — no detail page yet, falls back to the Pulse Dashboard
	 * where notifications surface. The `id` is recorded for forward-compat
	 * but ignored by the current URL builder. */
	| { kind: 'notification'; id?: string }
	/** Extension / module — no detail page yet, falls back to the settings
	 * root. The `id` (extension slug) is recorded for forward-compat. */
	| { kind: 'extension'; id?: string }
	/** Relationship between two objects — there is no dedicated detail page
	 * (relationships render inside the source object's detail view), so we
	 * link to the source object. Callers must pass `sourceId`. */
	| { kind: 'relationship'; sourceId: string; targetId?: string; type?: string }
	/** Workspace settings (root or a specific section). */
	| { kind: 'settings'; section?: WebAppSettingsSection }

/**
 * Build the URL **path** (no origin) for a deep link into the web app for
 * the given target, scoped to the workspace `workspaceId`. Always returns a
 * leading-slash path; combine with `_meta.webAppBaseUrl` (which is itself
 * trailing-slash-normalised on the server) to get the full href.
 *
 * Stable contract: never throws, always returns a string. Unknown future
 * kinds — should one slip through after a TS-only refactor — degrade to the
 * workspace root rather than producing a broken href.
 */
export function buildWebAppPath(workspaceId: string, target: WebAppTarget): string {
	const root = `/${workspaceId}`
	switch (target.kind) {
		case 'workspace':
		case 'pulse':
			return root
		case 'notification':
			return root
		case 'activity':
			return `${root}/activity`
		case 'object':
			return `${root}/objects/${target.id}`
		case 'actor':
		case 'agent':
			return target.id ? `${root}/agents/${target.id}` : `${root}/agents`
		case 'trigger':
			return target.id ? `${root}/triggers/${target.id}` : `${root}/triggers`
		case 'session':
			return target.actorId ? `${root}/agents/${target.actorId}` : `${root}/activity`
		case 'extension':
			return `${root}/settings`
		case 'relationship':
			return `${root}/objects/${target.sourceId}`
		case 'settings':
			return target.section ? `${root}/settings/${target.section}` : `${root}/settings`
		default: {
			// Exhaustiveness guard — also defends against runtime kinds from
			// older transcripts that this version doesn't know about.
			const _exhaustive: never = target
			void _exhaustive
			return root
		}
	}
}

/**
 * Build the full deep-link URL by joining the server-supplied
 * `webAppBaseUrl` with the path produced by `buildWebAppPath`. `baseUrl` is
 * expected to be already trailing-slash-normalised by the server-side `meta()`
 * helper in `packages/mcp/src/server.ts`; this helper does not re-normalise
 * so callers see a single source of truth.
 */
export function buildWebAppHref(
	baseUrl: string,
	workspaceId: string,
	target: WebAppTarget,
): string {
	return `${baseUrl}${buildWebAppPath(workspaceId, target)}`
}
