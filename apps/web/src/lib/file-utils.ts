export function base64ToBytes(base64: string): Uint8Array {
	if (typeof atob === 'undefined') return new Uint8Array()
	try {
		const binary = atob(base64)
		const bytes = new Uint8Array(binary.length)
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
		return bytes
	} catch {
		return new Uint8Array()
	}
}

export function decodeBase64Utf8(base64: string): string {
	const bytes = base64ToBytes(base64)
	if (bytes.length === 0) return ''
	return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => {
			const result = reader.result
			if (typeof result !== 'string') {
				reject(new Error('Failed to read file'))
				return
			}
			const comma = result.indexOf(',')
			resolve(comma >= 0 ? result.slice(comma + 1) : result)
		}
		reader.onerror = () => reject(new Error('Failed to read file'))
		reader.readAsDataURL(file)
	})
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
