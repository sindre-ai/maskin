import { cn } from '@/lib/cn'

/** Provider-coloured tag for the MCP tool behind an activity row. Compact form
 *  ("google_drive") for card lines, verbose ("google_drive.search_files") for
 *  activity feeds. Amber 800 on amber 100 (light) and amber 300 on a dark amber
 *  wash both clear AA at 12px; Drive's brand yellow does not. */
export function McpTag({ tool, className }: { tool?: string; className?: string }) {
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 font-mono text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
				className,
			)}
			data-testid="mcp-tag-on-drive"
		>
			<span aria-hidden="true">·</span>
			{tool ? `google_drive.${tool}` : 'google_drive'}
		</span>
	)
}
