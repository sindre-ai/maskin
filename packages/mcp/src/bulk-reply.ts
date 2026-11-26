// Slim replies for bulk writes.
//
// A write tool echoes what it wrote. With about 40 items that echo runs to
// 100k characters, over the tool limit, so the caller sees an error although the
// change was applied and may retry and double up. Read tools cut rows to fit
// (response-cap.ts); a write cannot, because the caller must see every item's
// result. So a big batch shrinks each item instead, and keeps every item.
//
// A call at or under BULK_REPLY_THRESHOLD items keeps the full reply, which the
// web cards (apps/web/src/mcp-apps/objects) and voice receipts read.

/** Batches larger than this get the slim reply. */
export const BULK_REPLY_THRESHOLD = 5

export function isBulkReply(itemCount: number): boolean {
	return itemCount > BULK_REPLY_THRESHOLD
}

function pick(row: unknown, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	if (row == null || typeof row !== 'object') return out
	for (const key of keys) {
		const value = (row as Record<string, unknown>)[key]
		if (value !== undefined) out[key] = value
	}
	return out
}

/** create_objects: id, $id, type, title, status and url per created object, no bodies. */
export function slimCreatedNodes(nodes: unknown[]): Array<Record<string, unknown>> {
	return nodes.map((node) => pick(node, ['id', '$id', 'type', 'title', 'status', 'url']))
}

/** create_objects: the ends of each created edge, no titles or metadata. */
export function slimCreatedEdges(edges: unknown[]): Array<Record<string, unknown>> {
	return edges.map((edge) => pick(edge, ['id', 'type', 'sourceId', 'targetId']))
}

/** update_objects, create_objects: same results array, each entry without its echoed result. */
export function slimResults<T extends { result?: unknown }>(
	results: T[],
): Array<Omit<T, 'result'>> {
	return results.map(({ result: _result, ...rest }) => rest)
}

/** update_loop: the loop row reduced to what says which loop it was. */
export function slimLoopRow(loop: unknown): Record<string, unknown> {
	return pick(loop, ['id', 'title', 'status', 'url'])
}
