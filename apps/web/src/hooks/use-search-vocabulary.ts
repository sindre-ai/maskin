// The words the search field recognises (type and status words), built from the
// workspace's real object types. The page and the launcher share it.

import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { type VocabularyType, buildVocabulary } from '@/lib/search/vocabulary'
import { useMemo } from 'react'

export function humanize(key: string): string {
	const text = key.replace(/_/g, ' ')
	return text.charAt(0).toUpperCase() + text.slice(1)
}

export function useSearchVocabulary() {
	const objectTypes = useAvailableObjectTypes()
	return useMemo(() => {
		const types: VocabularyType[] = objectTypes.map((t) => ({
			key: t.value,
			label: humanize(t.value),
			plural: t.label,
		}))
		return buildVocabulary(types)
	}, [objectTypes])
}
