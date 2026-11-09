// The words the search field recognises (type and status words), built from the
// workspace's real object types, plus the people and agents the @ menu offers and
// the participant pill names. The page and the launcher share it.

import { useActors } from '@/hooks/use-actors'
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import {
	type ParticipantOption,
	type VocabularyType,
	buildVocabulary,
} from '@/lib/search/vocabulary'
import { useWorkspace } from '@/lib/workspace-context'
import { useMemo } from 'react'

export function humanize(key: string): string {
	const text = key.replace(/_/g, ' ')
	return text.charAt(0).toUpperCase() + text.slice(1)
}

export function useSearchVocabulary() {
	const objectTypes = useAvailableObjectTypes()
	const { workspaceId } = useWorkspace()
	const { data: actors } = useActors(workspaceId)
	return useMemo(() => {
		const types: VocabularyType[] = objectTypes.map((t) => ({
			key: t.value,
			label: humanize(t.value),
			plural: t.label,
		}))
		// Built-in agents (Workspace Coach, Chief of Staff) are chat partners too, so they stay.
		const participants: ParticipantOption[] = (actors ?? [])
			.filter((a) => a.type === 'human' || a.type === 'agent')
			.map((a) => ({ id: a.id, name: a.name, type: a.type === 'agent' ? 'agent' : 'human' }))
		return buildVocabulary(types, participants)
	}, [objectTypes, actors])
}
