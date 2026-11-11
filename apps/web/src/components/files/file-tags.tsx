import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { useCanWrite } from '@/hooks/use-can-write'
import { useFileTags, useUpdateFile } from '@/hooks/use-files'
import type { FileDetail } from '@/lib/api'
import {
	MAX_TAGS_PER_FILE,
	MAX_TAG_LENGTH,
	normalizeFileTag,
	sortTagsAlphabetically,
} from '@/lib/file-tags'
import { Tag, X } from 'lucide-react'
import { useMemo, useState } from 'react'

/**
 * The file's tags as a band under the top bar. A file with no tags renders nothing, so it looks
 * the same as before; tags are added from `FileTagEditorButton`.
 */
export function FileTagChips({ file }: { file: FileDetail }) {
	const canWrite = useCanWrite()
	const update = useUpdateFile(file.workspaceId)
	if (file.tags.length === 0) return null
	return (
		<ul
			className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2"
			aria-label="Tags"
			data-testid="file-tag-chips"
		>
			{sortTagsAlphabetically(file.tags).map((tag) => (
				<li
					key={tag}
					className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground"
				>
					<span>{tag}</span>
					{canWrite && (
						<button
							type="button"
							aria-label={`Remove tag ${tag}`}
							title={`Remove tag ${tag}`}
							disabled={update.isPending}
							onClick={() =>
								update.mutate({ id: file.id, data: { tags: file.tags.filter((t) => t !== tag) } })
							}
							className="-mr-1 rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground max-md:p-1.5"
						>
							<X size={12} />
						</button>
					)}
				</li>
			))}
		</ul>
	)
}

/**
 * Top bar button that adds tags. Existing tags in the workspace are offered A to Z with their file
 * counts, so a person picks one instead of typing a near copy; typing a new one also works.
 */
export function FileTagEditorButton({ file }: { file: FileDetail }) {
	const canWrite = useCanWrite()
	const { data: counts } = useFileTags(file.workspaceId)
	const update = useUpdateFile(file.workspaceId)
	const [text, setText] = useState('')
	const normalized = normalizeFileTag(text)
	const atLimit = file.tags.length >= MAX_TAGS_PER_FILE

	const suggestions = useMemo(() => {
		const needle = text.trim().toLowerCase()
		return sortTagsAlphabetically(
			(counts ?? []).filter((c) => !file.tags.includes(c.tag) && c.tag.includes(needle)),
		)
	}, [counts, file.tags, text])

	const add = (tag: string) => {
		if (file.tags.includes(tag) || atLimit) return
		update.mutate({ id: file.id, data: { tags: [...file.tags, tag] } })
		setText('')
	}

	return (
		<ResponsivePopover>
			<ResponsivePopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="max-md:h-11"
					disabled={!canWrite}
					aria-label="Add tag"
				>
					<Tag size={14} />
					<span className="hidden lg:inline">Tags</span>
				</Button>
			</ResponsivePopoverTrigger>
			<ResponsivePopoverContent
				align="end"
				accessibleTitle="Add a tag"
				className="flex w-72 flex-col gap-2 p-3 max-md:pt-14"
			>
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault()
						if (normalized) add(normalized)
					}}
				>
					<Input
						value={text}
						onChange={(event) => setText(event.target.value)}
						placeholder="Add a tag"
						aria-label="Tag name"
						maxLength={MAX_TAG_LENGTH}
						disabled={atLimit}
					/>
					<Button type="submit" size="sm" className="max-md:h-11" disabled={!normalized || atLimit}>
						Add
					</Button>
				</form>
				{atLimit && (
					<p className="text-xs text-muted-foreground">
						A file can have {MAX_TAGS_PER_FILE} tags at most.
					</p>
				)}
				{suggestions.length > 0 && (
					<ul className="flex max-h-56 flex-col overflow-y-auto" aria-label="Existing tags">
						{suggestions.map(({ tag, count }) => (
							<li key={tag}>
								<button
									type="button"
									disabled={atLimit}
									onClick={() => add(tag)}
									className="flex min-h-9 w-full items-center gap-2 rounded px-1 text-left text-sm hover:bg-muted/50 max-md:min-h-11"
								>
									<span className="min-w-0 flex-1 truncate">{tag}</span>
									<span className="text-xs text-muted-foreground tabular-nums">{count}</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)
}
