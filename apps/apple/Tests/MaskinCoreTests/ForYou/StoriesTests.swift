import Foundation
import Testing

@testable import MaskinCore

private func page(_ id: String, _ name: String, at seconds: TimeInterval?) -> LoopOutput {
	LoopOutput(
		id: id, name: name, mimeType: "text/html", updatedAt: seconds.map { Date(timeIntervalSince1970: $0) })
}

private struct StubFiles: FilesRemote {
	var html: [String: String]
	func file(id: String) async throws -> FileDetail {
		guard let text = html[id] else { throw FileError("gone") }
		return FileDetail(id: id, name: id, mimeType: "text/html", sizeBytes: text.count, data: Data(text.utf8))
	}
	func saveAnnotations(fileId: String, annotations: [FileAnnotation], idempotencyKey: String) async throws
		-> [FileAnnotation]
	{ annotations }
}

private struct StubBrief: SpokenBriefing {
	var result: SpokenBrief?
	func spokenBrief() async throws -> SpokenBrief {
		guard let result else { throw URLError(.notConnectedToInternet) }
		return result
	}
}

private func defaults() -> UserDefaults {
	let name = "stories-\(UUID().uuidString)"
	let d = UserDefaults(suiteName: name)!
	d.removePersistentDomain(forName: name)
	return d
}

@Suite("StoryDerivation")
struct StoryDerivationTests {
	@Test("the title wins, then the first h1, then the file name")
	func headlines() {
		#expect(StoryDerivation.headline(html: "<html><head><title> Q3 &amp; beyond </title></head><h1>Other</h1>", fileName: "x.html") == "Q3 & beyond")
		#expect(StoryDerivation.headline(html: "<body><H1 class='a'>1 of 10 <em>orgs</em>\n paying</H1>", fileName: "x.html") == "1 of 10 orgs paying")
		#expect(StoryDerivation.headline(html: "<body>no heading</body>", fileName: "market_scan-final.html") == "market scan final")
		#expect(StoryDerivation.headline(html: nil, fileName: "brief.html") == "brief")
		#expect(StoryDerivation.headline(html: "<title>  </title>", fileName: "a-b.html") == "a b")
	}

	@Test("only HTML pages count, each file once, newest first, undated last, capped")
	func ordering() {
		let items: [(loop: String, output: LoopOutput)] = [
			("A", page("1", "old.html", at: 100)),
			("A", LoopOutput(id: "2", name: "deck.pdf", mimeType: "application/pdf", updatedAt: Date(timeIntervalSince1970: 900))),
			("B", page("3", "new.html", at: 300)),
			("B", page("1", "old.html", at: 100)),
			("B", page("4", "undated.html", at: nil)),
		]
		#expect(StoryDerivation.pages(from: items).map(\.output.id) == ["3", "1", "4"])
		let many = (0..<30).map { ("L", page("p\($0)", "p.html", at: TimeInterval($0))) }
		let capped = StoryDerivation.pages(from: many)
		#expect(capped.count == StoryDerivation.maxPages)
		#expect(capped.first?.output.id == "p29")
	}

	@Test("the greeting follows the hour and uses the first name")
	func greeting() {
		var cal = Calendar(identifier: .gregorian)
		cal.timeZone = TimeZone(secondsFromGMT: 0)!
		func at(_ hour: Int) -> Date { Date(timeIntervalSince1970: TimeInterval(hour * 3600)) }
		#expect(StoryDerivation.greeting(name: "Sam Lee", now: at(8), calendar: cal) == "Good morning, Sam")
		#expect(StoryDerivation.greeting(name: nil, now: at(14), calendar: cal) == "Good afternoon")
		#expect(StoryDerivation.greeting(name: "Sam", now: at(20), calendar: cal) == "Good evening, Sam")
	}
}

@Suite("StoriesStore")
@MainActor
struct StoriesStoreTests {
	private func store(
		brief: SpokenBrief? = SpokenBrief(headline: "Two things", script: "Hello"),
		seen: SeenStories = SeenStories(defaults: defaults())
	) async -> StoriesStore {
		let api = FakeLoopsAPI([loopRow("l1", name: "Market & Competitors")])
		await api.setOverview(
			LoopOverview(
				members: [], posts: [],
				outputs: [page("a", "scan.html", at: 100), page("b", "plan.html", at: 200)], statusOrder: []))
		return StoriesStore(
			loops: api, files: StubFiles(html: ["a": "<title>Competitor scan</title>", "b": "<h1>Plan</h1>"]),
			briefing: StubBrief(result: brief), seen: seen, readerName: { "Sam Lee" },
			now: { Date(timeIntervalSince1970: 8 * 3600) })
	}

	@Test("the briefing leads, then pages newest first, labelled with the loop")
	func cards() async {
		let s = await store()
		await s.load()
		#expect(s.cards.map(\.id) == ["briefing", "b", "a"])
		#expect(s.cards[0].headline.hasPrefix("Good"))
		#expect(s.cards[0].headline.hasSuffix(", Sam"))
		#expect(s.cards[1].unit == "Market & Competitors")
		#expect(s.cards[1].headline == "Plan")
		#expect(s.cards[2].headline == "Competitor scan")
	}

	@Test("a loop's own cards are the pages it produced, never the briefing or another loop's")
	func cardsForLoop() async {
		let s = await store()
		#expect(!s.hasLoaded)
		await s.load()
		#expect(s.hasLoaded)
		#expect(s.cards(forLoop: "l1").map(\.id) == ["b", "a"])
		#expect(s.cards(forLoop: "other").isEmpty)
		#expect(s.cards.first { $0.id == "briefing" }?.loopID == nil)
	}

	@Test("a briefing that fails to load is left out; the pages still show")
	func briefingFails() async {
		let s = await store(brief: nil)
		await s.load()
		#expect(s.cards.map(\.id) == ["b", "a"])
	}

	@Test("opening a card marks it seen, and a new store remembers it")
	func seenState() async {
		let d = defaults()
		let s = await store(seen: SeenStories(defaults: d))
		await s.load()
		#expect(s.cards.allSatisfy { !s.isSeen($0) })
		s.markSeen(s.cards[1])
		#expect(s.isSeen(s.cards[1]))
		#expect(!s.isSeen(s.cards[2]))
		let again = await store(seen: SeenStories(defaults: d))
		await again.load()
		#expect(again.isSeen(again.cards[1]))
	}

	@Test("a page edited after it was seen is unseen again")
	func editedPageIsUnseen() {
		let seen = SeenStories(defaults: defaults())
		let old = StoryCard(id: "a", unit: "L", headline: "h", updatedAt: Date(timeIntervalSince1970: 1), content: .page(page("a", "a.html", at: 1)))
		var edited = old
		edited.updatedAt = Date(timeIntervalSince1970: 2)
		seen.markSeen(old)
		#expect(seen.isSeen(old))
		#expect(!seen.isSeen(edited))
	}
}

@Suite("StoryCard format label")
struct StoryCardFormatLabelTests {
	private func briefing(words: Int) -> StoryCard {
		StoryCard(
			id: "b", unit: "Daily briefing", headline: "Hi", updatedAt: nil,
			content: .briefing(headline: "Hi", script: Array(repeating: "word", count: words).joined(separator: " ")))
	}

	@Test func shortBriefingReadsInOneMinute() {
		#expect(briefing(words: 40).formatLabel == "READ \u{00B7} 1 MIN")
	}

	@Test func longerBriefingRoundsUp() {
		#expect(briefing(words: 450).formatLabel == "READ \u{00B7} 3 MIN")
	}

	@Test func pageIsLabelledAPage() {
		let card = StoryCard(
			id: "p", unit: "Sales", headline: "Pipeline", updatedAt: nil,
			content: .page(LoopOutput(id: "f", name: "pipeline.html")))
		#expect(card.formatLabel == "PAGE")
	}
}
