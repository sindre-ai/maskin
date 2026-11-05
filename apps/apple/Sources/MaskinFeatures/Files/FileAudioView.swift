import AVFoundation
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Plays an audio file: play/pause, a scrubber and the elapsed and total time. The bytes are written
/// to a temporary file because the player needs a URL; the file is removed when the view goes away.
struct FileAudioView: View {
	let data: Data
	let name: String
	let mimeType: String
	/// Changes whenever the bytes change, so the player reloads.
	var revision = 0
	@State private var model = AudioPlaybackModel()

	var body: some View {
		Group {
			if model.failed || data.isEmpty {
				EmptyState(
					symbol: "waveform", title: "Couldn't play this file",
					message: "Use Share to open it in another app.")
			} else {
				player
			}
		}
		.task(id: revision) { await model.load(data: data, mimeType: mimeType, name: name) }
		.onDisappear { model.teardown() }
	}

	private var player: some View {
		HStack(spacing: MaskinSpace.s5) {
			Button { model.toggle() } label: {
				Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
					.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.foregroundStyle(MaskinColor.ink)
			.disabled(!model.isReady)
			.accessibilityLabel(model.isPlaying ? "Pause" : "Play")
			VStack(spacing: MaskinSpace.s1) {
				Slider(
					value: Binding(get: { model.position }, set: { model.seek(to: $0) }),
					in: 0...max(model.duration, 1)
				)
				.disabled(!model.isReady)
				.accessibilityLabel("Playback position")
				.accessibilityValue("\(FileAudio.timeText(model.position)) of \(FileAudio.timeText(model.duration))")
				HStack {
					Text(FileAudio.timeText(model.position))
					Spacer(minLength: 0)
					Text(FileAudio.timeText(model.duration))
				}
				.maskinText(.caption).monospacedDigit()
				.foregroundStyle(MaskinColor.ink4)
			}
		}
		.padding(MaskinSpace.s5)
		.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.input))
		.accessibilityElement(children: .contain)
	}
}

@MainActor @Observable
final class AudioPlaybackModel {
	private(set) var isPlaying = false
	private(set) var isReady = false
	private(set) var failed = false
	private(set) var position: Double = 0
	private(set) var duration: Double = 0

	@ObservationIgnored private var player: AVPlayer?
	@ObservationIgnored private var observer: Any?
	@ObservationIgnored private var fileURL: URL?

	func load(data: Data, mimeType: String, name: String) async {
		teardown()
		failed = false
		guard !data.isEmpty else { return }
		let ext = FileAudio.fileExtension(mimeType: mimeType, name: name)
		let url = FileManager.default.temporaryDirectory
			.appendingPathComponent("maskin-audio", isDirectory: true)
			.appendingPathComponent("\(UUID().uuidString).\(ext)")
		// Claimed before the first await: teardown() clears it, which is how a load that was
		// superseded (view gone, bytes changed) finds out and cleans up after itself.
		fileURL = url
		do {
			try await Task.detached(priority: .userInitiated) {
				try FileManager.default.createDirectory(
					at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
				try data.write(to: url, options: .atomic)
			}.value
			guard fileURL == url else {
				try? FileManager.default.removeItem(at: url)
				return
			}
			let asset = AVURLAsset(url: url)
			guard try await asset.load(.isPlayable) else {
				failed = true
				return
			}
			let seconds = try await asset.load(.duration).seconds
			guard fileURL == url else { return }
			duration = seconds.isFinite ? seconds : 0
			let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
			observer = player.addPeriodicTimeObserver(
				forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main
			) { [weak self, weak player] time in
				MainActor.assumeIsolated {
					guard let self, let player else { return }
					self.position = time.seconds.isFinite ? time.seconds : 0
					self.isPlaying = player.rate != 0
				}
			}
			self.player = player
			isReady = true
		} catch {
			failed = true
		}
	}

	func toggle() {
		guard let player else { return }
		if isPlaying {
			player.pause()
			isPlaying = false
			return
		}
		#if os(iOS)
		// `.playback` so a sound plays with the silent switch on, like any audio player.
		try? AVAudioSession.sharedInstance().setCategory(.playback)
		try? AVAudioSession.sharedInstance().setActive(true)
		#endif
		// Played to the end: start over.
		if duration > 0, position >= duration - 0.1 { seek(to: 0) }
		player.play()
		isPlaying = true
	}

	func seek(to seconds: Double) {
		position = seconds
		player?.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
	}

	func teardown() {
		if let observer { player?.removeTimeObserver(observer) }
		observer = nil
		player?.pause()
		player = nil
		if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
		fileURL = nil
		isPlaying = false
		isReady = false
		position = 0
		duration = 0
	}
}
