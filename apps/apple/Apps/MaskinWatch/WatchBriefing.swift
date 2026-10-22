import AVFoundation
import MaskinCore
import MaskinDesign
import MaskinUI
import MediaPlayer
import SwiftUI

/// Today's briefing: a card, a Listen button and a text reader. The full-screen story player is
/// an iPhone, iPad and TV thing.
struct WatchBriefing: View {
	let store: ForYouStore?
	let watch: MaskinWatchStore
	let firstName: String?
	@State private var speaker = BriefingSpeaker()

	/// The live briefing, else the one in the last snapshot, so it still reads and plays offline.
	private var script: String? {
		if case .loaded(let brief) = store?.brief { return WatchBriefingText.plain(brief.markdown) }
		return watch.snapshot?.briefing
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					WatchPageTitle(title: "For you", count: store?.needsCount ?? watch.needsCount)
					NavigationLink {
						WatchBriefingReader(text: script ?? "")
					} label: { card }
						.buttonStyle(.plain)
						.disabled(script == nil)
					listenControl
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
			Text(readTime)
				.font(WatchType.mono())
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
					Label(speaker.buttonTitle, systemImage: speaker.buttonSymbol)
						.font(WatchType.action())
						.foregroundStyle(MaskinSurface.onInverse)
						.frame(maxWidth: .infinity, minHeight: WatchMetrics.target)
						.background(MaskinSurface.inverse, in: Capsule())
						.contentShape(Capsule())
				}
				.buttonStyle(.plain)
			} else {
				ProgressView().frame(maxWidth: .infinity)
			}
		}
	}

	private var greeting: String {
		StoryDerivation.greeting(name: firstName, now: Date())
	}

	private var readTime: String {
		let words = (script ?? "").split(whereSeparator: \.isWhitespace).count
		return "READ · \(max(1, Int((Double(words) / 200).rounded(.up)))) MIN"
	}
}

private struct WatchBriefingReader: View {
	let text: String

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				ForEach(Array(WatchBriefingText.paragraphs(text).enumerated()), id: \.offset) { _, paragraph in
					Text(paragraph).font(WatchType.body()).foregroundStyle(MaskinColor.ink)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
		.navigationTitle("Briefing")
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
	@ObservationIgnored private var commandsInstalled = false

	var isSpeaking: Bool { phase != .idle }
	var buttonTitle: String {
		switch phase {
		case .idle: "Listen"
		case .speaking: "Stop"
		case .paused: "Resume"
		}
	}
	var buttonSymbol: String {
		switch phase {
		case .idle: "waveform"
		case .speaking: "stop.fill"
		case .paused: "play.fill"
		}
	}

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

	nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
		Task { @MainActor in self.finish() }
	}

	nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
		Task { @MainActor in self.finish() }
	}
}
