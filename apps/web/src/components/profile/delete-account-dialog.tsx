import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { trackEvent } from '@/lib/analytics'
import { api } from '@/lib/api'
import { clearAuth } from '@/lib/auth'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

const DESTRUCTION_ITEMS = [
	'Your account, profile, and avatar',
	'Your API keys and active sessions',
	'Workspaces you solely own — members lose access',
	'Comments, decisions, and content you authored',
] as const

export function DeleteAccountDialog({
	open,
	onOpenChange,
	actorId,
	workspaceId,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	actorId: string
	workspaceId: string
}) {
	const navigate = useNavigate()
	const mutation = useMutation({
		mutationFn: () => api.actors.delete(actorId, workspaceId),
		onSuccess: () => {
			trackEvent('profile.account_deleted')
			clearAuth()
			toast.success('Your account has been deleted')
			navigate({ to: '/login' })
		},
		onError: (err) => {
			toast.error(err instanceof Error ? err.message : 'Could not delete account')
		},
	})

	function handleOpenChange(value: boolean) {
		if (mutation.isPending) return
		if (!value) mutation.reset()
		onOpenChange(value)
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete account</DialogTitle>
					<DialogDescription>
						This permanently deletes the following. It can't be undone.
					</DialogDescription>
				</DialogHeader>

				<ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
					{DESTRUCTION_ITEMS.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => handleOpenChange(false)}
						disabled={mutation.isPending}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={() => mutation.mutate()}
						disabled={mutation.isPending}
					>
						{mutation.isPending ? 'Deleting…' : 'Delete account'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
