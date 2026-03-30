import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffmpeg from 'fluent-ffmpeg'

ffmpeg.setFfmpegPath(ffmpegInstaller.path)

function getExtension(filename: string): string {
	return filename.split('.').pop()?.toLowerCase() ?? ''
}

function tmpPath(label: string, ext: string): string {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	return join(tmpdir(), `whisper-${label}-${id}.${ext}`)
}

/**
 * Convert audio buffer to 16kHz mono WAV (optimal for whisper.cpp).
 * Returns the buffer as-is if already WAV.
 */
export async function convertToWav(audioBuffer: Buffer, filename: string): Promise<Buffer> {
	if (getExtension(filename) === 'wav') {
		return audioBuffer
	}

	const ext = getExtension(filename) || 'bin'
	const inputPath = tmpPath('in', ext)
	const outputPath = tmpPath('out', 'wav')

	await writeFile(inputPath, audioBuffer)

	try {
		await new Promise<void>((resolve, reject) => {
			ffmpeg(inputPath)
				.audioFrequency(16000)
				.audioChannels(1)
				.audioCodec('pcm_s16le')
				.format('wav')
				.on('error', reject)
				.on('end', () => resolve())
				.save(outputPath)
		})

		return await readFile(outputPath)
	} finally {
		await Promise.all([unlink(inputPath).catch(() => {}), unlink(outputPath).catch(() => {})])
	}
}

/** Get duration of an audio buffer in seconds using ffprobe. */
export async function getAudioDuration(wavBuffer: Buffer): Promise<number> {
	const inputPath = tmpPath('probe', 'wav')
	await writeFile(inputPath, wavBuffer)

	try {
		return await new Promise<number>((resolve, reject) => {
			ffmpeg.ffprobe(inputPath, (err, metadata) => {
				if (err) return reject(err)
				resolve(metadata.format.duration ?? 0)
			})
		})
	} finally {
		await unlink(inputPath).catch(() => {})
	}
}

/**
 * Split a WAV buffer into chunks of `chunkSeconds` duration.
 * Returns an array of { buffer, offsetSeconds } for each chunk.
 */
export async function splitWavIntoChunks(
	wavBuffer: Buffer,
	chunkSeconds: number,
): Promise<Array<{ buffer: Buffer; offsetSeconds: number }>> {
	const duration = await getAudioDuration(wavBuffer)

	if (duration <= chunkSeconds) {
		return [{ buffer: wavBuffer, offsetSeconds: 0 }]
	}

	const inputPath = tmpPath('split-in', 'wav')
	await writeFile(inputPath, wavBuffer)

	const chunks: Array<{ buffer: Buffer; offsetSeconds: number }> = []
	const chunkPaths: string[] = []

	try {
		for (let start = 0; start < duration; start += chunkSeconds) {
			const outputPath = tmpPath(`chunk-${start}`, 'wav')
			chunkPaths.push(outputPath)

			await new Promise<void>((resolve, reject) => {
				ffmpeg(inputPath)
					.setStartTime(start)
					.setDuration(Math.min(chunkSeconds, duration - start))
					.audioFrequency(16000)
					.audioChannels(1)
					.audioCodec('pcm_s16le')
					.format('wav')
					.on('error', reject)
					.on('end', () => resolve())
					.save(outputPath)
			})

			chunks.push({
				buffer: await readFile(outputPath),
				offsetSeconds: start,
			})
		}

		return chunks
	} finally {
		await Promise.all([
			unlink(inputPath).catch(() => {}),
			...chunkPaths.map((p) => unlink(p).catch(() => {})),
		])
	}
}
