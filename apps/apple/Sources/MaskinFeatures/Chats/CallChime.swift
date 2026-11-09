import AVFoundation
import Foundation
import MaskinCore

#if os(iOS)
	import UIKit
#endif

/// Plays the "ready" sound of a live call. A seam so the call is tested with a fake.
@MainActor
protocol CallChimePlaying: AnyObject {
	func play()
}

/// The soft chime (and, on iPhone, a light tap) that says the call is up and it is the person's turn.
/// Synthesised, so there is no asset. It plays through the call's own audio session and never throws:
/// a chime that can't play is just a call that starts silently.
@MainActor
final class CallChime: CallChimePlaying {
	private var player: AVAudioPlayer?

	func play() {
		#if os(iOS)
			UIImpactFeedbackGenerator(style: .soft).impactOccurred()
		#endif
		let data = Self.wav(from: MaskinReadySynth.samples(sampleRate: Self.sampleRate))
		guard let player = try? AVAudioPlayer(data: data) else { return }
		self.player = player
		player.prepareToPlay()
		player.play()
	}

	private static let sampleRate = 44_100.0

	/// 16-bit mono PCM in a WAV container, which is what `AVAudioPlayer(data:)` reads.
	static func wav(from samples: [Float]) -> Data {
		var pcm = Data(capacity: samples.count * 2)
		for sample in samples {
			let value = Int16((max(-1, min(1, sample)) * Float(Int16.max)).rounded())
			withUnsafeBytes(of: value.littleEndian) { pcm.append(contentsOf: $0) }
		}
		func le32(_ value: UInt32) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }
		func le16(_ value: UInt16) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }
		let rate = UInt32(sampleRate)
		var header = Data("RIFF".utf8)
		header.append(le32(UInt32(36 + pcm.count)))
		header.append(Data("WAVEfmt ".utf8))
		header.append(le32(16))
		header.append(le16(1))
		header.append(le16(1))
		header.append(le32(rate))
		header.append(le32(rate * 2))
		header.append(le16(2))
		header.append(le16(16))
		header.append(Data("data".utf8))
		header.append(le32(UInt32(pcm.count)))
		return header + pcm
	}
}
