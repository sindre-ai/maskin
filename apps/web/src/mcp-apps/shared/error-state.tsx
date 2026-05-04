import { Button } from '@/components/ui/button'
import { useState } from 'react'

interface ErrorStateProps {
	toolName?: string
	errorCode?: string | number
	message?: string
	details?: string
	onRetry?: () => void
	onReconnect?: () => void
}

export function ErrorState({
	toolName,
	errorCode,
	message = 'Something went wrong while running this tool.',
	details,
	onRetry,
	onReconnect,
}: ErrorStateProps) {
	const [showDetails, setShowDetails] = useState(false)

	return (
		<div className="rounded-md border border-destructive/40 overflow-hidden">
			<div className="flex items-center gap-2 px-3 py-2 bg-destructive/5">
				<div className="flex items-center justify-center w-5 h-5 rounded bg-destructive text-destructive-foreground text-xs font-bold shrink-0">
					!
				</div>
				<span className="font-semibold text-sm text-foreground">maskin</span>
				{toolName && <span className="text-sm text-muted-foreground">{toolName}</span>}
				{errorCode != null && (
					<span className="ml-auto text-xs font-mono text-destructive">{errorCode}</span>
				)}
			</div>

			<div className="px-3 py-3 flex flex-col gap-3">
				<p className="text-sm text-foreground">{message}</p>

				{showDetails && details && (
					<pre className="rounded-md bg-muted p-2 text-xs font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap break-all">
						{details}
					</pre>
				)}

				{(onReconnect || onRetry || details) && (
					<div className="flex items-center gap-2 flex-wrap">
						{onReconnect && (
							<Button size="sm" onClick={onReconnect}>
								Reconnect
							</Button>
						)}
						{onRetry && (
							<Button size="sm" variant="outline" onClick={onRetry}>
								Retry
							</Button>
						)}
						{details && (
							<Button size="sm" variant="ghost" onClick={() => setShowDetails((prev) => !prev)}>
								{showDetails ? 'Hide details' : 'Show details'}
							</Button>
						)}
					</div>
				)}
			</div>
		</div>
	)
}
