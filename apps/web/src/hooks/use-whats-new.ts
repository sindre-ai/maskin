import {
	WHATS_NEW_ENTRIES,
	type WhatsNewEntry,
	newestUndismissed,
	readDismissedWhatsNew,
	writeDismissedWhatsNew,
} from '@/lib/whats-new'
import { useCallback, useState } from 'react'

/** The newest undismissed "What's new" entry and a way to dismiss it for good in this browser. */
export function useWhatsNew(entries: WhatsNewEntry[] = WHATS_NEW_ENTRIES) {
	const [dismissed, setDismissed] = useState<string[]>(readDismissedWhatsNew)
	const entry = newestUndismissed(entries, dismissed)

	const dismiss = useCallback(() => {
		if (!entry) return
		const next = [...dismissed, entry.id]
		writeDismissedWhatsNew(next)
		setDismissed(next)
	}, [entry, dismissed])

	return { entry, dismiss }
}
