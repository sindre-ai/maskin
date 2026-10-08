import AVFoundation
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Today's briefing: a card, a Listen button and a text reader. The full-screen story player is
/// an iPhone, iPad and TV thing.
struct WatchBriefing: View {
	let store: ForYouStore?
	let firstName: String?
	@State private var speaker = BriefingSpeaker()

	private var script: String? {
		if case .loaded(let brief) = store?.brief { return WatchBriefingText.plain(brief.markdown) }
		return nil
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 10) {
					WatchPageTitle(title: "For you", count: store?.needsCount ?? 0)
					NavigationLink {
						WatchBriefingReader(text: script ?? "")
					} label: { card }
						.buttonStyle(.plain)
						.disabled(script == nil)
					listenControl
				}
				.padding(.horizontal, 2)
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
				.padding(.horizontal, 10).padding(.vertical, 4)
				.background(MaskinColor.pill, in: Capsule())
			Spacer(minLength: 28)
			Text(greeting)
				.font(MaskinTypeface.sans(22, weight: .bold, relativeTo: .title2))
				.foregroundStyle(MaskinColor.stFg)
				.multilineTextAlignment(.leading)
			Text(readTime)
				.font(WatchType.mono())
				.tracking(0.6)
				.foregroundStyle(MaskinColor.stLab)
				.padding(.top, 6)
		}
		.padding(14)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinGradient.unseenBrief, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
	}

	@ViewBuilder
	private var listenControl: some View {
		switch store?.brief {
		case .failed(let message):
			Text(message).font(WatchType.caption()).foregroundStyle(MaskinColor.ink4)
			Button("Retry") { Task { await store?.loadBrief() } }.buttonStyle(SecondaryActionButtonStyle())
		case .loaded:
			Button {
				if speaker.isSpeaking { speaker.stop() } else if let script { speaker.speak(script) }
			} label: {
				Label(speaker.isSpeaking ? "Stop" : "Listen", systemImage: speaker.isSpeaking ? "stop.fill" : "waveform")
					.font(MaskinTypeface.sans(17, weight: .bold, relativeTo: .body))
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(maxWidth: .infinity, minHeight: 44)
					.background(MaskinSurface.inverse, in: Capsule())
			}
			.buttonStyle(.plain)
		default:
			ProgressView().frame(maxWidth: .infinity)
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
			VStack(alignment: .leading, spacing: 10) {
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

/// Speaks the briefing through the watch speaker or connected AirPods.
@MainActor
@Observable
final class BriefingSpeaker: NSObject, AVSpeechSynthesizerDelegate {
	private let synthesizer = AVSpeechSynthesizer()
	private(set) var isSpeaking = false

	override init() {
		super.init()
		synthesizer.delegate = self
	}

	func speak(_ text: String) {
		isSpeaking = true
		synthesizer.speak(AVSpeechUtterance(string: text))
	}

	func stop() {
		synthesizer.stopSpeaking(at: .immediate)
		isSpeaking = false
	}

	nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
		Task { @MainActor in self.isSpeaking = false }
	}

	nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
		Task { @MainActor in self.isSpeaking = false }
	}
}
