import Foundation

/// The ordered slides of the full-screen brief viewer. A slide is a story card: a loop's HTML
/// page, or the daily briefing as text. Pure, so the order is tested without a view.
public struct BriefSequence: Equatable, Sendable {
	public let slides: [StoryCard]
	/// The slide the reader tapped.
	public let startIndex: Int

	public init(slides: [StoryCard], startIndex: Int) {
		self.slides = slides
		self.startIndex = slides.isEmpty ? 0 : min(max(startIndex, 0), slides.count - 1)
	}

	/// The daily briefing first, then each loop's pages together (loops in the order their newest
	/// page appears, pages newest first), so a loop's pages read as its brief. Opens on `opening`.
	public static func make(cards: [StoryCard], opening: StoryCard) -> BriefSequence {
		var all = cards
		if !all.contains(where: { $0.id == opening.id }) { all.insert(opening, at: 0) }
		let briefing = all.filter { $0.loopID == nil }
		var loopOrder: [String] = []
		for card in all {
			if let loop = card.loopID, !loopOrder.contains(loop) { loopOrder.append(loop) }
		}
		let grouped = loopOrder.flatMap { loop in all.filter { $0.loopID == loop } }
		let slides = briefing + grouped
		return BriefSequence(slides: slides, startIndex: slides.firstIndex { $0.id == opening.id } ?? 0)
	}

	/// How long a slide stays before the viewer moves on by itself: a text slide by its length,
	/// a page a fixed while (it is read, not skimmed).
	public static func duration(of card: StoryCard) -> TimeInterval {
		switch card.content {
		case .page: return 12
		case .briefing(let headline, let script):
			let words = (headline + " " + script).split(whereSeparator: \.isWhitespace).count
			return min(max(Double(words) / 3.0, 6), 24)
		}
	}

	/// What "Tell me more" sends the Chief of Staff: the agent reads only the text, so it names the slide.
	public static func tellMeMore(about card: StoryCard) -> String {
		switch card.content {
		case .briefing(let headline, _): "Tell me more about today's briefing: \"\(headline)\". "
		case .page: "Tell me more about \"\(card.headline)\" (from \(card.unit)). "
		}
	}
}

/// Where the viewer is: which slide, how far through it, and whether it is held. Time comes in
/// as `tick(_:)` so the whole state machine is tested without a clock.
public struct BriefPlayback: Equatable, Sendable {
	public let durations: [TimeInterval]
	public private(set) var index: Int
	/// 0...1 through the current slide.
	public private(set) var progress: Double = 0
	/// A finger is holding the slide.
	public private(set) var isHeld = false
	/// The slide is still loading: the clock waits for it.
	public private(set) var isWaiting = false
	/// Set when the last slide ends or the reader moves past it.
	public private(set) var isFinished = false
	/// Off with Reduce Motion or VoiceOver: slides then change only when the reader asks.
	public var autoAdvances: Bool

	public init(durations: [TimeInterval], startIndex: Int = 0, autoAdvances: Bool = true) {
		self.durations = durations.map { max($0, 1) }
		self.index = durations.isEmpty ? 0 : min(max(startIndex, 0), durations.count - 1)
		self.autoAdvances = autoAdvances
	}

	public var count: Int { durations.count }
	public var isPlaying: Bool { autoAdvances && !isHeld && !isWaiting && !isFinished && count > 0 }

	/// 0...1 for segment `segment`: full before the current slide, empty after it. With no
	/// auto-advance the current segment shows full, since it has no clock to fill.
	public func fill(ofSegment segment: Int) -> Double {
		if segment < index { return 1 }
		if segment > index { return 0 }
		return autoAdvances ? progress : 1
	}

	public mutating func tick(_ seconds: TimeInterval) {
		guard isPlaying, seconds > 0 else { return }
		progress += seconds / durations[index]
		if progress >= 1 { next() }
	}

	/// Next slide; past the last one the viewer is finished.
	public mutating func next() {
		guard count > 0 else { return }
		if index >= count - 1 {
			progress = 1
			isFinished = true
		} else {
			index += 1
			progress = 0
		}
	}

	/// Previous slide; on the first one it restarts that slide.
	public mutating func previous() {
		guard count > 0 else { return }
		isFinished = false
		index = max(index - 1, 0)
		progress = 0
	}

	public mutating func hold() { isHeld = true }
	public mutating func release() { isHeld = false }
	public mutating func setWaiting(_ waiting: Bool) { isWaiting = waiting }

	/// "Slide 2 of 5", for VoiceOver.
	public var position: String { "Slide \(index + 1) of \(count)" }
}
