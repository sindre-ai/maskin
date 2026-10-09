import Foundation
import Testing

@testable import MaskinCore

private func card(_ id: String, loop: String?, unit: String = "Unit", headline: String = "Head") -> StoryCard {
	if let loop {
		return StoryCard(
			id: id, unit: unit, headline: headline, updatedAt: nil,
			content: .page(LoopOutput(id: id, name: "\(id).html")), loopID: loop)
	}
	return StoryCard(
		id: id, unit: "Daily briefing", headline: "Good morning", updatedAt: nil,
		content: .briefing(headline: headline, script: "one two three"))
}

@Suite("BriefSequence")
struct BriefSequenceTests {
	@Test("the briefing leads and each loop's pages sit together")
	func grouping() {
		let cards = [
			card("a1", loop: "A"), card("b1", loop: "B"), card("brief", loop: nil), card("a2", loop: "A"),
		]
		let sequence = BriefSequence.make(cards: cards, opening: cards[1])
		#expect(sequence.slides.map(\.id) == ["brief", "a1", "a2", "b1"])
		#expect(sequence.startIndex == 3)
	}

	@Test("a card missing from the row is still opened")
	func missingOpening() {
		let extra = card("x", loop: "X")
		let sequence = BriefSequence.make(cards: [card("a1", loop: "A")], opening: extra)
		#expect(sequence.slides.count == 2)
		#expect(sequence.slides[sequence.startIndex].id == "x")
	}

	@Test("durations are bounded and tell-me-more names the slide")
	func duration() {
		#expect(BriefSequence.duration(of: card("a", loop: "A")) == 12)
		#expect(BriefSequence.duration(of: card("b", loop: nil)) == 6)
		let long = StoryCard(
			id: "l", unit: "Daily briefing", headline: "h", updatedAt: nil,
			content: .briefing(headline: "h", script: Array(repeating: "w", count: 500).joined(separator: " ")))
		#expect(BriefSequence.duration(of: long) == 24)
		#expect(BriefSequence.tellMeMore(about: card("a", loop: "A", unit: "Sales", headline: "Pipeline")).contains("\"Pipeline\" (from Sales)"))
		#expect(BriefSequence.tellMeMore(about: card("b", loop: nil, headline: "Quiet day")).contains("Quiet day"))
	}
}

@Suite("BriefPlayback")
struct BriefPlaybackTests {
	private func playback(auto: Bool = true) -> BriefPlayback {
		BriefPlayback(durations: [10, 10, 10], autoAdvances: auto)
	}

	@Test("time fills the segment, then moves on and resets")
	func advancesOnTime() {
		var p = playback()
		p.tick(5)
		#expect(p.progress == 0.5)
		#expect(p.fill(ofSegment: 0) == 0.5 && p.fill(ofSegment: 1) == 0)
		p.tick(5)
		#expect(p.index == 1 && p.progress == 0)
		#expect(p.fill(ofSegment: 0) == 1)
	}

	@Test("holding or loading stops the clock")
	func pauses() {
		var p = playback()
		p.hold()
		p.tick(20)
		#expect(p.index == 0 && p.progress == 0)
		p.release()
		p.setWaiting(true)
		p.tick(20)
		#expect(p.progress == 0)
		p.setWaiting(false)
		p.tick(2)
		#expect(p.progress == 0.2)
	}

	@Test("the last slide finishing ends the viewer; back from the end resumes it")
	func finishes() {
		var p = playback()
		p.next(); p.next()
		#expect(p.index == 2 && !p.isFinished)
		p.tick(10)
		#expect(p.isFinished && !p.isPlaying)
		p.previous()
		#expect(!p.isFinished && p.index == 1)
	}

	@Test("back on the first slide restarts it")
	func backAtStart() {
		var p = playback()
		p.tick(4)
		p.previous()
		#expect(p.index == 0 && p.progress == 0)
	}

	@Test("without auto-advance only taps move, and the current segment shows full")
	func manual() {
		var p = playback(auto: false)
		p.tick(100)
		#expect(p.index == 0)
		#expect(p.fill(ofSegment: 0) == 1 && p.fill(ofSegment: 1) == 0)
		p.next()
		#expect(p.index == 1 && p.position == "Slide 2 of 3")
	}

	@Test("empty and out-of-range input are safe")
	func edges() {
		var empty = BriefPlayback(durations: [])
		empty.tick(1); empty.next(); empty.previous()
		#expect(empty.index == 0 && !empty.isPlaying)
		#expect(BriefPlayback(durations: [5], startIndex: 9).index == 0)
		#expect(BriefSequence(slides: [], startIndex: 3).startIndex == 0)
	}
}
