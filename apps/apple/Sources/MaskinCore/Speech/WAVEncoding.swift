import Foundation

/// The audio `POST /api/transcriptions` takes: a WAV file of 16 kHz, mono, 16-bit samples, sent as
/// base64. The route caps the base64 text at about 10 million characters, which is a little over
/// three minutes of this format; the dictation session stops sending before that.
public enum WAVEncoding {
	public static let sampleRate = 16_000

	/// Float samples in -1...1 to 16-bit, clipped.
	public static func pcm16(from samples: [Float]) -> [Int16] {
		samples.map { Int16((max(-1, min(1, $0)) * Float(Int16.max)).rounded()) }
	}

	/// A complete WAV file: a 44-byte header, then the samples little-endian.
	public static func wav(pcm16 samples: [Int16], sampleRate: Int = WAVEncoding.sampleRate) -> Data {
		let dataBytes = samples.count * 2
		var data = Data(capacity: 44 + dataBytes)
		data.append(contentsOf: Array("RIFF".utf8))
		data.append(littleEndian: UInt32(36 + dataBytes))
		data.append(contentsOf: Array("WAVE".utf8))
		data.append(contentsOf: Array("fmt ".utf8))
		data.append(littleEndian: UInt32(16))
		data.append(littleEndian: UInt16(1))  // PCM
		data.append(littleEndian: UInt16(1))  // mono
		data.append(littleEndian: UInt32(sampleRate))
		data.append(littleEndian: UInt32(sampleRate * 2))  // bytes per second
		data.append(littleEndian: UInt16(2))  // bytes per frame
		data.append(littleEndian: UInt16(16))  // bits per sample
		data.append(contentsOf: Array("data".utf8))
		data.append(littleEndian: UInt32(dataBytes))
		for sample in samples { data.append(littleEndian: UInt16(bitPattern: sample)) }
		return data
	}
}

private extension Data {
	mutating func append<T: FixedWidthInteger>(littleEndian value: T) {
		var little = value.littleEndian
		Swift.withUnsafeBytes(of: &little) { append(contentsOf: $0) }
	}
}
