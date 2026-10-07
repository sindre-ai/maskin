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

	private var text: String? {
		if case .loaded(let brief) = store?.brief { return WatchBriefingText.plain(brief.markdown) }
		return nil
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					NavigationLink {
						WatchBriefingReader(text: text ?? "")
					} label: {
						VStack(alignment: .leading, spacing: MaskinSpace.s3) {
							Text("DAILY").font(.system(size: 10, weight: .bold))
								.padding(.horizontal, 8).padding(.vertical, 3)
								.background(MaskinSurface.fill, in: Capsule())
							Text(greeting).font(.title3.weight(.bold)).multilineTextAlignment(.leading)
							Text(readTime).font(.caption2.monospaced()).foregroundStyle(MaskinColor.ink4)
						}
						.frame(maxWidth: .infinity, alignment: .leading)
						.padding(MaskinSpace.s5)
						.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 22))
					}
					.buttonStyle(.plain)
					.disabled(text == nil)

					listenControl
				}
			}
			.navigationTitle("Briefing")
		}
		.task(id: store == nil) { if let store, store.brief == .idle { await store.loadBrief() } }
		.onDisappear { speaker.stop() }
	}

	@ViewBuilder
	private var listenControl: some View {
		switch store?.brief {
		case .failed(let message):
			Text(message).font(.footnote).foregroundStyle(MaskinColor.ink4)
			Button("Retry") { Task { await store?.loadBrief() } }.buttonStyle(SecondaryActionButtonStyle())
		case .loaded:
			Button {
				if speaker.isSpeaking { speaker.stop() } else if let text { speaker.speak(text) }
			} label: {
				Label(speaker.isSpeaking ? "Stop" : "Listen", systemImage: speaker.isSpeaking ? "stop.fill" : "waveform")
			}
			.buttonStyle(PrimaryActionButtonStyle())
			.frame(minHeight: 44)
		default:
			ProgressView()
		}
	}

	private var greeting: String {
		let hour = Calendar.current.component(.hour, from: Date())
		let part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
		return firstName.map { "\(part), \($0)" } ?? part
	}

	private var readTime: String {
		let words = text?.split(whereSeparator: \.isWhitespace).count ?? 0
		return "READ · \(max(1, Int((Double(words) / 200).rounded(.up)))) MIN"
	}
}

private struct WatchBriefingReader: View {
	let text: String

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				ForEach(Array(WatchBriefingText.paragraphs(text).enumerated()), id: \.offset) { _, paragraph in
					Text(paragraph).font(.system(size: 16))
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
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
