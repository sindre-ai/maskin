// Speech-to-text models behind OpenRouter document WAV as their input format,
// while MediaRecorder produces webm/opus (Chrome, Firefox) or mp4 (Safari).
// Recordings are decoded in the browser and re-encoded as 16 kHz mono 16-bit
// PCM: what speech models want, and ~32 KB per second of speech.

export const WAV_SAMPLE_RATE = 16_000

const WAV_HEADER_BYTES = 44

/** The 44-byte header of a mono 16-bit PCM WAV file holding `dataBytes` of samples. */
function wavHeader(dataBytes: number, sampleRate: number): ArrayBuffer {
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES)
	const view = new DataView(buffer)
	const writeText = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
	}

	writeText(0, 'RIFF')
	view.setUint32(4, 36 + dataBytes, true)
	writeText(8, 'WAVE')
	writeText(12, 'fmt ')
	view.setUint32(16, 16, true) // fmt chunk size
	view.setUint16(20, 1, true) // PCM
	view.setUint16(22, 1, true) // mono
	view.setUint32(24, sampleRate, true)
	view.setUint32(28, sampleRate * 2, true) // byte rate
	view.setUint16(32, 2, true) // block align
	view.setUint16(34, 16, true) // bits per sample
	writeText(36, 'data')
	view.setUint32(40, dataBytes, true)
	return buffer
}

/** Encodes mono float samples in [-1, 1] as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number = WAV_SAMPLE_RATE): Blob {
	const pcm = new DataView(new ArrayBuffer(samples.length * 2))
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
		pcm.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
	}
	return new Blob([wavHeader(pcm.byteLength, sampleRate), pcm.buffer], { type: 'audio/wav' })
}

function readBytes(blob: Blob): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onerror = () => reject(reader.error ?? new Error('Could not read audio'))
		reader.onload = () => resolve(reader.result as ArrayBuffer)
		reader.readAsArrayBuffer(blob)
	})
}

/**
 * Joins WAV files made by `encodeWav` (16 kHz mono) into one, back to back.
 * The samples are copied as they are: re-encoding them would lose a little
 * each time a joined file is joined again.
 */
export async function concatWav(blobs: Blob[]): Promise<Blob> {
	const pcm = await Promise.all(
		blobs.map(async (blob) => (await readBytes(blob)).slice(WAV_HEADER_BYTES)),
	)
	const dataBytes = pcm.reduce((sum, part) => sum + part.byteLength, 0)
	return new Blob([wavHeader(dataBytes, WAV_SAMPLE_RATE), ...pcm], { type: 'audio/wav' })
}

/** Decodes any audio blob the browser can play and re-encodes it as 16 kHz mono WAV. */
export async function blobToWav16k(blob: Blob): Promise<Blob> {
	const encoded = await blob.arrayBuffer()
	const ctx = new AudioContext()
	let decoded: AudioBuffer
	try {
		decoded = await ctx.decodeAudioData(encoded)
	} finally {
		void ctx.close().catch(() => {})
	}

	// Rendering through an OfflineAudioContext at the target rate does the
	// resample and the mono downmix in one step.
	const length = Math.max(1, Math.ceil(decoded.duration * WAV_SAMPLE_RATE))
	const offline = new OfflineAudioContext(1, length, WAV_SAMPLE_RATE)
	const source = offline.createBufferSource()
	source.buffer = decoded
	source.connect(offline.destination)
	source.start()
	const rendered = await offline.startRendering()
	return encodeWav(rendered.getChannelData(0))
}

/** Base64 of a blob's bytes, without the data-URL prefix. */
export function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onerror = () => reject(reader.error ?? new Error('Could not read audio'))
		reader.onload = () => {
			const result = String(reader.result)
			resolve(result.slice(result.indexOf(',') + 1))
		}
		reader.readAsDataURL(blob)
	})
}
