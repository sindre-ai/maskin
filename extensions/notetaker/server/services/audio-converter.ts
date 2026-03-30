import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffmpeg from 'fluent-ffmpeg'

ffmpeg.setFfmpegPath(ffmpegInstaller.path)

function getExtension(filename: string): string {
	return filename.split('.').pop()?.toLowerCase() ?? ''
}

/**
 * Convert audio buffer to 16kHz mono WAV (optimal for whisper.cpp).
 * Returns the buffer as-is if already WAV.
 */
export async function convertToWav(audioBuffer: Buffer, filename: string): Promise<Buffer> {
	if (getExtension(filename) === 'wav') {
		return audioBuffer
	}

	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	const ext = getExtension(filename) || 'bin'
	const inputPath = join(tmpdir(), `whisper-in-${id}.${ext}`)
	const outputPath = join(tmpdir(), `whisper-out-${id}.wav`)

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
