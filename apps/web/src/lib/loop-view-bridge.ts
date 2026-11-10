import type { DataQuerySpec } from '@maskin/shared'
import { BRIDGE_QUERY_MESSAGE, BRIDGE_RESULT_MESSAGE, VIEWER_DOC_SIZE_MESSAGE } from './mini-app'
import {
	LIST_REFUSED_MESSAGE,
	type ListAnswer,
	type ListSource,
	type ListSourceEntry,
} from './view-lists'

// Host side of the loop-view data bridge (see the bridge section in mini-app.ts
// for the frame side). Everything the sandboxed frame can make us do goes
// through `handleBridgeMessage`, so the trust rules live in one place:
//   - the message must come from OUR iframe's window (the frame has a null
//     origin, so event.origin proves nothing);
//   - nothing is answered once the frame is marked blocked (it navigated away);
//   - only source names the view declared are run, with the viewer's own session
//     (`run`), and the frame only ever gets the result back;
//   - a named list (rows) is answered only when the host opts in with `allowLists`, and
//     only from what the host chose to give (`listAnswer`), never by running anything
//     on the frame's request. The loop page does not opt in.

export interface BridgeHost {
	/** The iframe's current window; compared against event.source. */
	frameWindow: () => unknown
	/** True once the frame navigated away from its srcdoc. Nothing is answered while it is. */
	isBlocked: () => boolean
	/** The sources the view declared, by name. */
	sources: () => ReadonlyMap<string, DataQuerySpec>
	/** Runs a declared query as the viewer. */
	run: (spec: DataQuerySpec) => Promise<unknown>
	/** Whether this host may answer list sources. The file viewer says yes; the loop page leaves it off and every list is refused. */
	allowLists?: boolean
	/** The list sources the view declared, by name. A `null` entry asked for something the app does not offer. */
	listSources?: () => ReadonlyMap<string, ListSourceEntry>
	/** What a list source is answered with right now. Must not fetch: rows exist only after the user's Refresh click. */
	listAnswer?: (name: string, source: ListSource) => ListAnswer
	post: (message: Record<string, unknown>) => void
	onDocHeight: (height: number) => void
	/** The view's content is wider than its frame: the width it needs. Optional; hosts that never scroll sideways skip it. */
	onDocOverflow?: (width: number) => void
	onQueryError: (message: string) => void
}

/**
 * Which declared sources a live event can change, by key. A source counts objects of one
 * type, so only an event about that type matters; a loop-scoped source also depends on
 * the in_loop edges, which arrive as relationship events. A `null` event (events may have
 * been missed) affects every source.
 */
export function sourcesAffectedBy(
	event: { entity_type: string } | null,
	sources: ReadonlyMap<string, DataQuerySpec>,
): Set<string> {
	const affected = new Set<string>()
	for (const spec of sources.values()) {
		const hit =
			event === null ||
			event.entity_type === spec.type ||
			(spec.scope !== 'workspace' && event.entity_type === 'relationship')
		if (hit) affected.add(JSON.stringify(spec))
	}
	return affected
}

export async function handleBridgeMessage(
	host: BridgeHost,
	event: { source: unknown; data: unknown },
): Promise<void> {
	const frame = host.frameWindow()
	if (!frame || event.source !== frame || host.isBlocked()) return
	const data = event.data as {
		type?: unknown
		id?: unknown
		name?: unknown
		h?: unknown
		w?: unknown
		cw?: unknown
	} | null
	if (!data || typeof data !== 'object') return

	if (data.type === VIEWER_DOC_SIZE_MESSAGE) {
		if (typeof data.h === 'number' && data.h > 0) host.onDocHeight(data.h)
		if (typeof data.w === 'number' && typeof data.cw === 'number' && data.w > data.cw) {
			host.onDocOverflow?.(data.w)
		}
		return
	}
	if (data.type !== BRIDGE_QUERY_MESSAGE) return
	if (typeof data.id !== 'number' || typeof data.name !== 'string') return

	const { id, name } = data
	const spec = host.sources().get(name)
	if (!spec) {
		const list = host.listSources?.().get(name)
		if (list !== undefined) {
			if (!host.allowLists || list === null || !host.listAnswer) {
				host.post({ type: BRIDGE_RESULT_MESSAGE, id, error: LIST_REFUSED_MESSAGE })
				return
			}
			host.post({ type: BRIDGE_RESULT_MESSAGE, id, data: host.listAnswer(name, list) })
			return
		}
		host.post({
			type: BRIDGE_RESULT_MESSAGE,
			id,
			error: `Source "${name}" is not declared in the maskin-sources block.`,
		})
		return
	}
	try {
		const result = await host.run(spec)
		// The frame may have navigated while the request was in flight.
		if (host.isBlocked()) return
		host.post({ type: BRIDGE_RESULT_MESSAGE, id, data: result })
	} catch (err) {
		const message = err instanceof Error ? err.message : 'The query failed.'
		if (host.isBlocked()) return
		host.post({ type: BRIDGE_RESULT_MESSAGE, id, error: message })
		host.onQueryError(message)
	}
}
