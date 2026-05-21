import { useActor } from '@/hooks/use-actors'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/file-utils'
import type { PendingComment } from '@/lib/pending-comments-context'
import { File as FileIcon } from 'lucide-react'
import { ActorAvatar } from '../shared/actor-avatar'
import { UploadProgress } from '../shared/upload-progress'

interface PendingCommentRowProps {
	entry: PendingComment
}

/**
 * Optimistic representation of a comment that has been submitted but is still
 * awaiting uploads or the final POST. Renders in the same row layout as a real
 * comment but greyed out, with per-file progress shown inline. Once the real
 * comment arrives via SSE the queue drops this entry and the real row takes
 * over.
 */
export function PendingCommentRow({ entry }: PendingCommentRowProps) {
	const { data: actor } = useActor(entry.actorId ?? '')

	const isFailed = entry.status === 'failed'

	return (
		<div className={cn('group transition-opacity', isFailed ? 'opacity-80' : 'opacity-60')}>
			<div className="flex items-start gap-2 py-1">
				{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
				<div className="flex-1 min-w-0">
					<div className="flex items-baseline gap-1.5">
						<span
							className={cn(
								'text-sm font-medium',
								actor?.type === 'agent' ? 'text-primary' : 'text-foreground',
							)}
						>
							{actor?.name ?? 'You'}
						</span>
						<span className="text-muted-foreground text-xs italic">
							{isFailed ? 'Failed to send' : entry.status === 'posting' ? 'Posting…' : 'Sending…'}
						</span>
					</div>
					{entry.content && (
						<p className="mt-0.5 text-sm text-foreground whitespace-pre-wrap break-words">
							{entry.content}
						</p>
					)}
					{entry.files.length > 0 && (
						<ul className="mt-1.5 space-y-1">
							{entry.files.map((file) => (
								<li
									key={file.tempId}
									className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
								>
									<FileIcon size={14} className="text-muted-foreground shrink-0" />
									<span className="flex-1 truncate">{file.name}</span>
									<span className="text-xs text-muted-foreground font-mono">
										{formatSize(file.sizeBytes)}
									</span>
									<UploadProgress
										progress={file.progress}
										status={file.status}
										error={file.error}
									/>
								</li>
							))}
						</ul>
					)}
					{entry.error && <p className="mt-1 text-xs text-error">{entry.error}</p>}
				</div>
			</div>
		</div>
	)
}
