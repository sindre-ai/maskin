interface UpdateAvailableBannerProps {
	newVersion: string
}

// Locked-install banner — fires when installed_version trails catalog version.
// Same `border-warning/30 bg-warning/5 text-warning` pattern as the
// credentials-expired strip in settings/keys.tsx.
export function UpdateAvailableBanner({ newVersion }: UpdateAvailableBannerProps) {
	return (
		<div className="rounded-md border border-warning/30 bg-warning/5 px-[var(--space-3)] py-[var(--space-2)] text-caption text-warning">
			Update to v{newVersion} available.
		</div>
	)
}
