import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCreateWorkspace } from '@/hooks/use-workspaces'
import { ApiError } from '@/lib/api'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

/**
 * The cap rejection is a plan limit, not a fault: a trial actor may own exactly
 * one workspace (OWNERSHIP_CAPS in @maskin/shared), so "try again" is the one
 * thing that cannot work. Surface the server's own sentence for it and point at
 * the plan; keep the generic retry line for everything else.
 */
export function createErrorMessage(error: unknown): string | undefined {
	if (!error) return undefined
	if (error instanceof ApiError && error.code === 'OWNERSHIP_CAP_EXCEEDED') {
		return `${error.message} Upgrade your plan in Settings → Billing to own more.`
	}
	return "Couldn't create the workspace — try again"
}

/**
 * "New workspace" from the sidebar's workspace menu (mockup line 62).
 *
 * A name is all the API needs — the create route seeds the default agent crew
 * and the owner membership itself — so the dialog asks for exactly that and
 * then drops the caller into the new workspace.
 */
export function NewWorkspaceDialog({
	open,
	onOpenChange,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const [name, setName] = useState('')
	const navigate = useNavigate()
	const createMutation = useCreateWorkspace()
	const trimmed = name.trim()
	const error = createMutation.error

	function handleOpenChange(next: boolean) {
		if (!next) {
			setName('')
			createMutation.reset()
		}
		onOpenChange(next)
	}

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		if (!trimmed || createMutation.isPending) return
		createMutation.mutate(
			{ name: trimmed },
			{
				onSuccess: (workspace) => {
					handleOpenChange(false)
					navigate({ to: '/$workspaceId', params: { workspaceId: workspace.id } })
				},
			},
		)
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>New workspace</DialogTitle>
						<DialogDescription>
							Name it and invite people. Your default agent crew comes with it.
						</DialogDescription>
					</DialogHeader>
					<div className="mt-4 grid gap-2">
						<Label htmlFor="new-workspace-name">Name</Label>
						<Input
							id="new-workspace-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Nordic Labs"
							autoFocus
						/>
						<FormError error={createErrorMessage(error)} />
					</div>
					<DialogFooter className="mt-5">
						<Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={!trimmed || createMutation.isPending}>
							{createMutation.isPending ? 'Creating…' : 'Create workspace'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
