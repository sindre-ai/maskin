import { MarkdownContent } from '@/components/shared/markdown-content'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { LoopSummary } from '@/lib/api'
import { useChat } from '@/lib/chat-context'
import { cn } from '@/lib/cn'
import { MessageCircle, MoreHorizontal, Pause, Play } from 'lucide-react'
import { LOOP_PILL_STYLES } from './loop-pill'

export function LoopHeader({
	loop,
	onTogglePause,
	isTogglingPause,
}: {
	loop: LoopSummary
	onTogglePause: () => void
	isTogglingPause: boolean
}) {
	const { openWithContext } = useChat()
	const pill = LOOP_PILL_STYLES[loop.pill]
	const isPaused = loop.status === 'paused'

	return (
		<div>
			<div className="flex items-start justify-between gap-3">
				<h1 className="text-2xl font-semibold tracking-tight text-foreground">
					{loop.name ?? 'Untitled loop'}
				</h1>
				<div className="flex items-center gap-2 shrink-0">
					<span
						data-testid="loop-pill"
						className={cn('inline-flex items-center gap-1.5 text-xs font-medium', pill.text)}
					>
						<span className={cn('h-1.5 w-1.5 rounded-full', pill.dot)} />
						{pill.label}
					</span>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 text-muted-foreground"
								aria-label="More"
							>
								<MoreHorizontal size={15} />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={onTogglePause} disabled={isTogglingPause}>
								{isPaused ? (
									<>
										<Play size={14} /> Resume loop
									</>
								) : (
									<>
										<Pause size={14} /> Pause loop
									</>
								)}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{loop.guarantee && (
				<div className="mt-3">
					<MarkdownContent content={loop.guarantee} className="text-sm text-muted-foreground" />
				</div>
			)}

			<div className="mt-3">
				<Button
					variant="outline"
					size="sm"
					className="gap-1.5"
					onClick={() =>
						openWithContext([{ kind: 'object', id: loop.id, title: loop.name, type: 'loop' }])
					}
				>
					<MessageCircle size={13} />
					Edit this loop
				</Button>
			</div>
		</div>
	)
}
