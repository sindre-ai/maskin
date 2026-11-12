import { FileTagEditDialog } from '@/components/files/file-tag-edit-dialog'
import { FilterChip } from '@/components/shared/filter-chip'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { useCanWrite } from '@/hooks/use-can-write'
import { useFileTags } from '@/hooks/use-files'
import type { FileTagMatch } from '@/lib/api'
import { sortTagsAlphabetically } from '@/lib/file-tags'
import { Pencil, Tag } from 'lucide-react'
import { useMemo, useState } from 'react'

const MATCH_OPTIONS: Array<{ value: FileTagMatch; label: string }> = [
	{ value: 'all', label: 'Has all of these' },
	{ value: 'any', label: 'Has any of these' },
]

/**
 * The Files tab's tag filter: a picker over the tags in use (A to Z, file count beside the
 * name), a choice of "has all" or "has any", and a chip per picked tag. Renders nothing while
 * no file in the workspace carries a tag and none is picked.
 */
export function FileTagFilter({
	workspaceId,
	tags,
	match,
	onTagsChange,
	onMatchChange,
}: {
	workspaceId: string
	tags: string[]
	match: FileTagMatch
	onTagsChange: (tags: string[]) => void
	onMatchChange: (match: FileTagMatch) => void
}) {
	const canWrite = useCanWrite()
	const { data: counts } = useFileTags(workspaceId)
	const [pickerOpen, setPickerOpen] = useState(false)
	const [editing, setEditing] = useState<string | null>(null)
	const options = useMemo(() => {
		const known = new Map((counts ?? []).map((c) => [c.tag, c.count]))
		// A picked tag no file carries any more stays listed, so it can still be unpicked.
		for (const tag of tags) if (!known.has(tag)) known.set(tag, 0)
		return sortTagsAlphabetically([...known].map(([tag, count]) => ({ tag, count })))
	}, [counts, tags])

	if (options.length === 0) return null

	const toggle = (tag: string) =>
		onTagsChange(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag])

	// A picked tag that was renamed or merged follows its new name, so the filter keeps matching.
	const followTag = (from: string, to: string) => {
		if (!tags.includes(from)) return
		onTagsChange([...new Set(tags.map((t) => (t === from ? to : t)))])
	}

	return (
		<div className="flex flex-wrap items-center gap-2 pb-3" data-testid="file-tag-filter">
			<ResponsivePopover open={pickerOpen} onOpenChange={setPickerOpen}>
				<ResponsivePopoverTrigger asChild>
					<Button variant="outline" size="sm" className="max-md:h-11" aria-label="Filter by tag">
						<Tag size={14} />
						Tags{tags.length > 0 ? ` (${tags.length})` : ''}
					</Button>
				</ResponsivePopoverTrigger>
				<ResponsivePopoverContent
					align="start"
					accessibleTitle="Filter files by tag"
					className="flex w-72 flex-col gap-3 p-3 max-md:pt-14"
				>
					<RadioGroup
						value={match}
						onValueChange={(value) => onMatchChange(value as FileTagMatch)}
						aria-label="Match"
						className="gap-1"
					>
						{MATCH_OPTIONS.map((option) => (
							<div
								key={option.value}
								className="flex min-h-9 items-center gap-2 px-1 max-md:min-h-11"
							>
								<RadioGroupItem value={option.value} id={`file-tag-match-${option.value}`} />
								<Label htmlFor={`file-tag-match-${option.value}`} className="flex-1 text-sm">
									{option.label}
								</Label>
							</div>
						))}
					</RadioGroup>
					<ul className="flex max-h-64 flex-col overflow-y-auto">
						{options.map(({ tag, count }, index) => (
							<li
								key={tag}
								className="flex min-h-9 items-center gap-2 rounded px-1 hover:bg-muted/50 max-md:min-h-11"
							>
								<Checkbox
									id={`file-tag-${index}`}
									checked={tags.includes(tag)}
									onCheckedChange={() => toggle(tag)}
								/>
								<Label
									htmlFor={`file-tag-${index}`}
									className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm font-normal"
								>
									<span className="min-w-0 flex-1 truncate">{tag}</span>
									<span className="text-xs text-muted-foreground tabular-nums">{count}</span>
								</Label>
								{canWrite && count > 0 && (
									<button
										type="button"
										aria-label={`Edit tag ${tag}`}
										title={`Edit tag ${tag}`}
										onClick={() => {
											// The edit dialog replaces the picker rather than stacking on it.
											setPickerOpen(false)
											setEditing(tag)
										}}
										className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground max-md:p-4"
									>
										<Pencil size={12} />
									</button>
								)}
							</li>
						))}
					</ul>
				</ResponsivePopoverContent>
			</ResponsivePopover>
			{tags.map((tag) => (
				<FilterChip key={tag} label="Tag" value={tag} preserveCase onRemove={() => toggle(tag)} />
			))}
			<FileTagEditDialog
				workspaceId={workspaceId}
				tag={editing}
				otherTags={options.filter((o) => o.tag !== editing && o.count > 0).map((o) => o.tag)}
				onClose={() => setEditing(null)}
				onChanged={followTag}
			/>
		</div>
	)
}
