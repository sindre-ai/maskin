import AVFoundation
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The briefing cards at the top of For you: the daily briefing first, then each page a flow has
/// produced. Selecting one plays the briefing full screen.
struct TVStoryRow: View {
	let stories: StoriesStore
	let open: (StoryCard) -> Void

	var body: some View {
		if !stories.cards.isEmpty {
			ScrollView(.horizontal, showsIndicators: false) {
				LazyHStack(spacing: 32) {
					ForEach(stories.cards) { card in
						Button { open(card) } label: { TVStoryCard(card: card, isSeen: stories.isSeen(card)) }
							.buttonStyle(TVFocusStyle(scale: 1.06, cornerRadius: 32))
					}
				}
				.padding(.vertical, 32)
			}
			.scrollClipDisabled()
		}
	}
}

private struct TVStoryCard: View {
	let card: StoryCard
	let isSeen: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack(alignment: .top) {
				Text(card.unit.uppercased())
					.font(.system(size: 20, weight: .semibold, design: .monospaced))
					.foregroundStyle(isSeen ? MaskinColor.ink5 : MaskinColor.stLab)
					.lineLimit(1)
					.padding(.horizontal, 16).padding(.vertical, 6)
					.background(MaskinSurface.fill, in: Capsule())
				Spacer(minLength: 0)
				if !isSeen { Circle().fill(MaskinColor.sig).frame(width: 14, height: 14) }
			}
			Spacer(minLength: 0)
			Text(card.headline)
				.font(.system(size: 30, weight: .bold))
				.foregroundStyle(isSeen ? MaskinColor.ink : MaskinColor.stFg)
				.multilineTextAlignment(.leading)
				.lineLimit(3)
		}
		.padding(28)
		.frame(width: 300, height: 210, alignment: .leading)
		.background(isSeen ? AnyShapeStyle(MaskinSurface.card) : AnyShapeStyle(MaskinGradient.unseenBrief),
			in: RoundedRectangle(cornerRadius: 32, style: .continuous))
	}
}

/// What one screen of the player shows.
struct TVSlide: Equatable {
	var unit: String
	var text: String
	var isPage: Bool
}

/// Turns the story cards into screens. The daily briefing is split into sentences-sized slides; a
/// page (HTML) can't be drawn on tvOS, so it is one slide that names it and points to a phone or
/// iPad.
enum TVSlides {
	static func make(from sequence: BriefSequence) -> (slides: [TVSlide], cardIndex: [Int]) {
		var slides: [TVSlide] = []
		var owner: [Int] = []
		for (index, card) in sequence.slides.enumerated() {
			switch card.content {
			case .briefing(let headline, let script):
				let chunks = BriefingChunks.split(script: script)
				let texts = chunks.isEmpty ? [headline] : chunks
				for text in texts {
					slides.append(TVSlide(unit: card.unit, text: text, isPage: false))
					owner.append(index)
				}
			case .page:
				slides.append(
					TVSlide(unit: card.unit, text: "\(card.headline)\nOpen this page on your iPhone or iPad.", isPage: true))
				owner.append(index)
			}
		}
		return (slides, owner)
	}
}

/// Reads each slide aloud and tells the player when it is done, so the pacing follows the voice.
@MainActor
@Observable
final class TVNarrator: NSObject, AVSpeechSynthesizerDelegate {
	private let synthesizer = AVSpeechSynthesizer()
	private(set) var isPaused = false
	var onFinish: (() -> Void)?

	override init() {
		super.init()
		synthesizer.delegate = self
	}

	func speak(_ text: String) {
		synthesizer.stopSpeaking(at: .immediate)
		isPaused = false
		synthesizer.speak(AVSpeechUtterance(string: text))
	}

	func pause() {
		isPaused = true
		synthesizer.pauseSpeaking(at: .immediate)
	}

	func resume() {
		isPaused = false
		if !synthesizer.continueSpeaking() { onFinish?() }
	}

	func stop() {
		onFinish = nil
		synthesizer.stopSpeaking(at: .immediate)
	}

	nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
		Task { @MainActor in self.onFinish?() }
	}
}

/// The full-screen briefing: big type, segmented progress, narrated, advancing as the voice ends.
/// Left and right on the remote move between slides; Pause/Play and Close are the buttons.
struct TVBriefingPlayer: View {
	let environment: AppEnvironment
	let stories: StoriesStore
	let chief: ChiefOfStaffDesk?
	let sequence: BriefSequence
	let close: () -> Void

	@State private var narrator = TVNarrator()
	@State private var index = 0
	@State private var slides: [TVSlide] = []
	@State private var owner: [Int] = []
	@FocusState private var focus: Control?
	@State private var thread: TVThreadRoute?
	@State private var opening = false

	private enum Control { case pause, more, close }

	var body: some View {
		NavigationStack { player }
	}

	private var player: some View {
		ZStack {
			MaskinGradient.briefViewer.ignoresSafeArea()
			VStack(alignment: .leading, spacing: 36) {
				progress
				if slides.indices.contains(index) {
					Text(slides[index].unit.uppercased())
						.font(.system(size: 26, weight: .semibold, design: .monospaced))
						.foregroundStyle(MaskinPatina.viewerAccent)
					Text(slides[index].text)
						.font(.system(size: slides[index].isPage ? 56 : 52, weight: .bold))
						.foregroundStyle(MaskinColor.stFg)
						.frame(maxWidth: .infinity, alignment: .leading)
						.id(index)
				}
				Spacer(minLength: 0)
				HStack(spacing: 24) {
					Button {
						narrator.isPaused ? narrator.resume() : narrator.pause()
					} label: {
						TVCapsuleLabel(title: narrator.isPaused ? "Play" : "Pause", symbol: narrator.isPaused ? "play.fill" : "pause.fill")
					}
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
					.focused($focus, equals: .pause)
					if chief != nil {
						Button(action: tellMeMore) {
							TVCapsuleLabel(title: opening ? "Opening…" : "Tell me more", symbol: "bubble.left.fill")
						}
						.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
						.focused($focus, equals: .more)
					}
					Button(action: finish) { TVCapsuleLabel(title: "Close", symbol: "xmark") }
						.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
						.focused($focus, equals: .close)
				}
				.frame(maxWidth: 900)
			}
			.padding(.horizontal, 96)
			.padding(.vertical, 56)
		}
		.onMoveCommand { direction in
			switch direction {
			case .left: go(to: index - 1)
			case .right: go(to: index + 1)
			default: break
			}
		}
		.onExitCommand(perform: finish)
		.navigationDestination(item: $thread) { TVThread(environment: environment, conversationID: $0.id) }
		.task {
			let built = TVSlides.make(from: sequence)
			slides = built.slides
			owner = built.cardIndex
			focus = .pause
			narrator.onFinish = { advance() }
			present()
		}
		.onDisappear { narrator.stop() }
	}

	private var progress: some View {
		HStack(spacing: 8) {
			ForEach(slides.indices, id: \.self) { i in
				Capsule()
					.fill(i <= index ? MaskinPatina.viewerAccent : MaskinColor.stLab.opacity(0.35))
					.frame(height: 8)
			}
		}
		.accessibilityHidden(true)
	}

	/// Shows the current slide: marks its card seen and reads it aloud.
	private func present() {
		guard slides.indices.contains(index) else { return }
		if owner.indices.contains(index), sequence.slides.indices.contains(owner[index]) {
			stories.markSeen(sequence.slides[owner[index]])
		}
		narrator.speak(slides[index].text.replacingOccurrences(of: "\n", with: ". "))
	}

	private func go(to target: Int) {
		guard slides.indices.contains(target) else { return }
		index = target
		present()
	}

	private func advance() {
		if index + 1 < slides.count { go(to: index + 1) } else { finish() }
	}

	/// Opens a conversation with the Chief of Staff about the slide's briefing. Narration stops: the
	/// thread is where the talking happens now.
	private func tellMeMore() {
		guard let chief, !opening, slides.indices.contains(index),
			owner.indices.contains(index), sequence.slides.indices.contains(owner[index])
		else { return }
		let source = sequence.slides[owner[index]]
		opening = true
		narrator.stop()
		Task {
			defer { opening = false }
			let card = ForYouCard(id: source.id, objectTitle: source.headline)
			if let outcome = try? await ChiefOfStaffThreads.open(about: card, conversations: chief.conversations) {
				thread = TVThreadRoute(id: outcome.conversation.id)
			} else {
				narrator.onFinish = { advance() }
				present()
			}
		}
	}

	private func finish() {
		narrator.stop()
		close()
	}
}
