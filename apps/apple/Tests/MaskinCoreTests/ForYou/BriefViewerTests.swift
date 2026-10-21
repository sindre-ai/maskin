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

	@Test("prefetch looks ahead at pages only, never past the end")
	func prefetch() {
		let cards = [card("brief", loop: nil), card("a1", loop: "A"), card("a2", loop: "A"), card("a3", loop: "A")]
		let sequence = BriefSequence(slides: cards, startIndex: 0)
		#expect(sequence.pagesToPrefetch(after: 0).map(\.id) == ["a1", "a2"])
		#expect(sequence.pagesToPrefetch(after: 2).map(\.id) == ["a3"])
		#expect(sequence.pagesToPrefetch(after: 3).isEmpty)
		#expect(sequence.pagesToPrefetch(after: 0, ahead: 0).isEmpty)
	}

	@Test("a cut headline becomes the whole first sentence and the body drops it")
	func briefingText() {
		let first = "Vaerksted has ten bets in flight, led by Fix the confirmed MCP bugs and add basic annotations (batch 1), which is active with zero of six tasks done."
		let script = first + " Also moving: voice. Recently closed: articles."
		let cut = String(first.prefix(139)) + "\u{2026}"
		let text = BriefSequence.briefingText(headline: cut, script: script)
		#expect(text.title == first)
		#expect(text.body == "Also moving: voice. Recently closed: articles.")
	}

	@Test("tell-me-more quotes the whole first sentence, not the cut headline")
	func tellMeMoreFullSentence() {
		let first = String(repeating: "word ", count: 40).trimmingCharacters(in: .whitespaces) + "."
		let cut = String(first.prefix(139)) + "\u{2026}"
		let card = StoryCard(
			id: "b", unit: "Daily briefing", headline: "Good morning", updatedAt: nil,
			content: .briefing(headline: cut, script: first + " More."))
		let text = BriefSequence.tellMeMore(about: card)
		#expect(text.contains(first))
		#expect(!text.contains("\u{2026}"))
	}

	@Test("a short headline that opens the script is not repeated, and one that doesn't is left alone")
	func briefingTextOther() {
		#expect(BriefSequence.briefingText(headline: "All quiet.", script: "All quiet. Nothing to do.") == ("All quiet.", "Nothing to do."))
		#expect(BriefSequence.briefingText(headline: "All quiet.", script: "All quiet.") == ("All quiet.", ""))
		#expect(BriefSequence.briefingText(headline: "Title", script: "Something else.") == ("Title", "Something else."))
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

	@Test("a deck steps through its cards on tap, then moves to the next slide")
	func deckStepsThenAdvances() {
		var p = playback()
		p.setSteps(3)
		#expect(p.step == 0)
		p.next()
		#expect(p.index == 0 && p.step == 1)
		p.next()
		#expect(p.index == 0 && p.step == 2)
		p.next()
		#expect(p.index == 1 && p.step == 0 && p.steps == 1)
	}

	@Test("back inside a deck goes to the card before, not the previous slide")
	func deckStepsBack() {
		var p = playback()
		p.next()
		p.setSteps(4)
		p.next(); p.next()
		#expect(p.index == 1 && p.step == 2)
		p.previous()
		#expect(p.index == 1 && p.step == 1)
		p.previous()
		p.previous()
		#expect(p.index == 0 && p.steps == 1)
	}

	@Test("time turns a deck's cards, then moves on")
	func deckAdvancesOnTime() {
		var p = playback()
		p.setSteps(2)
		#expect(p.currentDuration == 2 * BriefPlayback.secondsPerStep)
		p.tick(BriefPlayback.secondsPerStep)
		#expect(p.index == 0 && p.step == 1)
		p.tick(BriefPlayback.secondsPerStep)
		#expect(p.index == 1 && p.step == 0)
	}

	@Test("the last card of the last deck finishes the viewer")
	func deckEndsViewer() {
		var p = BriefPlayback(durations: [10], autoAdvances: true)
		p.setSteps(2)
		p.next()
		#expect(!p.isFinished && p.step == 1)
		p.next()
		#expect(p.isFinished)
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
