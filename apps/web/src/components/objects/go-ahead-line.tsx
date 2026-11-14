import { Button } from '@/components/ui/button'
import type { GoAhead } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * `<GoAheadLine>` — one line next to the next-step block: "Go-ahead from [name], [date]. Take
 * back". It is a person's yes to keep going on this job without asking for each step, stored on
 * the job. Renders NOTHING when the job has none. Any workspace writer can take it back.
 */
export function GoAheadLine({
	goAhead,
	objectId,
	workspaceId,
}: {
	goAhead: GoAhead | null | undefined
	objectId: string
	workspaceId: string
}) {
	const queryClient = useQueryClient()
	const takeBack = useMutation({
		mutationFn: () => api.objects.takeBackGoAhead(objectId, workspaceId),
		onSuccess: () => {
			toast.success('Go-ahead taken back')
		},
		onError: () => {
			toast.error('Could not take the go-ahead back')
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(objectId) })
		},
	})
	if (!goAhead) return null

	return (
		<p
			data-go-ahead
			className="mt-2 flex flex-wrap items-center gap-x-1.5 text-[11.5px] leading-[1.45] text-muted-foreground"
		>
			<span>
				Go-ahead from <span className="font-medium text-foreground">{goAhead.granted_by_name}</span>
				, <time dateTime={goAhead.granted_at}>{formatDate(goAhead.granted_at)}</time>.
			</span>
			<Button
				type="button"
				variant="link"
				size="xs"
				className="h-auto p-0 text-[11.5px]"
				disabled={takeBack.isPending}
				onClick={() => takeBack.mutate()}
			>
				Take back
			</Button>
		</p>
	)
}
