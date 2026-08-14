import { SIGNUP_CAPTURE_SOURCE, SIGNUP_FIRST_BET_DRAFT_SOURCE } from '@maskin/shared'
import { useMemo } from 'react'
import type { ObjectResponse } from '../lib/api'
import { useObjects } from './use-objects'

function pickMostRecent(rows: ObjectResponse[] | undefined): ObjectResponse | null {
	if (!rows || rows.length === 0) return null
	const sorted = rows.slice().sort((a, b) => {
		const at = a.createdAt ? new Date(a.createdAt).getTime() : 0
		const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0
		return bt - at
	})
	return sorted[0] ?? null
}

// The bet the council promoted during this workspace's signup: qualified,
// metadata.source=signup_first_bet_draft, most-recent-first. Server-side
// metadata filter (see apps/dev/src/routes/objects.ts) keeps the list small
// even in workspaces with hundreds of bets.
export function useSignupDraftBet(workspaceId: string) {
	const query = useObjects(workspaceId, {
		type: 'bet',
		status: 'qualified',
		'metadata.source': SIGNUP_FIRST_BET_DRAFT_SOURCE,
	})
	const bet = useMemo(() => pickMostRecent(query.data), [query.data])
	return { bet, isLoading: query.isLoading, isSuccess: query.isSuccess }
}

// A workspace is signup-driven when the signup form wrote a knowledge object
// carrying metadata.source=signup_capture (see packages/shared/src/schemas/
// signup-capture.ts). One such object per workspace, so a single presence
// check is enough — no need to sort or pick.
export function useIsSignupWorkspace(workspaceId: string) {
	const query = useObjects(workspaceId, {
		type: 'knowledge',
		'metadata.source': SIGNUP_CAPTURE_SOURCE,
	})
	const isSignup = (query.data?.length ?? 0) > 0
	return { isSignup, isLoading: query.isLoading, isSuccess: query.isSuccess }
}
