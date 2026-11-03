import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Link } from '@tanstack/react-router'
import { Fragment } from 'react'

interface Crumb {
	label: string
	to?: string
	params?: Record<string, string>
}

/** Detail-page breadcrumb: always starts at Marketplace (linked to the catalog
 * for the current workspace), then the record's nesting level, ending on the
 * current (non-link) page name. Composed by the loop and item detail pages. */
export function MarketplaceBreadcrumb({
	workspaceId,
	items,
}: {
	workspaceId: string
	items: Crumb[]
}) {
	const all: Crumb[] = [
		{ label: 'Marketplace', to: '/$workspaceId/marketplace', params: { workspaceId } },
		...items,
	]

	return (
		<Breadcrumb>
			<BreadcrumbList>
				{all.map((crumb, i) => {
					const isLast = i === all.length - 1
					return (
						<Fragment key={crumb.label}>
							<BreadcrumbItem>
								{isLast || !crumb.to ? (
									<BreadcrumbPage>{crumb.label}</BreadcrumbPage>
								) : (
									<BreadcrumbLink asChild>
										<Link to={crumb.to} params={crumb.params}>
											{crumb.label}
										</Link>
									</BreadcrumbLink>
								)}
							</BreadcrumbItem>
							{!isLast && <BreadcrumbSeparator />}
						</Fragment>
					)
				})}
			</BreadcrumbList>
		</Breadcrumb>
	)
}
