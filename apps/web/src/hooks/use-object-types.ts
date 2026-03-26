import { getObjectTypes, getTypeDefinition } from '@ai-native/shared'
import { useMemo } from 'react'
import { useWorkspace } from '@/lib/workspace-context'
import type { ObjectTypeDefinition } from '@ai-native/shared'

export function useObjectTypes(): ObjectTypeDefinition[] {
	const { workspace } = useWorkspace()
	return useMemo(
		() => getObjectTypes(workspace.settings as Parameters<typeof getObjectTypes>[0]),
		[workspace.settings],
	)
}

export function useObjectType(slug: string): ObjectTypeDefinition | undefined {
	const { workspace } = useWorkspace()
	return useMemo(
		() => getTypeDefinition(workspace.settings as Parameters<typeof getObjectTypes>[0], slug),
		[workspace.settings, slug],
	)
}
