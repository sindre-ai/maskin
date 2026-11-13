import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'

// The longest label a tag may carry; the backend trims to the same bound.
const TAG_MAX_LENGTH = 40

/**
 * The flow's tags (`metadata.tags`) in the header chip row beside the status pill and driver: removable chips and a
 * "+ Tag" control that turns into an inline field. The first tag is the team the
 * Flows list groups under. Read-only viewers see the chips without controls, and
 * nothing renders for a flow with no tags they could add.
 */
export function LoopTags({
	tags,
	canWrite,
	onChange,
	suggestions = [],
}: {
	tags: string[]
	canWrite: boolean
	onChange: (next: string[]) => void
	/** Tags already used elsewhere in the workspace, offered while typing. */
	suggestions?: readonly string[]
}) {
	const [adding, setAdding] = useState(false)
	const [draft, setDraft] = useState('')
	const [active, setActive] = useState(-1)

	// The field unmounts on Enter/Escape and then blurs; this keeps the one
	// decision (commit or cancel) from running a second time with a stale draft.
	const settledRef = useRef(false)

	if (tags.length === 0 && !canWrite) return null

	const query = draft.trim().toLowerCase()
	const matches = adding
		? suggestions
				.filter(
					(t) =>
						!tags.some((x) => x.toLowerCase() === t.toLowerCase()) &&
						t.toLowerCase().includes(query),
				)
				.slice(0, 8)
		: []

	function cancel() {
		if (settledRef.current) return
		settledRef.current = true
		setDraft('')
		setAdding(false)
	}

	function commit(chosen?: string) {
		if (settledRef.current) return
		settledRef.current = true
		const value = (chosen ?? draft).trim().slice(0, TAG_MAX_LENGTH)
		setDraft('')
		setAdding(false)
		if (!value || tags.some((t) => t.toLowerCase() === value.toLowerCase())) return
		onChange([...tags, value])
	}

	return (
		<section aria-label="Tags" className="contents">
			{tags.map((tag) => (
				<Badge
					key={tag}
					variant="secondary"
					className="h-9 gap-1.5 px-3.5 text-[13.5px] font-medium"
				>
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
					<div className="relative">
						<Input
							autoFocus
							value={draft}
							maxLength={TAG_MAX_LENGTH}
							onChange={(e) => {
								setDraft(e.target.value)
								setActive(-1)
							}}
							onBlur={() => commit()}
							onKeyDown={(e) => {
								if (e.key === 'ArrowDown' && matches.length > 0) {
									e.preventDefault()
									setActive((i) => (i + 1) % matches.length)
								}
								if (e.key === 'ArrowUp' && matches.length > 0) {
									e.preventDefault()
									setActive((i) => (i <= 0 ? matches.length - 1 : i - 1))
								}
								if (e.key === 'Enter') {
									e.preventDefault()
									commit(matches[active])
								}
								if (e.key === 'Escape') cancel()
							}}
							placeholder="Tag name"
							aria-label="New tag"
							className="h-9 w-36 rounded-full"
						/>
						{matches.length > 0 && (
							<div
								aria-label="Existing tags"
								className="absolute left-0 top-full z-30 mt-1 max-h-56 min-w-full overflow-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md"
							>
								{matches.map((t, i) => (
									<button
										key={t}
										type="button"
										tabIndex={-1}
										aria-current={i === active ? 'true' : undefined}
										// mousedown, not click: the field would blur and commit the half-typed text first.
										onMouseDown={(e) => {
											e.preventDefault()
											commit(t)
										}}
										className={`block w-full whitespace-nowrap rounded-lg px-3 py-1.5 text-left text-[13.5px] ${i === active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`}
									>
										{t}
									</button>
								))}
							</div>
						)}
					</div>
				) : (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							settledRef.current = false
							setAdding(true)
						}}
						className="h-9 rounded-full border-dashed text-[13.5px] text-muted-foreground"
					>
						<Plus size={13} aria-hidden="true" />
						Tag
					</Button>
				))}
		</section>
	)
}
