interface CompactEmptyProps {
	toolName: string
	query?: string
	label?: string
}

export function CompactEmpty({ toolName, query, label = 'no results' }: CompactEmptyProps) {
	return (
		<div className="flex items-center gap-2 py-3 px-4">
			<div className="flex items-center justify-center w-3.5 h-3.5 rounded-sm bg-accent text-accent-foreground text-xs leading-none font-bold shrink-0">
				M
			</div>

			<span className="text-sm font-mono font-semibold text-foreground">{toolName}</span>

			{query && <span className="text-sm text-foreground">&ldquo;{query}&rdquo;</span>}

			<span className="text-sm font-mono text-muted-foreground">· {label}</span>
		</div>
	)
}
