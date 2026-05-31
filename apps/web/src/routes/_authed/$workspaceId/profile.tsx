import { PageHeader } from '@/components/layout/page-header'
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

function ProfilePage() {
	useEffect(() => {
		trackEvent('profile.viewed')
	}, [])

	return (
		<div className="mx-auto w-full max-w-2xl">
			<PageHeader title="Profile" />
			<header className="mb-6">
				<h1 className="text-lg font-semibold text-foreground">Profile</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Your identity in Maskin. Visible to others in workspaces you've joined.
				</p>
			</header>

			<Section label="Identity">
				<PlaceholderRow rowKey="Avatar" comingIn="T5" />
				<PlaceholderRow rowKey="Display name" comingIn="T6" />
				<PlaceholderRow rowKey="Bio" comingIn="T6" />
			</Section>

			<Section label="Account">
				<PlaceholderRow rowKey="Email" comingIn="T9" />
				<PlaceholderRow rowKey="Password" comingIn="T7" />
			</Section>

			<Section label="Notifications">
				<PlaceholderRow rowKey="Preferences" comingIn="T8" />
			</Section>

			<DangerZone />
		</div>
	)
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<section className="mt-7 first:mt-0">
			<h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
				{label}
			</h2>
			<div className="divide-y divide-border border-t border-border">{children}</div>
		</section>
	)
}

function PlaceholderRow({ rowKey, comingIn }: { rowKey: string; comingIn: string }) {
	return (
		<div
			data-row={rowKey.toLowerCase().replace(/\s+/g, '-')}
			className="grid grid-cols-[140px_1fr] items-center gap-4 py-3.5 sm:grid-cols-[160px_1fr]"
		>
			<div className="text-sm font-medium text-muted-foreground">{rowKey}</div>
			<div className="text-sm text-muted-foreground">Coming in {comingIn}</div>
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
				<CollapsibleContent className="px-4 pb-4 text-sm text-muted-foreground">
					Coming in T10.
				</CollapsibleContent>
			</div>
		</Collapsible>
	)
}
