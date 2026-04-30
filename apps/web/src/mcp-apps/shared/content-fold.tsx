import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { useState } from 'react'
import type { ReactNode } from 'react'

interface ContentFoldProps {
	children: ReactNode
	maxLines?: number
	lineCount?: number
	byteCount?: string
	onOpen?: () => void
	className?: string
}

export function ContentFold({
	children,
	maxLines = 6,
	lineCount,
	byteCount,
	onOpen,
	className,
}: ContentFoldProps) {
	const [expanded, setExpanded] = useState(false)

	const collapsedMaxH = `${maxLines * 1.5}rem`
	const fitsWithoutFold = lineCount != null && lineCount <= maxLines

	return (
		<div className={cn('flex flex-col gap-1', className)}>
			<div
				className="relative overflow-hidden transition-all duration-200"
				style={expanded || fitsWithoutFold ? undefined : { maxHeight: collapsedMaxH }}
			>
				{children}

				{!expanded && !fitsWithoutFold && (
					<div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-b from-transparent to-background pointer-events-none" />
				)}
			</div>

			{!fitsWithoutFold && (
				<div className="flex items-center gap-2">
					{expanded ? (
						<Button
							variant="ghost"
							size="sm"
							className="h-auto px-0 py-0 text-xs text-accent hover:text-accent hover:bg-transparent"
							onClick={() => setExpanded(false)}
						>
							↑ Collapse
						</Button>
					) : (
						<>
							<Button
								variant="ghost"
								size="sm"
								className="h-auto px-0 py-0 text-xs text-accent hover:text-accent hover:bg-transparent"
								onClick={() => setExpanded(true)}
							>
								↓ Read more{lineCount != null ? ` (${lineCount} lines)` : ''}
							</Button>

							{byteCount && <span className="text-xs text-muted-foreground">{byteCount}</span>}

							{onOpen && (
								<Button
									variant="outline"
									size="sm"
									className="h-auto px-2 py-0.5 text-xs"
									onClick={onOpen}
								>
									Open ↗
								</Button>
							)}
						</>
					)}
				</div>
			)}
		</div>
	)
}
