import { Skeleton } from '@/components/shared/loading-skeleton'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { useUpdateObject } from '@/hooks/use-objects'
import { trackLoopViewCardAction } from '@/lib/analytics'
import { api } from '@/lib/api'
import type { ProposedChange } from '@/lib/loop-view-bridge'
import { queryKeys } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'

interface LoopViewChangePromptProps {
	workspaceId: string
	loopId: string
	/** The change a view proposed, or null when none is waiting for an answer. */
	change: ProposedChange | null
	/** The person said no, or closed the question. Nothing was saved. */
	onCancel: () => void
	/** The change was saved. */
	onSaved: () => void
}

const currentYear = () => new Date().getUTCFullYear()

/** "14 Nov", or "14 Nov 2027" when the year is not this one. Dates are plain days, so no time zone moves them. */
export function formatDay(value: string): string {
	const [y, m, d] = value.split('-').map(Number) as [number, number, number]
	const day = new Date(Date.UTC(y, m - 1, d))
	return day.toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'short',
		...(y === currentYear() ? {} : { year: 'numeric' }),
		timeZone: 'UTC',
	})
}

function question(change: ProposedChange): string {
	return change.field === 'post_time'
		? `Set post time to ${change.value}?`
		: `Move to ${formatDay(change.value)}?`
}

function shown(field: ProposedChange['field'], value: unknown): string {
	if (typeof value !== 'string' || value === '') return 'not set'
	return field === 'scheduled_date' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDay(value) : value
}

/**
 * The question a view's proposed change raises, asked by the page outside the view. The view
 * only says what it would like; this is where the person answers. Yes saves the one field as
 * the person, and only if the item is still in the status shown. No, or closing, saves nothing.
 * The words come from the item itself, not from the view.
 */
export function LoopViewChangePrompt({
	workspaceId,
	loopId,
	change,
	onCancel,
	onSaved,
}: LoopViewChangePromptProps) {
	const id = change?.id ?? ''
	// Read again each time it opens: the "from" value must be what is saved now, not what the page cached.
	const { data: object, isLoading } = useQuery({
		queryKey: queryKeys.objects.detail(id),
		queryFn: () => api.objects.get(id),
		enabled: !!change,
		staleTime: 0,
	})
	const update = useUpdateObject(workspaceId)
	const found = object && object.workspaceId === workspaceId ? object : null
	const before = found
		? shown(change?.field ?? 'scheduled_date', found.metadata?.[change?.field ?? ''])
		: null

	const confirm = () => {
		if (!change || !found) return
		// Sent before the save, so every saved change can be matched to a click.
		trackLoopViewCardAction({
			entity_id: found.id,
			object_type: found.type,
			loop_id: loopId,
			action: 'date_change',
		})
		update.mutate(
			{
				id: found.id,
				data: { metadata: { [change.field]: change.value }, expected_status: found.status },
			},
			{ onSuccess: onSaved },
		)
	}

	const close = () => {
		update.reset()
		onCancel()
	}

	return (
		<Dialog open={change !== null} onOpenChange={(open) => !open && close()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{change ? question(change) : ''}</DialogTitle>
					<DialogDescription>
						{isLoading ? (
							<Skeleton className="h-4 w-48" />
						) : found ? (
							<>
								{found.title ?? 'This item'}
								{before ? ` (now ${before})` : ''}
							</>
						) : (
							"Can't find this item. It may have been deleted."
						)}
					</DialogDescription>
				</DialogHeader>
				{update.error ? (
					<p role="alert" className="text-xs text-destructive">
						Could not save: {update.error.message}
					</p>
				) : null}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={close}>
						Cancel
					</Button>
					<Button type="button" onClick={confirm} disabled={!found || update.isPending}>
						{change?.field === 'post_time' ? 'Set time' : 'Move'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
