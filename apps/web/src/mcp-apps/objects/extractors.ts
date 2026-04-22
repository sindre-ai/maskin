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
		const parsed = JSON.parse(text) as UpdateObjectsResultItem[]
		const first = parsed?.find((r) => r.type === 'object' && r.success && r.result)
		return first?.result ?? null
	} catch {
		return null
	}
}

/** Flatten the `get_objects` response (array of `{ success, result: { object } }`) into a list of objects. */
export function extractGetObjectsList(
	data: Array<{ success?: boolean; result?: { object?: ObjectResponse } }>,
): ObjectResponse[] {
	if (!Array.isArray(data)) return []
	const out: ObjectResponse[] = []
	for (const r of data) {
		const obj = r?.success ? r.result?.object : undefined
		if (obj) out.push(obj)
	}
	return out
}

/** Flatten the `update_objects` response into a list of successfully updated objects (relationship items ignored). */
export function extractUpdateObjectsList(data: UpdateObjectsResultItem[]): ObjectResponse[] {
	if (!Array.isArray(data)) return []
	return data
		.filter((r) => r?.type === 'object' && r.success && r.result)
		.map((r) => r.result as ObjectResponse)
}

/** Extract the list of created nodes from a `create_objects` response. Tolerates bare arrays for safety. */
export function extractCreateObjectsList(
	data: { nodes?: ObjectResponse[] } | ObjectResponse[] | null | undefined,
): ObjectResponse[] {
	if (Array.isArray(data)) return data
	return data?.nodes ?? []
}
