import { WAV_SAMPLE_RATE, encodeWav } from '@/lib/wav'
import { describe, expect, it } from 'vitest'

// jsdom's Blob has no arrayBuffer().
function view(blob: Blob): Promise<DataView> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onerror = () => reject(reader.error)
		reader.onload = () => resolve(new DataView(reader.result as ArrayBuffer))
		reader.readAsArrayBuffer(blob)
	})
}

function text(v: DataView, offset: number, length: number): string {
	let out = ''
	for (let i = 0; i < length; i++) out += String.fromCharCode(v.getUint8(offset + i))
	return out
}

describe('encodeWav', () => {
	it('writes a 16 kHz mono 16-bit PCM header', async () => {
		const v = await view(encodeWav(new Float32Array(100)))
		expect(text(v, 0, 4)).toBe('RIFF')
		expect(text(v, 8, 4)).toBe('WAVE')
		expect(text(v, 12, 4)).toBe('fmt ')
		expect(v.getUint16(20, true)).toBe(1) // PCM
		expect(v.getUint16(22, true)).toBe(1) // mono
		expect(v.getUint32(24, true)).toBe(WAV_SAMPLE_RATE)
		expect(v.getUint16(34, true)).toBe(16)
		expect(text(v, 36, 4)).toBe('data')
		expect(v.getUint32(40, true)).toBe(200)
		expect(v.getUint32(4, true)).toBe(36 + 200)
		expect(v.byteLength).toBe(44 + 200)
	})

	it('scales samples to int16 and clamps out-of-range values', async () => {
		const v = await view(encodeWav(new Float32Array([0, 1, -1, 2, -2])))
		expect(v.getInt16(44, true)).toBe(0)
		expect(v.getInt16(46, true)).toBe(32767)
		expect(v.getInt16(48, true)).toBe(-32768)
		expect(v.getInt16(50, true)).toBe(32767)
		expect(v.getInt16(52, true)).toBe(-32768)
	})
})
