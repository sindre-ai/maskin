import { cn } from '@/lib/cn'
import { useState } from 'react'
import { useToolHistory } from './mcp-app-provider'

interface ToolHistoryBreadcrumbProps {
	toolName: string
	queryKey?: string
	className?: string
}

export function ToolHistoryBreadcrumb({
	toolName,
	queryKey,
	className,
}: ToolHistoryBreadcrumbProps) {
	const history = useToolHistory()
	const [showLog, setShowLog] = useState(false)

	const entries = history.filter((e) => e.toolName === toolName)

	if (entries.length < 2) return null

	const lastIndex = entries.length - 1

	return (
		<div>
			<div
				className={cn(
					'flex flex-wrap items-center gap-1.5 px-3 py-2 bg-muted/30 border-b border-border text-xs font-mono',
					className,
				)}
			>
				<span className="text-muted-foreground uppercase tracking-wider mr-1">{toolName}</span>

				{entries.map((entry, index) => {
					const isActive = index === lastIndex
					const hasResults = entry.resultCount > 0
					const rawVal = queryKey && entry.input !== null ? entry.input[queryKey] : undefined
					const label = rawVal != null ? String(rawVal) : entry.toolName

					return (
						<span
							key={entry.id}
							className={cn(
								'px-1.5 py-0.5 rounded text-xs font-mono',
								hasResults
									? cn(
											'text-foreground bg-background border border-border',
											isActive && 'ring-1 ring-accent',
										)
									: 'text-muted-foreground line-through opacity-50',
							)}
						>
							{label}
							{' · '}
							<span className={cn(hasResults ? 'text-accent' : 'text-muted-foreground')}>
								{entry.resultCount}
							</span>
						</span>
					)
				})}

				<button
					type="button"
					onClick={() => setShowLog((prev) => !prev)}
					className="ml-auto px-1.5 py-0.5 rounded text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
				>
					{'</>'}
				</button>
			</div>

			{showLog && (
				<div className="bg-background border-b border-border p-2 font-mono text-xs text-muted-foreground">
					{entries.map((entry) => (
						<div key={entry.id}>
							{`tools/call: ${entry.toolName} ${JSON.stringify(entry.input)} → ${entry.resultCount} hit(s)`}
						</div>
					))}
				</div>
			)}
		</div>
	)
}
