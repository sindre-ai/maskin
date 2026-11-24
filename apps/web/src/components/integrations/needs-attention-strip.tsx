import { ProviderLogo } from '@/components/integrations/provider-logo'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useCanWrite } from '@/hooks/use-can-write'
import { PILL_BUTTON } from '@/lib/pill-button'

export interface AttentionItem {
	key: string
	/** The tool's display name. */
	name: string
	/** Site whose icon draws the logo tile. */
	domain?: string
	/** What is wrong, in one line. */
	line: string
	/** The fix: Reconnect or Finish setup. */
	actionLabel: string
	onAction: () => void
	pending?: boolean
}

/**
 * One card above the shelves, one line per tool that is broken and the button that fixes it.
 * Without it a broken tool only shows up inside its own row. Draws nothing when all is well.
 */
export function NeedsAttentionStrip({ items }: { items: AttentionItem[] }) {
	const canWrite = useCanWrite()
	if (items.length === 0) return null
	return (
		<section
			aria-label="Needs attention"
			className="mb-6 space-y-1 rounded-2xl border border-warning/40 bg-card p-[18px]"
		>
			<h2 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
				<span aria-hidden="true" className="size-2 rounded-full bg-warning" />
				Needs attention
			</h2>
			<ul className="divide-y divide-border-subtle">
				{items.map((item) => (
					<li key={item.key} className="flex flex-wrap items-center gap-3 py-3">
						<ProviderLogo name={item.name} domain={item.domain} />
						<p className="min-w-0 flex-1 basis-48 text-[14px] text-foreground">{item.line}</p>
						<ViewerTooltip>
							<Button
								size="sm"
								variant="outline"
								className={PILL_BUTTON}
								disabled={item.pending || !canWrite}
								onClick={item.onAction}
								aria-label={`${item.actionLabel} ${item.name}`}
							>
								{item.pending ? (
									<>
										<Spinner className="mr-1" />
										Connecting…
									</>
								) : (
									item.actionLabel
								)}
							</Button>
						</ViewerTooltip>
					</li>
				))}
			</ul>
		</section>
	)
}
