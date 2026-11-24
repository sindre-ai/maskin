import Foundation
import Testing

@testable import MaskinCore

@Suite("Silent audio clip") struct SilentAudioTests {
	private func text(_ data: Data, _ range: Range<Int>) -> String {
		String(decoding: data[range], as: UTF8.self)
	}

	private func number(_ data: Data, at offset: Int, bytes: Int) -> Int {
		(0..<bytes).reduce(0) { $0 | Int(data[offset + $1]) << (8 * $1) }
	}

	@Test func theClipIsAWavFileHeaderFollowedByTheSamples() {
		let data = SilentAudio.wav(seconds: 1, sampleRate: 8000)
		#expect(text(data, 0..<4) == "RIFF")
		#expect(text(data, 8..<12) == "WAVE")
		#expect(text(data, 12..<16) == "fmt ")
		#expect(text(data, 36..<40) == "data")
		// One second of mono 16-bit samples at 8 kHz is 16,000 bytes after a 44-byte header.
		#expect(data.count == 44 + 16_000)
	}

	@Test func theSizesInTheHeaderMatchTheData() {
		let data = SilentAudio.wav(seconds: 0.5, sampleRate: 8000)
		#expect(number(data, at: 4, bytes: 4) == data.count - 8)
		#expect(number(data, at: 40, bytes: 4) == data.count - 44)
		#expect(number(data, at: 24, bytes: 4) == 8000)
		#expect(number(data, at: 22, bytes: 2) == 1)
		#expect(number(data, at: 34, bytes: 2) == 16)
	}

	@Test func everySampleIsSilent() {
		let data = SilentAudio.wav()
		#expect(data.dropFirst(44).allSatisfy { $0 == 0 })
	}

	@Test func aZeroLengthClipStillHoldsASample() {
		#expect(SilentAudio.wav(seconds: 0).count == 44 + 2)
	}
}
