interface UpdateAvailableBannerProps {
	newVersion: string
}

// Locked-install banner — fires when installed_version trails marketplace version.
// Same `border-warning/30 bg-warning/5 text-warning` pattern as the
// credentials-expired strip in settings/keys.tsx.
export function UpdateAvailableBanner({ newVersion }: UpdateAvailableBannerProps) {
	return (
		<div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
			Update to v{newVersion} available.
		</div>
	)
}
