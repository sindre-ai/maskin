import { RouteError } from '@/components/shared/route-error'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { trackEvent } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import { createFileRoute } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/profile')({
	component: ProfilePage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const identityRows = ['Avatar', 'Display name', 'Bio']
const accountRows = ['Email', 'Password']
const notificationRows = [
	'Mentions and replies',
	'Subscribed objects',
	'Bet status changes',
	'Weekly digest',
]

function ProfilePage() {
	useEffect(() => {
		trackEvent('profile.viewed')
	}, [])

	return (
		<div className="mx-auto w-full max-w-2xl">
			<header className="mb-6">
				<h1 className="text-lg font-semibold text-foreground">Profile</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Your identity in Maskin. Visible to others in workspaces you've joined.
				</p>
			</header>

			<Section label="Identity" rows={identityRows} />
			<Section label="Account" rows={accountRows} />
			<Section label="Notifications" rows={notificationRows} />
			<DangerZone />
		</div>
	)
}

function Section({ label, rows }: { label: string; rows: readonly string[] }) {
	return (
		<section className="mt-7 first:mt-0">
			<h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
				{label}
			</h2>
			<div className="divide-y divide-border border-t border-border">
				{rows.map((row) => (
					<PlaceholderRow key={row} rowKey={row} />
				))}
			</div>
		</section>
	)
}

function PlaceholderRow({ rowKey }: { rowKey: string }) {
	return (
		<div
			data-row={rowKey.toLowerCase().replace(/\s+/g, '-')}
			className="grid grid-cols-1 gap-1 py-3.5 md:grid-cols-[160px_1fr] md:items-center md:gap-4"
		>
			<div className="text-sm font-medium text-muted-foreground">{rowKey}</div>
			<div className="text-sm italic text-muted-foreground/70">Coming soon</div>
		</div>
	)
}

function DangerZone() {
	const [open, setOpen] = useState(false)
	return (
		<Collapsible open={open} onOpenChange={setOpen} className="mt-12">
			<div className="overflow-hidden rounded-lg border border-border">
				<CollapsibleTrigger
					className={cn(
						'flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-destructive',
						'transition-colors hover:bg-muted/40',
					)}
				>
					<span>Delete account</span>
					<ChevronRight
						className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-90')}
					/>
				</CollapsibleTrigger>
				<CollapsibleContent className="px-4 pb-4 text-sm italic text-muted-foreground/70">
					Coming soon
				</CollapsibleContent>
			</div>
		</Collapsible>
	)
}
