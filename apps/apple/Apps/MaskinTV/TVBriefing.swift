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
							.buttonStyle(TVFocusStyle(scale: 1.06, cornerRadius: 44))
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
					.font(.system(size: 24, weight: .semibold, design: .monospaced))
					.foregroundStyle(isSeen ? MaskinColor.ink5 : MaskinColor.stLab)
					.lineLimit(1)
					.padding(.horizontal, 16).padding(.vertical, 6)
					.background(MaskinSurface.fill, in: Capsule())
				Spacer(minLength: 0)
				if !isSeen { Circle().fill(MaskinColor.sig).frame(width: 14, height: 14) }
			}
			Spacer(minLength: 0)
			Text(card.headline)
				.font(.system(size: 44, weight: .bold))
				.foregroundStyle(isSeen ? MaskinColor.ink : MaskinColor.stFg)
				.multilineTextAlignment(.leading)
				.lineLimit(3)
		}
		.padding(34)
		// 480 x 260, radius 44: the TV prototype's measurements. The spec text says 460 x 290 r40 in
		// one place and 260 tall in its layout section; the prototype is the tie-breaker.
		.frame(width: 480, height: 260, alignment: .leading)
		.background(isSeen ? AnyShapeStyle(MaskinSurface.card) : AnyShapeStyle(MaskinGradient.unseenBrief),
			in: RoundedRectangle(cornerRadius: 44, style: .continuous))
	}
}

/// What one screen of the player shows.
struct TVSlide: Equatable {
	var unit: String
	var text: String
	var isPage: Bool
	var kind: TVSlideKind = .text
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
		let kinds = TVSlideClassifier.kinds(for: slides.map(\.text))
		for index in slides.indices { slides[index].kind = kinds[index] }
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

	/// Profile > Settings > "Narrate briefings". Off: slides still advance, on a short timer.
	static let narrateKey = "tv.narrateBriefings"
	private var silentAdvance: Task<Void, Never>?

	func speak(_ text: String) {
		synthesizer.stopSpeaking(at: .immediate)
		silentAdvance?.cancel()
		isPaused = false
		if UserDefaults.standard.object(forKey: Self.narrateKey) as? Bool == false {
			silentAdvance = Task { [weak self] in
				try? await Task.sleep(for: .seconds(4.5))
				if !Task.isCancelled { self?.onFinish?() }
			}
			return
		}
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
		silentAdvance?.cancel()
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
	/// The primary action offered on the last slide for the briefing it belongs to.
	var action: (StoryCard) -> TVBriefingAction? = { _ in nil }
	var onAction: (TVBriefingAction) -> Void = { _ in }
	let close: () -> Void

	@State private var narrator = TVNarrator()
	@State private var index = 0
	@State private var slides: [TVSlide] = []
	@State private var owner: [Int] = []
	@FocusState private var focus: Control?
	@State private var thread: TVThreadRoute?
	@State private var opening = false

	private enum Control { case pause, more, act, close }

	var body: some View {
		NavigationStack { player }
	}

	private var player: some View {
		ZStack {
			MaskinGradient.briefViewer.ignoresSafeArea()
			VStack(alignment: .leading, spacing: 36) {
				progress
				if slides.indices.contains(index) {
					HStack {
						Text(slides[index].unit.uppercased())
							.font(.system(size: 26, weight: .semibold, design: .monospaced))
							.foregroundStyle(MaskinColor.stFg)
							.padding(.horizontal, 22).padding(.vertical, 10)
							.background(MaskinSurface.fillStrong, in: Capsule())
						Spacer(minLength: 0)
						Text("Narrated · \(index + 1) of \(slides.count)")
							.font(.system(size: 26)).foregroundStyle(MaskinColor.ink4)
					}
					slideBody(slides[index])
						.id(index)
				}
				Spacer(minLength: 0)
				HStack(spacing: 24) {
					Button {
						narrator.isPaused ? narrator.resume() : narrator.pause()
					} label: {
						TVCapsuleLabel(title: narrator.isPaused ? "Play" : "Pause", slim: true)
					}
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
					.focused($focus, equals: .pause)
					if isLast, let act = lastAction {
						Button { finishAndAct(act) } label: {
							TVCapsuleLabel(title: act.title, prominent: true, slim: true)
						}
						.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
						.focused($focus, equals: .act)
					}
					if chief != nil {
						Button(action: tellMeMore) {
							TVCapsuleLabel(title: opening ? "Opening…" : "Tell me more", slim: true)
						}
						.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
						.focused($focus, equals: .more)
					}
					Button(action: finish) { TVCapsuleLabel(title: "Close", slim: true) }
						.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
						.focused($focus, equals: .close)
				}
				.frame(maxWidth: .infinity)
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

	private var isLast: Bool { !slides.isEmpty && index == slides.count - 1 }

	/// The action for the briefing the last slide came from.
	private var lastAction: TVBriefingAction? {
		guard let last = owner.last, sequence.slides.indices.contains(last) else { return nil }
		return action(sequence.slides[last])
	}

	/// Big figure (stat), line of text, and on the last slide the prompt to act.
	@ViewBuilder private func slideBody(_ slide: TVSlide) -> some View {
		VStack(alignment: .leading, spacing: 28) {
			if case .stat(let big, let rest) = slide.kind {
				Text(big)
					.font(.system(size: 240, weight: .bold))
					.tracking(-9.6)
					.minimumScaleFactor(0.5).lineLimit(1)
					.foregroundStyle(MaskinPatina.viewerAccent)
				bodyText(rest, size: slide.isPage ? 56 : TVSlideClassifier.textSize(for: rest))
			} else {
				bodyText(slide.text, size: slide.isPage ? 56 : TVSlideClassifier.textSize(for: slide.text))
			}
			if slide.kind == .cta, lastAction != nil {
				Text("Act now, or close to keep it for later.")
					.font(.system(size: 36)).foregroundStyle(MaskinColor.stLab)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func bodyText(_ text: String, size: CGFloat) -> some View {
		Text(text)
			.font(.system(size: size, weight: .bold))
			.foregroundStyle(MaskinColor.stFg)
			.minimumScaleFactor(0.7)
			.frame(maxWidth: 1400, alignment: .leading)
	}

	private func finishAndAct(_ act: TVBriefingAction) {
		narrator.stop()
		close()
		onAction(act)
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
		// The last slide stops: it waits for the action or Close instead of closing itself.
		if index + 1 < slides.count { go(to: index + 1) } else { focus = lastAction == nil ? .close : .act }
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
