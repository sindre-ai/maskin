interface MarketplaceHeaderIdentityProps {
	count: number | undefined
}

// Compact "Marketplace" title + item count projected into the global header's
// sticky-identity slot (same slot/style For You uses via ForYouHeaderIdentity)
// — this replaces the in-body <h1> + count on the Marketplace route so the
// title only appears once. Renders a real <h1> (unlike ForYouHeaderIdentity's
// <span>) since this becomes the page's only top-level heading.
export function MarketplaceHeaderIdentity({ count }: MarketplaceHeaderIdentityProps) {
	return (
		<div className="flex min-w-0 items-baseline gap-2" data-testid="marketplace-header-identity">
			<h1 className="truncate text-base font-semibold text-foreground">Marketplace</h1>
			{typeof count === 'number' ? (
				<span
					className="shrink-0 text-sm text-muted-foreground tabular-nums"
					data-testid="marketplace-count"
				>
					{count} in the marketplace
				</span>
			) : null}
		</div>
	)
}
