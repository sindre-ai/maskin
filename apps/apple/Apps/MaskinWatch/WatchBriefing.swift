import AVFoundation
import MaskinCore
import MaskinDesign
import MaskinUI
import MediaPlayer
import SwiftUI

/// The daily briefing, playing: its tag, one play and pause button in a ring that fills as it is
/// read, and the time. It starts when it opens and stops when the wearer goes back, so it has no
/// Stop of its own.
struct WatchPlayer: View {
	let store: ForYouStore?
	let watch: MaskinWatchStore
	@State private var speaker = BriefingSpeaker()

	/// The live briefing, else the one in the last snapshot, so it still plays offline.
	private var script: String? {
		if case .loaded(let brief) = store?.brief { return WatchBriefingText.plain(brief.markdown) }
		return watch.snapshot?.briefing
	}

	var body: some View {
		content
			.containerBackground(for: .navigation) { WatchBackdrop() }
			.task(id: store == nil) { if let store, store.brief == .idle { await store.loadBrief() } }
			.task(id: script) {
				// Starts once the script is there, and not again after the wearer paused it.
				if let script, speaker.phase == .idle, !speaker.wasStarted { speaker.speak(script) }
			}
			.onDisappear { speaker.stop() }
	}

	@ViewBuilder
	private var content: some View {
		if let script {
			player(script)
		} else if case .failed(let message) = store?.brief {
			VStack(spacing: MaskinSpace.gapLoose) {
				Text(message).font(WatchType.caption()).foregroundStyle(MaskinColor.ink3).multilineTextAlignment(.center)
				Button { Task { await store?.loadBrief() } } label: { WatchCapsule(title: "Try again", prominent: true) }
					.buttonStyle(.plain)
			}
			.padding(.horizontal, MaskinSpace.s1)
		} else {
			WatchSpinner().frame(maxWidth: .infinity, maxHeight: .infinity)
		}
	}

	private func player(_ script: String) -> some View {
		let total = WatchBriefingText.readSeconds(script)
		let elapsed = Int((speaker.fraction * Double(total)).rounded())
		return VStack(spacing: MaskinSpace.gapLoose) {
			Text("DAILY").font(WatchType.microMono()).tracking(0.8).foregroundStyle(MaskinColor.ink4)
			Button {
				switch speaker.phase {
				case .idle: speaker.speak(script)
				case .paused: speaker.resume()
				case .speaking: speaker.pause()
				}
			} label: {
				Image(systemName: speaker.phase == .paused || speaker.phase == .idle ? "play.fill" : "pause.fill")
					.font(.system(size: MaskinFontSize.t26, weight: .bold))
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(width: WatchMetrics.player - MaskinSpace.s5 * 2, height: WatchMetrics.player - MaskinSpace.s5 * 2)
					.background(MaskinSurface.inverse, in: Circle())
					.padding(MaskinSpace.s5)
					.overlay {
						Circle().stroke(MaskinSurface.fillStrong, lineWidth: WatchMetrics.playerStroke)
						Circle().trim(from: 0, to: speaker.fraction)
							.stroke(MaskinColor.sigHi, style: StrokeStyle(lineWidth: WatchMetrics.playerStroke, lineCap: .round))
							.rotationEffect(.degrees(-90))
					}
			}
			.buttonStyle(.plain)
			.accessibilityLabel(speaker.phase == .speaking ? "Pause briefing" : "Play briefing")
			Text("\(WatchBriefingText.clock(elapsed)) / \(WatchBriefingText.clock(total))")
				.font(WatchType.mono()).foregroundStyle(MaskinColor.ink)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}

/// The watch's real audio session.
@MainActor
private struct SystemSpeechSession: SpeechAudioSession {
	var outputIsHeadphones: Bool { BriefingSpeaker.outputIsHeadphones }

	func activate(longForm: Bool) async throws {
		let session = AVAudioSession.sharedInstance()
		try session.setCategory(.playback, mode: .spokenAudio, policy: longForm ? .longFormAudio : .default)
		_ = try await session.activate()
	}
}

/// Speaks the briefing through the watch speaker or connected AirPods. With headphones it plays as
/// long-form spoken audio, so it routes to AirPods, keeps going with the wrist down, and shows up in Now
/// Playing, where the Crown sets the volume and the transport buttons pause and resume it.
@MainActor
@Observable
final class BriefingSpeaker: NSObject, AVSpeechSynthesizerDelegate {
	enum Phase: Equatable { case idle, speaking, paused }

	private let synthesizer = AVSpeechSynthesizer()
	private(set) var phase: Phase = .idle
	/// How much of the script has been spoken, 0 to 1, for the player's ring.
	private(set) var fraction: Double = 0
	/// Speech has begun at least once since the last `stop()`, so a player that was paused does not
	/// start over when its script reloads.
	private(set) var wasStarted = false
	@ObservationIgnored private var commandsInstalled = false
	@ObservationIgnored private var scriptLength = 0

	/// Whether the sound goes to AirPods or other headphones rather than the watch speaker.
	static var outputIsHeadphones: Bool {
		AVAudioSession.sharedInstance().currentRoute.outputs.contains {
			[.bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .headphones].contains($0.portType)
		}
	}

	var isSpeaking: Bool { phase != .idle }

	/// What Now Playing calls it.
	private let title: String

	init(title: String = "Daily briefing") {
		self.title = title
		super.init()
		synthesizer.delegate = self
	}

	func speak(_ text: String) {
		wasStarted = true
		installCommands()
		Task {
			await WatchSpeech.prepare(SystemSpeechSession())
			scriptLength = text.utf16.count
			fraction = 0
			synthesizer.speak(AVSpeechUtterance(string: text))
			phase = .speaking
			updateNowPlaying()
		}
	}

	func pause() {
		guard phase == .speaking else { return }
		synthesizer.pauseSpeaking(at: .immediate)
		phase = .paused
		updateNowPlaying()
	}

	func resume() {
		guard phase == .paused else { return }
		synthesizer.continueSpeaking()
		phase = .speaking
		updateNowPlaying()
	}

	func stop() {
		wasStarted = false
		synthesizer.stopSpeaking(at: .immediate)
		finish()
	}

	private func finish() {
		phase = .idle
		fraction = 0
		MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
	}

	private func updateNowPlaying() {
		MPNowPlayingInfoCenter.default().nowPlayingInfo = [
			MPMediaItemPropertyTitle: title,
			MPMediaItemPropertyArtist: "Maskin",
			MPNowPlayingInfoPropertyPlaybackRate: phase == .speaking ? 1.0 : 0.0,
		]
	}

	/// Now Playing's play, pause and toggle buttons drive the same synthesizer.
	private func installCommands() {
		guard !commandsInstalled else { return }
		commandsInstalled = true
		let center = MPRemoteCommandCenter.shared()
		center.playCommand.addTarget { [weak self] _ in
			Task { @MainActor in self?.resume() }
			return .success
		}
		center.pauseCommand.addTarget { [weak self] _ in
			Task { @MainActor in self?.pause() }
			return .success
		}
		center.togglePlayPauseCommand.addTarget { [weak self] _ in
			Task { @MainActor in
				guard let self else { return }
				if self.phase == .paused { self.resume() } else { self.pause() }
			}
			return .success
		}
	}

	nonisolated func speechSynthesizer(
		_ s: AVSpeechSynthesizer, willSpeakRangeOfSpeechString range: NSRange, utterance u: AVSpeechUtterance
	) {
		let spoken = range.location + range.length
		Task { @MainActor in
			guard self.scriptLength > 0 else { return }
			self.fraction = min(1, Double(spoken) / Double(self.scriptLength))
		}
	}

	nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
		Task { @MainActor in self.finish() }
	}

	nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
		Task { @MainActor in self.finish() }
	}
}
