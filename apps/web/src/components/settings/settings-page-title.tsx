/**
 * The large title and one-line subtitle a Settings sub-page opens with (v3 mockup). The
 * back link to Settings is the crumb in the shared top nav, so only the title lives here.
 */
export function SettingsPageTitle({
	title,
	subtitle,
}: {
	title: string
	subtitle?: React.ReactNode
}) {
	return (
		<header className="mb-5 px-2">
			<h1 className="page-title">{title}</h1>
			{subtitle ? <p className="mt-1.5 text-[15px] text-muted-foreground">{subtitle}</p> : null}
		</header>
	)
}
