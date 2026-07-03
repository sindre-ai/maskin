import { cn } from '@/lib/cn'

export interface DedupKeyOption {
	value: string
	label: string
}

interface ImportDedupPickerProps {
	options: DedupKeyOption[]
	selectedKeys: string[]
	onChange: (keys: string[]) => void
	disabled?: boolean
}

export function ImportDedupPicker({
	options,
	selectedKeys,
	onChange,
	disabled,
}: ImportDedupPickerProps) {
	const toggle = (value: string) => {
		if (disabled) return
		onChange(
			selectedKeys.includes(value)
				? selectedKeys.filter((k) => k !== value)
				: [...selectedKeys, value],
		)
	}

	return (
		<div className="rounded-lg border bg-card p-3 sm:p-4 space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-sm font-medium">Match existing records by:</span>
				{options.map((opt) => {
					const isSelected = selectedKeys.includes(opt.value)
					return (
						<button
							key={opt.value}
							type="button"
							aria-pressed={isSelected}
							aria-label={`Dedup key ${opt.label}`}
							onClick={() => toggle(opt.value)}
							disabled={disabled}
							className={cn(
								'inline-flex min-h-[28px] items-center rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
								isSelected
									? 'border-transparent bg-accent text-accent-foreground hover:bg-accent/80'
									: 'border-border bg-transparent text-foreground hover:bg-muted',
								disabled && 'opacity-50 cursor-not-allowed',
							)}
						>
							{opt.label}
						</button>
					)
				})}
			</div>
			<p className="text-xs text-muted-foreground">
				Rows matching <em>all</em> selected fields update; the rest create.
			</p>
		</div>
	)
}
