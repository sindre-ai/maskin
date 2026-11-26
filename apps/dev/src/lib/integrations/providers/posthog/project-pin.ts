import type { McpServerSpec } from '../../types'

/** PostHog reads this header as the project a session starts in. It does not stop the agent switching. */
export const POSTHOG_PROJECT_HEADER = 'x-posthog-project-id'

/** PostHog project ids are plain numbers. Anything else would end up in a header, so it is refused. */
const PROJECT_ID = /^\d{1,12}$/

export type ParsedProjectId = { ok: true; projectId: string | null } | { ok: false }

/** Empty means "no pin". A number or a numeric string is accepted; everything else is refused. */
export function parsePostHogProjectId(raw: unknown): ParsedProjectId {
	if (raw === undefined || raw === null) return { ok: true, projectId: null }
	const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null
	if (text === null) return { ok: false }
	if (text === '') return { ok: true, projectId: null }
	return PROJECT_ID.test(text) ? { ok: true, projectId: text } : { ok: false }
}

/** The project saved on the integration row, or null when none is set. */
export function readPostHogProjectId(config: unknown): string | null {
	const raw = (config as { project_id?: unknown } | null)?.project_id
	const parsed = parsePostHogProjectId(raw)
	return parsed.ok ? parsed.projectId : null
}

/** The tool server entry with the project header added. Without a saved project it is returned unchanged. */
export function withPostHogProjectPin(server: McpServerSpec, config: unknown): McpServerSpec {
	const projectId = readPostHogProjectId(config)
	if (!projectId || server.type !== 'http') return server
	return { ...server, headers: { ...server.headers, [POSTHOG_PROJECT_HEADER]: projectId } }
}
