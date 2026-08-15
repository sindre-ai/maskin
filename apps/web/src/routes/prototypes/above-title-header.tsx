import { OwnerSelect, StatusSelect } from '@/components/objects/property-selects'
import { IndicatorBadgeChip } from '@/components/shared/indicator-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import type { MemberResponse } from '@/lib/api'
import type { BetStatusResult } from '@/lib/bet-status'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/prototypes/above-title-header')({
	component: AboveTitleHeaderPrototype,
})

// Position-only prototype for the parent bet's First Test — answers whether the
// four elements fit above the object title at 375/768/1024 without wrapping
// that pushes the h1 below the fold. No changes to object-document.tsx in T1.
// Matches the real hero container width (`max-w-3xl mx-auto`) and title styling
// (`text-2xl font-semibold tracking-[-0.022em]`) so the fit result is
// representative of the real page.

const STATUSES = ['define', 'active', 'live', 'paused', 'closed']

const MEMBERS: MemberResponse[] = [
	{
		actorId: 'actor-1',
		role: 'admin',
		joinedAt: '2026-01-01T00:00:00Z',
		name: 'Sindre Aakhus',
		type: 'human',
	},
	{
		actorId: 'actor-2',
		role: 'member',
		joinedAt: '2026-01-01T00:00:00Z',
		name: 'Developer',
		type: 'agent',
	},
]

const BET_STATUS: BetStatusResult = {
	state: 'progressing',
	pendingAction: {
		kind: 'progressing',
		tasks: [{ id: 'task-1', title: 'Ship the widget', driver: 'actor-2', status: 'in_progress' }],
	},
	decisionsSoFar: [],
}

function AboveTitleHeaderPrototype() {
	const [status, setStatus] = useState('active')
	const [ownerId, setOwnerId] = useState<string | null>('actor-1')

	return (
		<div className="min-h-screen bg-background p-6 md:p-10">
			<div className="w-full min-w-0 max-w-3xl mx-auto">
				{/* Above-title header row — TypeBadge + StatusSelect +
				 * IndicatorBadgeChip + OwnerSelect. `flex-wrap` allowed on 375 per
				 * DoD; must not push the h1 below the fold at 812 tall. */}
				<div data-testid="above-title-header" className="flex flex-wrap items-center gap-2 mb-3">
					<TypeBadge type="bet" />
					<StatusSelect current={status} options={STATUSES} onChange={setStatus} />
					<IndicatorBadgeChip result={BET_STATUS} workspaceId="prototype-workspace" />
					<OwnerSelect members={MEMBERS} currentOwnerId={ownerId} onChange={setOwnerId} />
				</div>

				<h1
					data-testid="prototype-title"
					className="w-full text-2xl font-semibold tracking-[-0.022em] text-foreground"
				>
					Object detail — move type, statuses, and driver above the title
				</h1>
			</div>
		</div>
	)
}
