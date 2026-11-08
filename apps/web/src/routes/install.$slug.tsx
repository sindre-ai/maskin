import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useInstallLoop, useInstalledLoops } from '@/hooks/use-installed-loops'
import { useMarketplaceLoop, useMarketplaceLoops } from '@/hooks/use-marketplace-loops'
import { useWorkspaces } from '@/hooks/use-workspaces'
import type { MarketplaceItemType } from '@/lib/api'
import { isAuthenticated } from '@/lib/auth'
import { getLastWorkspaceId } from '@/lib/last-workspace'
import { PUBLIC_MARKETPLACE_URL } from '@/lib/public-site'
import { sortByName } from '@/lib/sort'
import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

// Where "Install" on a public maskin.io loop page lands: /install/<loop slug>. The person is signed in first
// (login and signup both return here), then adds the loop to one workspace with a single press.

export const Route = createFileRoute('/install/$slug')({
	beforeLoad: ({ location }) => {
		// Not signed in: sign in (or sign up) first, then come back to this exact page.
		if (!isAuthenticated()) {
			throw redirect({ to: '/login', search: { redirect: location.href } })
		}
	},
	head: () => ({ meta: [{ title: 'Install a loop — Maskin' }] }),
	component: InstallPage,
})

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="w-full max-w-sm space-y-6">{children}</div>
		</div>
	)
}

function NotFound() {
	return (
		<Shell>
			<div className="text-center">
				<h1 className="text-2xl font-semibold tracking-tight">We couldn't find that loop</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					It may not be installable yet, or the link is wrong.
				</p>
				<Button asChild variant="secondary" className="mt-4">
					<a href={PUBLIC_MARKETPLACE_URL}>See all loops</a>
				</Button>
			</div>
		</Shell>
	)
}

const ITEM_TYPE_NOUN: Record<MarketplaceItemType, [one: string, many: string]> = {
	actor: ['agent', 'agents'],
	trigger: ['trigger', 'triggers'],
	skill: ['skill', 'skills'],
	integration: ['integration', 'integrations'],
}

function InstallPage() {
	const { slug } = Route.useParams()
	const navigate = useNavigate()
	const { data: list, isLoading: loopsLoading, isError: loopsError } = useMarketplaceLoops()
	const loop = list?.loops.find((l) => l.slug === slug)
	const { data: detail } = useMarketplaceLoop(loop?.id ?? '')
	const { data: workspaces, isLoading: workspacesLoading } = useWorkspaces()
	const [picked, setPicked] = useState<string | null>(null)

	// Their last-used workspace while they are still in it, else the first one.
	const lastId = getLastWorkspaceId()
	const workspaceId =
		(picked && workspaces?.some((w) => w.id === picked) ? picked : null) ??
		workspaces?.find((w) => w.id === lastId)?.id ??
		workspaces?.[0]?.id ??
		''
	const workspace = workspaces?.find((w) => w.id === workspaceId)

	const { data: installs } = useInstalledLoops(workspaceId)
	const existing = installs?.installs.find((row) => row.sourceLoopId === loop?.id)
	const install = useInstallLoop(workspaceId)

	if (loopsLoading || workspacesLoading) {
		return (
			<Shell>
				<div className="flex justify-center">
					<Spinner />
				</div>
			</Shell>
		)
	}
	if (loopsError) {
		return (
			<Shell>
				<div className="text-center">
					<h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						We couldn't load the loop. Reload the page to try again.
					</p>
				</div>
			</Shell>
		)
	}
	if (!loop) return <NotFound />

	if (!workspace) {
		return (
			<Shell>
				<div className="text-center">
					<h1 className="text-2xl font-semibold tracking-tight">Create a workspace first</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						{loop.name} needs a workspace to go into.
					</p>
					<Button asChild className="mt-4">
						<Link to="/">Create a workspace</Link>
					</Button>
				</div>
			</Shell>
		)
	}

	const counts = new Map<MarketplaceItemType, number>()
	for (const item of detail?.items ?? []) {
		counts.set(item.item_type, (counts.get(item.item_type) ?? 0) + 1)
	}
	const comesWith = (Object.keys(ITEM_TYPE_NOUN) as MarketplaceItemType[])
		.filter((type) => counts.has(type))
		.map((type) => {
			const n = counts.get(type) ?? 0
			return `${n} ${ITEM_TYPE_NOUN[type][n === 1 ? 0 : 1]}`
		})

	const manage = (objectId: string | null) =>
		objectId
			? navigate({
					to: '/$workspaceId/loops/$loopId',
					params: { workspaceId, loopId: objectId },
				})
			: navigate({ to: '/$workspaceId/loops', params: { workspaceId } })

	return (
		<Shell>
			<div className="text-center">
				<h1 className="text-2xl font-semibold tracking-tight">{loop.name}</h1>
				<p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{loop.description}</p>
				{comesWith.length > 0 ? (
					<p className="mt-3 text-xs text-muted-foreground">Comes with {comesWith.join(', ')}.</p>
				) : null}
			</div>

			<div className="space-y-1.5">
				<p className="text-xs text-muted-foreground">Goes into this workspace</p>
				{workspaces && workspaces.length > 1 ? (
					<Select value={workspaceId} onValueChange={setPicked} disabled={install.isPending}>
						<SelectTrigger aria-label="Workspace">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{sortByName(workspaces).map((ws) => (
								<SelectItem key={ws.id} value={ws.id}>
									{ws.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : (
					<p className="rounded-lg border border-border bg-card p-3 text-sm font-medium">
						{workspace.name}
					</p>
				)}
			</div>

			{existing ? (
				<div className="space-y-2 text-center">
					<p className="text-sm font-semibold text-success">Already installed</p>
					<Button className="w-full" onClick={() => manage(existing.objectId)}>
						Manage
					</Button>
				</div>
			) : (
				<div className="space-y-2">
					<FormError
						error={
							install.error ? install.error.message || 'Could not install the loop' : undefined
						}
					/>
					<Button
						className="w-full"
						disabled={install.isPending}
						onClick={() =>
							install.mutate(
								{ loopId: loop.id, source: 'public_site' },
								{ onSuccess: (row) => manage(row.objectId) },
							)
						}
					>
						{install.isPending ? 'Installing…' : 'Install'}
					</Button>
				</div>
			)}
		</Shell>
	)
}
