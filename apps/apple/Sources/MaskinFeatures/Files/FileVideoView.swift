import AVFoundation
import AVKit
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Plays a video file with the system controls, in a frame that matches the video's shape so a
/// portrait clip fits without cropping. The bytes are written to a temporary file because the player
/// needs a URL; the file is removed when the view goes away.
struct FileVideoView: View {
	let data: Data
	let name: String
	let mimeType: String
	/// Changes whenever the bytes change, so the player reloads.
	var revision = 0
	@State private var model = VideoPlaybackModel()

	var body: some View {
		Group {
			if model.failed || data.isEmpty {
				EmptyState(
					symbol: "film", title: "Couldn't play this file",
					message: "Use Share to open it in another app.")
			} else if let player = model.player {
				VideoPlayer(player: player)
					.aspectRatio(model.aspectRatio, contentMode: .fit)
					.frame(maxWidth: .infinity)
					.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.input))
					.accessibilityLabel(name)
			} else {
				LoadingSkeleton(rows: 3)
			}
		}
		.task(id: revision) { await model.load(data: data, mimeType: mimeType, name: name) }
		.onDisappear { model.teardown() }
	}
}

@MainActor @Observable
final class VideoPlaybackModel {
	private(set) var player: AVPlayer?
	private(set) var failed = false
	private(set) var aspectRatio = FileVideo.aspectRatio(width: 0, height: 0)

	@ObservationIgnored private var fileURL: URL?

	func load(data: Data, mimeType: String, name: String) async {
		teardown()
		failed = false
		guard !data.isEmpty else { return }
		let ext = FileVideo.fileExtension(mimeType: mimeType, name: name)
		let url = FileManager.default.temporaryDirectory
			.appendingPathComponent("maskin-video", isDirectory: true)
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
			if let track = try await asset.loadTracks(withMediaType: .video).first {
				let (size, transform) = try await track.load(.naturalSize, .preferredTransform)
				// A phone clip is stored landscape with a rotation; apply it to get the shown shape.
				let shown = size.applying(transform)
				aspectRatio = FileVideo.aspectRatio(width: shown.width, height: shown.height)
			}
			guard fileURL == url else { return }
			#if os(iOS)
			// `.playback` so sound plays with the silent switch on, like any video player.
			try? AVAudioSession.sharedInstance().setCategory(.playback)
			try? AVAudioSession.sharedInstance().setActive(true)
			#endif
			player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
		} catch {
			failed = true
		}
	}

	func teardown() {
		player?.pause()
		player = nil
		if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
		fileURL = nil
	}
}
