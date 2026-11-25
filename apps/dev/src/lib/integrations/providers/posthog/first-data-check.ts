import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { MCP_PROBE_TIMEOUT_MS, fetchWithCheckedRedirects } from '../../mcp-probe'
import { POSTHOG_PROJECT_HEADER } from './project-pin'

const POSTHOG_MCP_URL = 'https://mcp.posthog.com/mcp'
const EVENT_COUNT_SQL = 'SELECT count() AS n FROM events WHERE timestamp > now() - INTERVAL 30 DAY'

export type FirstDataStatus = 'has_events' | 'no_events' | 'key_rejected' | 'project_unreadable'

export type FirstDataCheck = { status: FirstDataStatus; message: string | null }

/**
 * The words the connect screen and the agent tool show. One place, so both say the same
 * thing. No raw error text ever goes in here, and never the key.
 */
export const POSTHOG_CHECK_MESSAGES = {
	noEvents: (projectId: string | null) =>
		`No events in this project yet. Checked ${
			projectId ? `project ${projectId}` : 'the project this key opens first'
		}.`,
	keyRejected: 'PostHog did not accept this key. Make a new one with the MCP Server preset.',
	projectUnreadable:
		'We could not read this project with this key. Check the project id and that the key can see it.',
} as const

/** The check could not tell an empty project from a failed read. */
export class UnreadableProjectError extends Error {}
/** PostHog answered 401: the key itself is not valid. */
export class KeyRejectedError extends Error {}

type Reader = (apiKey: string, projectId: string | null) => Promise<number>

/** The number in the answer to the count query: a rows array, or the "n\n123" text PostHog sends. */
export function parseEventCount(text: string): number | null {
	try {
		const body = JSON.parse(text) as { results?: unknown }
		const first = Array.isArray(body.results) ? (body.results[0] as unknown) : body.results
		const cell = Array.isArray(first) ? first[0] : first
		if (typeof cell === 'number' && Number.isFinite(cell)) return cell
		if (typeof cell === 'string') return parseEventCount(cell)
	} catch {
		// Not JSON: fall through to the text form.
	}
	const lastLine = text.trim().split('\n').pop()?.trim() ?? ''
	return /^\d+$/.test(lastLine) ? Number(lastLine) : null
}

/** One read through PostHog's own tool server, which routes the EU and US regions itself. */
export const readEventCount: Reader = async (apiKey, projectId) => {
	const transport = new StreamableHTTPClientTransport(new URL(POSTHOG_MCP_URL), {
		requestInit: {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				...(projectId ? { [POSTHOG_PROJECT_HEADER]: projectId } : {}),
			},
		},
		fetch: fetchWithCheckedRedirects(),
	})
	const client = new Client(
		{ name: 'maskin-posthog-check', version: '1.0.0' },
		{ capabilities: {} },
	)
	const timeout = { timeout: MCP_PROBE_TIMEOUT_MS }
	try {
		await client.connect(transport, timeout)
		const { tools } = await client.listTools(undefined, timeout)
		const names = new Set(tools.map((t) => t.name))
		// PostHog's server offers either the query tool itself or one command tool that runs it.
		const request = names.has('execute-sql')
			? { name: 'execute-sql', arguments: { query: EVENT_COUNT_SQL } }
			: names.has('exec')
				? {
						name: 'exec',
						arguments: {
							command: `call execute-sql ${JSON.stringify({ query: EVENT_COUNT_SQL })}`,
							context: 'a first check that a newly connected project has events',
						},
					}
				: null
		if (!request) throw new UnreadableProjectError('no query tool')
		const result = await client.callTool(request, undefined, timeout)
		const text = (result.content as { type: string; text?: string }[] | undefined)
			?.map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
			.join('\n')
		const count = result.isError || !text ? null : parseEventCount(text)
		if (count === null) throw new UnreadableProjectError('unreadable answer')
		return count
	} catch (err) {
		if (err instanceof UnreadableProjectError) throw err
		if ((err as { code?: number }).code === 401) throw new KeyRejectedError('unauthorized')
		throw new UnreadableProjectError('read failed')
	} finally {
		await client.close().catch(() => {})
	}
}

/**
 * Has the project this key reads got any events in the last 30 days? Never throws and never
 * carries the key or a raw error: the answer is one of four plain results.
 */
export async function checkPostHogFirstData(
	apiKey: string,
	projectId: string | null,
	read: Reader = readEventCount,
): Promise<FirstDataCheck> {
	try {
		const count = await read(apiKey, projectId)
		return count > 0
			? { status: 'has_events', message: null }
			: { status: 'no_events', message: POSTHOG_CHECK_MESSAGES.noEvents(projectId) }
	} catch (err) {
		return err instanceof KeyRejectedError
			? { status: 'key_rejected', message: POSTHOG_CHECK_MESSAGES.keyRejected }
			: { status: 'project_unreadable', message: POSTHOG_CHECK_MESSAGES.projectUnreadable }
	}
}
