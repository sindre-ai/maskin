export interface NamedViewport {
	width: number
	height: number
	label: string
}

export const VIEWPORTS = {
	mobile: { width: 375, height: 812, label: 'iPhone (375×812)' },
	tabletPortrait: { width: 768, height: 1024, label: 'iPad portrait (768×1024)' },
	tabletLandscape: { width: 1024, height: 768, label: 'iPad landscape (1024×768)' },
	desktop: { width: 1440, height: 900, label: 'Desktop (1440×900)' },
} as const satisfies Record<string, NamedViewport>

export const SHIP_GATE_VIEWPORTS: NamedViewport[] = [
	VIEWPORTS.mobile,
	VIEWPORTS.tabletPortrait,
	VIEWPORTS.tabletLandscape,
]
