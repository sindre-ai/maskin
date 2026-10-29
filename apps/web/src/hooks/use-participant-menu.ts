// The @ menu's state: which rows are showing for the words typed so far, which one
// is highlighted, and whether Esc has put it away. The field owns the keys, the host
// (page or launcher) owns where the menu is drawn. Focus never leaves the input.

import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { getStoredActor } from '@/lib/auth'
import { PARTICIPANT_FILTER_FLAG, findMention, mentionRows } from '@/lib/search/mention'
import type { SearchParts } from '@/lib/search/parts'
import type { ParticipantOption, Vocabulary } from '@/lib/search/vocabulary'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'

export type PickVia = 'click' | 'tab' | 'keyboard'

export interface ParticipantMenuState {
	open: boolean
	rows: ParticipantOption[]
	listboxId: string
	activeIndex: number
	/** DOM id of the highlighted row, for aria-activedescendant. */
	activeId: string | undefined
	move: (delta: 1 | -1) => void
	pick: (option: ParticipantOption, via: PickVia) => void
	pickActive: (via: PickVia) => void
	dismiss: () => void
}

export function participantOptionId(listboxId: string, id: string): string {
	return `${listboxId}-${id}`
}

export function useParticipantMenu(input: {
	parts: SearchParts
	/** Who can be picked. Null leaves the menu off (feature flag). */
	options: ParticipantOption[] | null
	onPick: (option: ParticipantOption, via: PickVia) => void
}): ParticipantMenuState {
	const { parts, options, onPick } = input
	const listboxId = useId()
	// The text at the moment Esc was pressed: the menu stays away until the text changes.
	const [dismissedAt, setDismissedAt] = useState<string | null>(null)
	const [active, setActive] = useState(0)

	const rows = useMemo(() => (options ? mentionRows(parts, options) : []), [parts, options])
	const open = rows.length > 0 && dismissedAt !== parts.text
	const query = findMention(parts.text)?.query
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top row
	useEffect(() => {
		setActive(0)
	}, [query])

	const activeIndex = Math.min(active, Math.max(rows.length - 1, 0))
	const activeRow = rows[activeIndex]

	const move = useCallback(
		(delta: 1 | -1) => setActive((i) => (i + delta + rows.length) % Math.max(rows.length, 1)),
		[rows.length],
	)
	const pickActive = useCallback(
		(via: PickVia) => {
			if (activeRow) onPick(activeRow, via)
		},
		[activeRow, onPick],
	)
	const dismiss = useCallback(() => setDismissedAt(parts.text), [parts.text])

	return {
		open,
		rows,
		listboxId,
		activeIndex,
		activeId: open && activeRow ? participantOptionId(listboxId, activeRow.id) : undefined,
		move,
		pick: onPick,
		pickActive,
		dismiss,
	}
}

/**
 * Who the @ menu offers: every person and agent in the workspace except the caller,
 * who is in all of their own chats. Null while the feature flag is off.
 */
export function useParticipantOptions(vocab: Vocabulary): ParticipantOption[] | null {
	const enabled = useFeatureFlag(PARTICIPANT_FILTER_FLAG)
	return useMemo(() => {
		if (!enabled) return null
		const selfId = getStoredActor()?.id
		return [...vocab.participants.values()].filter((p) => p.id !== selfId)
	}, [enabled, vocab])
}
