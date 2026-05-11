/**
 * Trigger a browser download of the given Blob with the given filename.
 * Uses an in-memory object URL — fine for files capped at tens of MB.
 */
export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = filename
	document.body.appendChild(a)
	a.click()
	a.remove()
	URL.revokeObjectURL(url)
}
