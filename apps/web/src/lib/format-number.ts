// One decimal at most, grouped the way the reader's own locale groups (992,880 / 992.880),
// the same rule the iPhone app uses for a figure.
const FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

export function formatFigure(value: number): string {
	return Number.isFinite(value) ? FORMAT.format(value) : String(value)
}
