import { useSessionLogs } from '@/hooks/use-sessions'
import type { SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDurationBetween } from '@/lib/format-duration'
import { CheckCircle2, Clock, MinusCircle, Terminal, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { RelativeTime } from '../shared/relative-time'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'
import { Spinner } from '../ui/spinner'

interface SessionDetailPanelProps {
	session: SessionResponse | null
	workspaceId: string
	open: boolean
	onOpenChange: (open: boolean) => void
}

function SessionStatusBadge({ status }: { status: string }) {
	const config: Record<string, { icon: React.ElementType; label: string; className: string }> = {
		completed: { icon: CheckCircle2, label: 'Completed', className: 'text-success' },
		failed: { icon: XCircle, label: 'Failed', className: 'text-error' },
		timeout: { icon: Clock, label: 'Timed out', className: 'text-error' },
		running: { icon: Spinner, label: 'Running', className: 'text-accent' },
		starting: { icon: Spinner, label: 'Starting', className: 'text-accent' },
		paused: { icon: Clock, label: 'Paused', className: 'text-warning' },
		snapshotting: { icon: Clock, label: 'Snapshotting', className: 'text-warning' },
	}

	const {
		icon: Icon,
		label,
		className,
	} = config[status] ?? {
		icon: MinusCircle,
		label: status,
		className: 'text-muted-foreground',
	}

	return (
		<span className={cn('flex items-center gap-1.5 text-sm font-medium', className)}>
			<Icon size={14} />
			{label}
		</span>
	)
}

type LogFilter = 'all' | 'stdout' | 'stderr' | 'system'

export function SessionDetailPanel({
	session,
	workspaceId,
	open,
	onOpenChange,
}: SessionDetailPanelProps) {
	const { data: logs, isLoading: logsLoading } = useSessionLogs(
		session?.id ?? null,
		workspaceId,
		open,
	)
	const [logFilter, setLogFilter] = useState<LogFilter>('all')

	const filteredLogs = useMemo(() => {
		if (!logs) return []
		if (logFilter === 'all') return logs
		return logs.filter((l) => l.stream === logFilter)
	}, [logs, logFilter])

	const duration = session ? formatDurationBetween(session.startedAt, session.completedAt) : null
	const result = session?.result as Record<string, unknown> | null
	const errorMessage = typeof result?.error === 'string' ? result.error : undefined
	const exitCode = typeof result?.exit_code === 'number' ? result.exit_code : undefined

	const logCounts = useMemo(() => {
		if (!logs) return { stdout: 0, stderr: 0, system: 0 }
		return logs.reduce(
			(acc, l) => {
				if (l.stream === 'stdout') acc.stdout++
				else if (l.stream === 'stderr') acc.stderr++
				else if (l.stream === 'system') acc.system++
				return acc
			},
			{ stdout: 0, stderr: 0, system: 0 },
		)
	}, [logs])

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="sm:max-w-xl w-full overflow-y-auto">
				{session && (
					<>
						<SheetHeader className="pr-6">
							<SheetTitle className="text-base font-semibold">
								{session.actionPrompt || 'Untitled session'}
							</SheetTitle>
							<SheetDescription className="sr-only">Session details</SheetDescription>
						</SheetHeader>

						{/* Metadata */}
						<div className="mt-4 space-y-3">
							<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
								<SessionStatusBadge status={session.status} />
								{duration && (
									<span className="text-muted-foreground flex items-center gap-1">
										<Clock size={13} />
										{duration}
									</span>
								)}
								{session.startedAt && (
									<RelativeTime
										date={session.startedAt}
										className="text-muted-foreground text-sm"
									/>
								)}
							</div>

							{/* Exit code / error */}
							{(errorMessage || (exitCode !== undefined && exitCode !== 0)) && (
								<div className="rounded-md bg-error/10 border border-error/20 px-3 py-2">
									<p className="text-sm text-error font-medium">
										{errorMessage ?? `Process exited with code ${exitCode}`}
									</p>
								</div>
							)}
						</div>

						{/* Logs */}
						<div className="mt-6">
							<div className="flex items-center justify-between mb-2">
								<h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
									<Terminal size={13} />
									Logs
								</h4>
								<div className="flex items-center gap-1">
									{(['all', 'stdout', 'stderr', 'system'] as const).map((filter) => {
										const count =
											filter === 'all'
												? (logs?.length ?? 0)
												: logCounts[filter as keyof typeof logCounts]
										return (
											<button
												key={filter}
												type="button"
												className={cn(
													'text-[11px] px-1.5 py-0.5 rounded transition-colors cursor-pointer',
													logFilter === filter
														? 'bg-accent text-accent-foreground'
														: 'text-muted-foreground hover:text-foreground',
												)}
												onClick={() => setLogFilter(filter)}
											>
												{filter}
												{count > 0 && <span className="ml-0.5 opacity-60">({count})</span>}
											</button>
										)
									})}
								</div>
							</div>

							{logsLoading ? (
								<div className="flex items-center justify-center py-8">
									<Spinner />
								</div>
							) : filteredLogs.length > 0 ? (
								<div className="rounded-md border border-border bg-secondary/30 overflow-hidden">
									<div className="max-h-[60vh] overflow-y-auto">
										<pre className="text-xs font-mono p-3 whitespace-pre-wrap break-words">
											{filteredLogs.map((log) => (
												<div
													key={log.id}
													className={cn(
														'py-0.5',
														log.stream === 'stderr' && 'text-error',
														log.stream === 'system' && 'text-muted-foreground italic',
													)}
												>
													{log.content}
												</div>
											))}
										</pre>
									</div>
								</div>
							) : (
								<p className="text-sm text-muted-foreground py-4 text-center">No logs available</p>
							)}
						</div>

						{/* Result */}
						{result && Object.keys(result).length > 0 && (
							<div className="mt-6">
								<h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
									Result
								</h4>
								<pre className="text-xs font-mono rounded-md border border-border bg-secondary/30 p-3 whitespace-pre-wrap break-words">
									{JSON.stringify(result, null, 2)}
								</pre>
							</div>
						)}

						{/* Session ID */}
						<div className="mt-6 pt-4 border-t border-border">
							<p className="text-[11px] text-muted-foreground font-mono">Session: {session.id}</p>
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	)
}
