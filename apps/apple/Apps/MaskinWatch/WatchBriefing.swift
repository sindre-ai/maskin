import AVFoundation
import MaskinCore
import MaskinDesign
import MaskinUI
import MediaPlayer
import SwiftUI

/// Today's briefing: a card with one Listen button, which turns into a player. The full-screen
/// story player is an iPhone, iPad and TV thing.
struct WatchBriefing: View {
	let store: ForYouStore?
	let watch: MaskinWatchStore
	let firstName: String?
	@State private var speaker = BriefingSpeaker()

	/// The live briefing, else the one in the last snapshot, so it still plays offline.
	private var script: String? {
		if case .loaded(let brief) = store?.brief { return WatchBriefingText.plain(brief.markdown) }
		return watch.snapshot?.briefing
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					if speaker.isSpeaking, let script {
						player(script)
					} else {
						WatchPageTitle(title: "For you", count: store?.needsCount ?? watch.needsCount)
						card
						listenControl
					}
				}
				.padding(.horizontal, MaskinSpace.s1)
			}
			.toolbar(.hidden, for: .navigationBar)
			.containerBackground(for: .navigation) { WatchBackdrop() }
		}
		.task(id: store == nil) { if let store, store.brief == .idle { await store.loadBrief() } }
		.onDisappear { speaker.stop() }
	}

	private var card: some View {
		VStack(alignment: .leading, spacing: 0) {
			Text("DAILY")
				.font(WatchType.microMono())
				.tracking(0.8)
				.foregroundStyle(MaskinColor.stLab)
				.padding(.horizontal, MaskinSpace.s5).padding(.vertical, MaskinSpace.s2)
				.background(MaskinColor.pill, in: Capsule())
			Spacer(minLength: MaskinSpace.s13)
			Text(greeting)
				.font(WatchType.title())
				.foregroundStyle(MaskinColor.stFg)
				.multilineTextAlignment(.leading)
			Text(meta)
				.font(WatchType.microMono())
				.tracking(0.6)
				.foregroundStyle(MaskinColor.stLab)
				.padding(.top, MaskinSpace.s3)
		}
		.padding(MaskinSpace.s8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinGradient.unseenBrief, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
	}

	@ViewBuilder
	private var listenControl: some View {
		switch store?.brief {
		case .failed(let message) where script == nil:
			Text(message).font(WatchType.caption()).foregroundStyle(MaskinColor.ink4)
			Button("Retry") { Task { await store?.loadBrief() } }
				.buttonStyle(SecondaryActionButtonStyle())
				.frame(minHeight: WatchMetrics.target)
		default:
			if let script {
				Button { speaker.toggle(script) } label: {
					Label("Listen", systemImage: "play.fill")
						.font(WatchType.action())
						.foregroundStyle(MaskinSurface.onInverse)
						.frame(maxWidth: .infinity, minHeight: WatchMetrics.target)
						.background(MaskinSurface.inverse, in: Capsule())
						.contentShape(Capsule())
				}
				.buttonStyle(.plain)
			} else {
				WatchSpinner().frame(maxWidth: .infinity)
			}
		}
	}

	/// The player: pause and play inside a ring that fills as the briefing is read.
	private func player(_ script: String) -> some View {
		let total = WatchBriefingText.readSeconds(script)
		let elapsed = Int((speaker.fraction * Double(total)).rounded())
		return VStack(spacing: MaskinSpace.gapLoose) {
			Text("DAILY BRIEFING")
				.font(WatchType.microMono()).tracking(0.8)
				.foregroundStyle(MaskinColor.stLab)
			Button { speaker.phase == .paused ? speaker.resume() : speaker.pause() } label: {
				Image(systemName: speaker.phase == .paused ? "play.fill" : "pause.fill")
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
			.accessibilityLabel(speaker.phase == .paused ? "Resume briefing" : "Pause briefing")
			Text("\(WatchBriefingText.clock(elapsed)) / \(WatchBriefingText.clock(total))")
				.font(WatchType.mono()).foregroundStyle(MaskinColor.ink2)
			WatchQuietButton(title: "Stop") { speaker.stop() }
		}
		.frame(maxWidth: .infinity)
	}

	private var greeting: String {
		StoryDerivation.greeting(name: firstName, now: Date())
	}

	/// "3 MIN · AIRPODS": how long it takes, and where the sound will go.
	private var meta: String {
		WatchBriefingText.meta(
			minutes: WatchBriefingText.readMinutes(script ?? ""), headphones: BriefingSpeaker.outputIsHeadphones)
	}
}

/// Speaks the briefing through the watch speaker or connected AirPods. It plays as long-form
/// spoken audio, so it routes to AirPods, keeps going with the wrist down, and shows up in Now
/// Playing, where the Crown sets the volume and the transport buttons pause and resume it.
@MainActor
@Observable
final class BriefingSpeaker: NSObject, AVSpeechSynthesizerDelegate {
	enum Phase: Equatable { case idle, speaking, paused }

	private let synthesizer = AVSpeechSynthesizer()
	private(set) var phase: Phase = .idle
	/// How much of the script has been spoken, 0 to 1, for the player's ring.
	private(set) var fraction: Double = 0
	@ObservationIgnored private var commandsInstalled = false
	@ObservationIgnored private var scriptLength = 0

	/// Whether the sound goes to AirPods or other headphones rather than the watch speaker.
	static var outputIsHeadphones: Bool {
		AVAudioSession.sharedInstance().currentRoute.outputs.contains {
			[.bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .headphones].contains($0.portType)
		}
	}

	var isSpeaking: Bool { phase != .idle }

	override init() {
		super.init()
		synthesizer.delegate = self
	}

	/// Listen starts, Stop ends it (the mockup's label); Now Playing still pauses and resumes.
	func toggle(_ text: String) {
		switch phase {
		case .idle: speak(text)
		case .speaking: stop()
		case .paused: resume()
		}
	}

	func speak(_ text: String) {
		installCommands()
		Task {
			let session = AVAudioSession.sharedInstance()
			try? session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
			_ = try? await session.activate()
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
			MPMediaItemPropertyTitle: "Daily briefing",
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
