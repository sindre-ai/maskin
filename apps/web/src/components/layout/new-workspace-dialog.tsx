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
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

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
						<FormError
							error={
								createMutation.isError ? "Couldn't create the workspace — try again" : undefined
							}
						/>
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
