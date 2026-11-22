import type { Database } from '@maskin/db'
import { installedLoops, marketplaceLoops } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { parseSseData } from '../integrations/mcp-gateway'
import { logger } from '../logger'
import { flowsOfSession } from '../session-flow'
import { capturePosthogEvent } from './posthog'

// Success event of the accounting flow bet: one per receipt saved as a draft in the customer's
// accounting system. The vendor's MCP server is not ours, so the gateway that forwards the call
// is the only place that sees it.
export const RECEIPT_DRAFT_BOOKED = 'receipt_draft_booked'

interface ReceiptDraftConnector {
	connector: string
	/** The vendor's MCP host. A server is matched on this, never on a name the customer typed. */
	host: string
	/** Env var holding the comma separated names of the tools that save a draft. */
	toolsEnv: string
}

// Dinero's tool that saves a purchase voucher as a draft is named by the CTO's test against the
// real server; the vendor's page lists none. Until the env var is set nothing is counted.
const CONNECTORS: readonly ReceiptDraftConnector[] = [
	{ connector: 'dinero', host: 'mcp.dinero.dk', toolsEnv: 'DINERO_DRAFT_TOOLS' },
]

/** The connector whose draft-save tool this call is, or null for every other call. */
export function receiptDraftConnector(
	upstreamUrl: string,
	tool: string,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	let host: string
	try {
		host = new URL(upstreamUrl).hostname.toLowerCase()
	} catch {
		return null
	}
	const match = CONNECTORS.find((c) => c.host === host)
	if (!match) return null
	const tools = (env[match.toolsEnv] ?? '')
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean)
	return tools.includes(tool) ? match.connector : null
}

/**
 * Whether an upstream answer to one tools/call is a success: a result that is not flagged
 * isError, and no JSON-RPC error. The answer is plain JSON or an event stream. Anything that
 * cannot be read counts as not a success, so a refused or failed call never produces the event.
 */
export function toolCallSucceeded(responseText: string, requestId: unknown): boolean {
	let messages: unknown[]
	try {
		messages = responseText.trimStart().startsWith('{')
			? [JSON.parse(responseText)]
			: parseSseData(responseText)
	} catch {
		return false
	}
	const answer = messages.find(
		(m): m is { id?: unknown; result?: { isError?: unknown }; error?: unknown } =>
			!!m &&
			typeof m === 'object' &&
			(m as { id?: unknown }).id === requestId &&
			('result' in m || 'error' in m),
	)
	if (!answer || answer.error !== undefined || !answer.result) return false
	return answer.result.isError !== true
}

/** The slug of the installed marketplace flow the session runs under, or null for none. */
export async function flowSlugOfSession(
	db: Database,
	p: { workspaceId: string; actorId: string; sessionId: string | undefined },
): Promise<string | null> {
	if (!p.sessionId) return null
	const flows = await flowsOfSession(db, {
		workspaceId: p.workspaceId,
		agentId: p.actorId,
		sessionId: p.sessionId,
	})
	if (flows.length === 0) return null
	const rows = await db
		.select({ slug: marketplaceLoops.slug })
		.from(installedLoops)
		.innerJoin(marketplaceLoops, eq(marketplaceLoops.id, installedLoops.sourceLoopId))
		.where(
			and(
				eq(installedLoops.workspaceId, p.workspaceId),
				inArray(
					installedLoops.objectId,
					flows.map((f) => f.id),
				),
			),
		)
		.orderBy(marketplaceLoops.slug)
		.limit(1)
	return rows[0]?.slug ?? null
}

interface ReceiptDraftBookedProps {
	flowSlug: string | null
	connector: string
	workspaceId: string
	actorId: string
}

/**
 * Counts and ids only: never the receipt, its file name, the voucher or the tool's arguments or
 * answer. receipt-events.test.ts asserts the exact key set. `internal` and `is_team` are added
 * by capturePosthogEvent. Best-effort: never throws.
 */
export async function trackReceiptDraftBooked(p: ReceiptDraftBookedProps): Promise<void> {
	await capturePosthogEvent(RECEIPT_DRAFT_BOOKED, p.actorId, {
		flow_slug: p.flowSlug,
		connector: p.connector,
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
	})
}

/**
 * Reads the upstream answer to a draft-save call and counts it once if it succeeded. Runs on a
 * clone of the answer, so it never delays or alters what the agent receives.
 */
export async function countReceiptDraft(p: {
	db: Database
	upstream: Response
	requestId: unknown
	connector: string
	workspaceId: string
	actorId: string
	sessionId: string | undefined
}): Promise<void> {
	try {
		if (!p.upstream.ok) return
		const text = await p.upstream.clone().text()
		if (!toolCallSucceeded(text, p.requestId)) return
		const flowSlug = await flowSlugOfSession(p.db, p)
		await trackReceiptDraftBooked({
			flowSlug,
			connector: p.connector,
			workspaceId: p.workspaceId,
			actorId: p.actorId,
		})
	} catch (err) {
		logger.warn('Could not count a receipt draft', {
			workspaceId: p.workspaceId,
			error: err instanceof Error ? err.name : 'unknown',
		})
	}
}
