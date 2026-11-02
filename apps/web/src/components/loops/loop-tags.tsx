import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'

// The longest label a tag may carry; the backend trims to the same bound.
const TAG_MAX_LENGTH = 40

/**
 * The flow's tags (`metadata.tags`) on the Overview tab: removable chips and a
 * "+ Tag" control that turns into an inline field. The first tag is the team the
 * Flows list groups under. Read-only viewers see the chips without controls, and
 * nothing renders for a flow with no tags they could add.
 */
export function LoopTags({
	tags,
	canWrite,
	onChange,
}: {
	tags: string[]
	canWrite: boolean
	onChange: (next: string[]) => void
}) {
	const [adding, setAdding] = useState(false)
	const [draft, setDraft] = useState('')

	if (tags.length === 0 && !canWrite) return null

	function commit() {
		const value = draft.trim().slice(0, TAG_MAX_LENGTH)
		setDraft('')
		setAdding(false)
		if (!value || tags.some((t) => t.toLowerCase() === value.toLowerCase())) return
		onChange([...tags, value])
	}

	return (
		<section aria-label="Tags" className="flex flex-wrap items-center gap-2">
			<span className="mr-1 text-[13px] font-semibold text-muted-foreground">Tags</span>
			{tags.map((tag) => (
				<Badge key={tag} variant="secondary" className="h-8 gap-1.5 px-3.5 text-[13px] font-medium">
					{tag}
					{canWrite && (
						<button
							type="button"
							aria-label={`Remove tag ${tag}`}
							onClick={() => onChange(tags.filter((t) => t !== tag))}
							className="-mr-1 grid size-4 place-items-center rounded-full text-muted-foreground hover:text-foreground"
						>
							<X size={12} aria-hidden="true" />
						</button>
					)}
				</Badge>
			))}
			{canWrite &&
				(adding ? (
					<Input
						autoFocus
						value={draft}
						maxLength={TAG_MAX_LENGTH}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={commit}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault()
								commit()
							}
							if (e.key === 'Escape') {
								setDraft('')
								setAdding(false)
							}
						}}
						placeholder="Tag name"
						aria-label="New tag"
						className="h-8 w-36 rounded-full"
					/>
				) : (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setAdding(true)}
						className="h-8 rounded-full border-dashed text-[13px] text-muted-foreground"
					>
						<Plus size={13} aria-hidden="true" />
						Tag
					</Button>
				))}
		</section>
	)
}
