export function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
	const c: Record<string, number> = { all: items.length }
	for (const item of items) {
		const key = keyFn(item)
		c[key] = (c[key] ?? 0) + 1
	}
	return c
}
