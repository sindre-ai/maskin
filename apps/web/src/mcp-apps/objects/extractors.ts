import type { ObjectResponse } from '../shared/types'

export interface UpdateObjectsResultItem {
	type?: string
	id?: string
	success?: boolean
	result?: ObjectResponse
}

/** Pull the first successfully updated object out of an `update_objects` tool result envelope. */
export function extractFirstUpdatedObject(toolResult: {
	content?: Array<{ type: string; text?: string }>
}): ObjectResponse | null {
	const text = toolResult.content?.find((c) => c.type === 'text')?.text
	if (!text) return null
	try {
		const parsed = JSON.parse(text)
		if (!Array.isArray(parsed)) return null
		const first = (parsed as UpdateObjectsResultItem[]).find(
			(r) => r?.type === 'object' && r.success && r.result,
		)
		return first?.result ?? null
	} catch {
		return null
	}
}

/** Flatten the `get_objects` response (array of `{ success, result: { object } }`) into a list of objects. */
export function extractGetObjectsList(data: unknown): ObjectResponse[] {
	if (!Array.isArray(data)) return []
	const out: ObjectResponse[] = []
	for (const r of data as Array<{ success?: boolean; result?: { object?: ObjectResponse } }>) {
		const obj = r?.success ? r.result?.object : undefined
		if (obj) out.push(obj)
	}
	return out
}

/** Flatten the `update_objects` response into a list of successfully updated objects (relationship items ignored). */
export function extractUpdateObjectsList(data: unknown): ObjectResponse[] {
	if (!Array.isArray(data)) return []
	return (data as UpdateObjectsResultItem[])
		.filter((r) => r?.type === 'object' && r.success && r.result)
		.map((r) => r.result as ObjectResponse)
}

export interface UpdateObjectsSummary {
	objectsUpdated: number
	objectsFailed: number
	relationshipsCreated: number
	relationshipsFailed: number
}

/** Count successes and failures across an `update_objects` response (objects and relationships). */
export function summarizeUpdateResults(data: unknown): UpdateObjectsSummary {
	const summary: UpdateObjectsSummary = {
		objectsUpdated: 0,
		objectsFailed: 0,
		relationshipsCreated: 0,
		relationshipsFailed: 0,
	}
	if (!Array.isArray(data)) return summary
	for (const r of data as Array<{ type?: string; success?: boolean }>) {
		if (r?.type === 'object') {
			if (r.success) summary.objectsUpdated += 1
			else summary.objectsFailed += 1
		} else if (r?.type === 'relationship') {
			if (r.success) summary.relationshipsCreated += 1
			else summary.relationshipsFailed += 1
		}
	}
	return summary
}

/** Extract the list of created nodes from a `create_objects` response. Tolerates bare arrays for safety. */
export function extractCreateObjectsList(data: unknown): ObjectResponse[] {
	if (Array.isArray(data)) return data as ObjectResponse[]
	if (data && typeof data === 'object' && 'nodes' in data) {
		const nodes = (data as { nodes?: ObjectResponse[] }).nodes
		return Array.isArray(nodes) ? nodes : []
	}
	return []
}
