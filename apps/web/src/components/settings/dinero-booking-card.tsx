import { useCanReview } from '@/components/settings/dinero-review-section'
import { QueryState } from '@/components/shared/query-state'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useActors } from '@/hooks/use-actors'
import { useDineroBooking, useSetDineroBooking } from '@/hooks/use-dinero-review'
import type { DineroBookingState } from '@/lib/api'
import { useState } from 'react'

/**
 * Settings → Dinero booking. The owner's switch for what the flow may do in Dinero: book vouchers,
 * register payments, send quotes. It shows the statement first, who last changed the switch and
 * when, and one button. Switching on needs the tick "I have read this". The switch sits on the
 * Dinero connection, so it covers every company that login reaches. Only a person who is an admin
 * or owner sees it, the same rule as the review below it.
 */
export function DineroBookingCard({ workspaceId }: { workspaceId: string }) {
	const canChange = useCanReview()
	const query = useDineroBooking(workspaceId, canChange)
	if (!canChange) return null

	return (
		<section aria-labelledby="dinero-booking-heading" className="flex flex-col gap-3">
			<h2 id="dinero-booking-heading" className="text-sm font-semibold text-foreground">
				Dinero booking
			</h2>
			<QueryState query={query} isEmpty={() => false} errorTitle="Couldn't load Dinero booking">
				{(state) => <BookingBody workspaceId={workspaceId} state={state} />}
			</QueryState>
		</section>
	)
}

function BookingBody({ workspaceId, state }: { workspaceId: string; state: DineroBookingState }) {
	const set = useSetDineroBooking(workspaceId)
	const actors = useActors(workspaceId)
	const [read, setRead] = useState(false)
	const setBy = actors.data?.find((a) => a.id === state.set_by)?.name

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
			<p className="text-xs font-medium text-foreground">
				Booking is {state.enabled ? 'on' : 'off'}.
				{state.set_at && (
					<span className="font-normal text-muted-foreground">
						{' '}
						Switched {state.enabled ? 'on' : 'off'} by {setBy ?? 'a workspace admin'} on{' '}
						{new Date(state.set_at).toLocaleString()}.
					</span>
				)}
			</p>
			<p className="text-xs text-muted-foreground">
				This switch is on the Dinero connection, so it covers every company that login reaches, not
				one company.
			</p>
			<p className="text-xs text-muted-foreground">{state.statement}</p>
			{state.enabled ? (
				<div className="flex justify-end">
					<Button
						variant="outline"
						disabled={set.isPending}
						onClick={() => set.mutate({ enabled: false }, { onSuccess: () => setRead(false) })}
					>
						Switch booking off
					</Button>
				</div>
			) : (
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex items-center gap-2">
						<Checkbox
							id="dinero-booking-read"
							checked={read}
							onCheckedChange={(v) => setRead(v === true)}
						/>
						<Label htmlFor="dinero-booking-read" className="text-xs">
							I have read this
						</Label>
					</div>
					<Button
						disabled={!read || set.isPending}
						onClick={() =>
							set.mutate({ enabled: true, acknowledged: true }, { onSuccess: () => setRead(false) })
						}
					>
						Switch booking on
					</Button>
				</div>
			)}
		</div>
	)
}
