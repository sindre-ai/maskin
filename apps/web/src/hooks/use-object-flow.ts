import { useLoops } from '@/hooks/use-loops'
import { useObjectGraph } from '@/hooks/use-objects'
import { findFlowId } from '@/lib/object-detail-meta'
import { useMemo } from 'react'

/**
 * The flow an item sits in, read off the graph the page already loads plus the
 * cached flows list. Undefined when the item is in no flow.
 */
export function useObjectFlow(workspaceId: string, objectId: string) {
	const { data: graph } = useObjectGraph(workspaceId, objectId)
	const { data: loops } = useLoops(workspaceId)
	return useMemo(() => {
		const flowId = findFlowId(graph?.relationships, objectId)
		if (!flowId) return undefined
		const loop = loops?.find((l) => l.id === flowId)
		return loop ? { id: loop.id, name: loop.name ?? 'Flow' } : undefined
	}, [graph?.relationships, loops, objectId])
}
