import Foundation

/// A clip of silence, for keeping the app registered as playing audio.
///
/// The Lock Screen's Now Playing card is offered to the app the system hears playing. A live call's
/// sound comes from WebRTC's own audio unit or the speech synthesizer, and neither counts, so the
/// call loops this clip under it. Built in memory so no resource has to ship.
public enum SilentAudio {
	/// A mono, 16-bit PCM WAV file of `seconds` of silence.
	public static func wav(seconds: Double = 1, sampleRate: Int = 8000) -> Data {
		let samples = max(1, Int(seconds * Double(sampleRate)))
		let dataSize = samples * 2
		var bytes: [UInt8] = []
		bytes.reserveCapacity(44 + dataSize)
		bytes += Array("RIFF".utf8)
		bytes += littleEndian(UInt32(36 + dataSize))
		bytes += Array("WAVE".utf8)
		bytes += Array("fmt ".utf8)
		bytes += littleEndian(UInt32(16))  // size of the format block
		bytes += littleEndian(UInt16(1))  // PCM
		bytes += littleEndian(UInt16(1))  // mono
		bytes += littleEndian(UInt32(sampleRate))
		bytes += littleEndian(UInt32(sampleRate * 2))  // bytes per second
		bytes += littleEndian(UInt16(2))  // bytes per frame
		bytes += littleEndian(UInt16(16))  // bits per sample
		bytes += Array("data".utf8)
		bytes += littleEndian(UInt32(dataSize))
		bytes += [UInt8](repeating: 0, count: dataSize)
		return Data(bytes)
	}

	private static func littleEndian<T: FixedWidthInteger>(_ value: T) -> [UInt8] {
		withUnsafeBytes(of: value.littleEndian) { Array($0) }
	}
}
