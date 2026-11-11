import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useChangeFileTag } from '@/hooks/use-files'
import { MAX_TAG_LENGTH, normalizeFileTag } from '@/lib/file-tags'
import { useState } from 'react'
import { toast } from 'sonner'

const filesWord = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`

/**
 * Changes one tag on every file in the workspace: rename it, or merge it into another tag.
 * `onChanged` gets the old and new name so a caller holding the old one (a picked filter) can
 * follow it.
 */
export function FileTagEditDialog({
	workspaceId,
	tag,
	otherTags,
	onClose,
	onChanged,
}: {
	workspaceId: string
	tag: string | null
	otherTags: string[]
	onClose: () => void
	onChanged: (from: string, to: string) => void
}) {
	const change = useChangeFileTag(workspaceId)
	const [newName, setNewName] = useState('')
	const [mergeInto, setMergeInto] = useState('')
	const [error, setError] = useState<string | null>(null)
	const normalized = normalizeFileTag(newName)

	const close = () => {
		setNewName('')
		setMergeInto('')
		setError(null)
		onClose()
	}

	const run = (
		input:
			| { kind: 'rename'; from: string; to: string }
			| { kind: 'merge'; from: string; into: string },
	) => {
		setError(null)
		change.mutate(input, {
			onSuccess: (result) => {
				toast.success(
					input.kind === 'rename'
						? `Renamed to "${result.to}" on ${filesWord(result.files_changed)}.`
						: `Merged into "${result.to}" on ${filesWord(result.files_changed)}.`,
				)
				onChanged(result.from, result.to)
				close()
			},
			onError: (err) => setError(err instanceof Error ? err.message : 'Could not change the tag'),
		})
	}

	return (
		<ResponsiveDialog open={tag !== null} onOpenChange={(open) => !open && close()}>
			<ResponsiveDialogContent>
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>Edit tag "{tag}"</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						Changes the tag on every file in the workspace.
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>
				{tag !== null && (
					<div className="flex flex-col gap-5 px-4 pb-4 md:px-0 md:pb-0">
						<form
							className="flex flex-col gap-2"
							onSubmit={(event) => {
								event.preventDefault()
								if (normalized) run({ kind: 'rename', from: tag, to: normalized })
							}}
						>
							<Label htmlFor="file-tag-new-name">New name</Label>
							<div className="flex gap-2">
								<Input
									id="file-tag-new-name"
									value={newName}
									onChange={(event) => setNewName(event.target.value)}
									maxLength={MAX_TAG_LENGTH}
									placeholder="New name"
								/>
								<Button
									type="submit"
									size="sm"
									className="max-md:h-11"
									disabled={!normalized || normalized === tag || change.isPending}
								>
									Rename
								</Button>
							</div>
						</form>
						{otherTags.length > 0 && (
							<div className="flex flex-col gap-2">
								<Label htmlFor="file-tag-merge-into">Merge into</Label>
								<div className="flex gap-2">
									<Select value={mergeInto} onValueChange={setMergeInto}>
										<SelectTrigger id="file-tag-merge-into" className="flex-1 max-md:h-11">
											<SelectValue placeholder="Pick a tag" />
										</SelectTrigger>
										<SelectContent>
											{otherTags.map((other) => (
												<SelectItem key={other} value={other}>
													{other}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Button
										size="sm"
										className="max-md:h-11"
										disabled={!mergeInto || change.isPending}
										onClick={() => run({ kind: 'merge', from: tag, into: mergeInto })}
									>
										Merge
									</Button>
								</div>
							</div>
						)}
						<FormError error={error ?? undefined} />
					</div>
				)}
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}
