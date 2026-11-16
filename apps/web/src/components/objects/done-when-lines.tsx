import { useCanWrite } from '@/hooks/use-can-write'
import type { DoneWhen, DoneWhenBlock, DoneWhenChecker, DoneWhenState } from '@/lib/api'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

/** The tag a line carries: who checks it. A line with no reading behind it is "You". */
export function checkerTag(checkedBy: DoneWhenChecker): string {
	if (checkedBy === 'code') return 'Code'
	if (checkedBy === 'checker') return 'Checker'
	return 'You'
}

const STATE_LABEL: Record<DoneWhenState, string> = {
	true: 'True',
	false: 'False',
	cannot_tell: 'Cannot tell',
	not_checked: 'Not checked',
}

function Tags({ checkedBy, needsYes }: { checkedBy: DoneWhenChecker; needsYes: boolean }) {
	return (
		<span className="flex shrink-0 items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
			<span data-done-when-tag>{checkerTag(checkedBy)}</span>
			{needsYes && <span className="text-warning">Needs your yes</span>}
		</span>
	)
}

/**
 * `<DoneWhenCardLines>` — the done-when list an agent proposes, drawn on its decision card: the
 * questions about the goal first, all at once, then the lines each tagged Code, Checker or You,
 * and "Needs your yes" where the line sends, spends or deletes. To change a line, reply on the
 * card; the agent redrafts from the reply.
 */
export function DoneWhenCardLines({ block }: { block: DoneWhenBlock }) {
	return (
		<div data-done-when-card className="flex flex-col gap-3">
			{block.questions && block.questions.length > 0 && (
				<ul className="flex flex-col gap-1.5 text-[14px] font-semibold leading-[1.45] text-foreground">
					{block.questions.map((question) => (
						<li key={question}>{question}</li>
					))}
				</ul>
			)}
			<div className="flex flex-col gap-1">
				<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
					Done when
				</p>
				<ol className="flex flex-col gap-1.5">
					{block.lines.map((line, index) => (
						<li
							key={line.text}
							className="flex items-start justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2 text-[13.5px] leading-[1.45] text-foreground"
						>
							<span className="min-w-0">
								<span className="mr-1.5 tabular-nums text-muted-foreground">{index + 1}.</span>
								{line.text}
							</span>
							<Tags checkedBy={line.checked_by} needsYes={line.needs_yes ?? false} />
						</li>
					))}
				</ol>
			</div>
		</div>
	)
}

/**
 * `<DoneWhenProgress>` — on the job's Overview: "3 of 6 lines true", then each line with its
 * state and who checks it. Read from the stored list, no agent involved. A person can tick a line
 * of an approved list; until the outcome check lands that is the only way a line becomes true.
 * Renders NOTHING when the job has no list.
 */
export function DoneWhenProgress({
	doneWhen,
	objectId,
	workspaceId,
}: {
	doneWhen: DoneWhen | null | undefined
	objectId: string
	workspaceId: string
}) {
	const queryClient = useQueryClient()
	const canWrite = useCanWrite()
	const setLine = useMutation({
		mutationFn: (input: { lineId: string; state: DoneWhenState }) =>
			api.objects.setDoneWhenLine(objectId, input.lineId, input.state, workspaceId),
		onError: () => {
			toast.error('Could not update the line')
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(objectId) })
		},
	})
	if (!doneWhen) return null
	const approved = doneWhen.status === 'approved'

	return (
		<section data-done-when className="mt-3 flex flex-col gap-1.5">
			<p className="text-[12.5px] font-medium text-foreground">
				{approved
					? `${doneWhen.true_count} of ${doneWhen.total} lines true`
					: `Waiting for your approval: ${doneWhen.total} lines`}
			</p>
			<ul className="flex flex-col gap-1">
				{doneWhen.lines.map((line) => (
					<li
						key={line.id}
						className="flex items-start justify-between gap-3 text-[12.5px] leading-[1.45]"
					>
						<div className="flex min-w-0 items-start gap-2">
							{approved && (
								<input
									type="checkbox"
									aria-label={line.text}
									className="mt-[3px]"
									checked={line.state === 'true'}
									disabled={!canWrite || setLine.isPending}
									onChange={(event) =>
										setLine.mutate({
											lineId: line.id,
											state: event.target.checked ? 'true' : 'not_checked',
										})
									}
								/>
							)}
							<span
								className={cn(
									'min-w-0',
									line.state === 'true' ? 'text-muted-foreground line-through' : 'text-foreground',
								)}
							>
								{line.text}
							</span>
						</div>
						<span className="flex shrink-0 items-center gap-2">
							{approved && line.state !== 'true' && line.state !== 'not_checked' && (
								<span className="text-[11px] text-muted-foreground">{STATE_LABEL[line.state]}</span>
							)}
							<Tags checkedBy={line.checked_by} needsYes={line.needs_yes} />
						</span>
					</li>
				))}
			</ul>
		</section>
	)
}
