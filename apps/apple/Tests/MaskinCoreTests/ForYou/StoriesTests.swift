import Foundation
import Testing

@testable import MaskinCore

private func page(_ id: String, _ name: String, at seconds: TimeInterval?) -> LoopOutput {
	LoopOutput(
		id: id, name: name, mimeType: "text/html", updatedAt: seconds.map { Date(timeIntervalSince1970: $0) })
}

private func summary(_ id: String, _ name: String, at seconds: TimeInterval?, mime: String = "text/html")
	-> FileSummary
{
	FileSummary(
		id: id, name: name, mimeType: mime, sizeBytes: 1,
		updatedAt: seconds.map { Date(timeIntervalSince1970: $0) })
}

private struct StubFiles: FilesRemote {
	var html: [String: String]
	/// What `GET /api/files?kind=briefing` returns: the server has already dropped every other file.
	var briefingFiles: [FileSummary] = []
	func briefings(limit: Int) async throws -> [FileSummary] { briefingFiles }
	func file(id: String) async throws -> FileDetail {
		guard let text = html[id] else { throw FileError("gone") }
		return FileDetail(id: id, name: id, mimeType: "text/html", sizeBytes: text.count, data: Data(text.utf8))
	}
	func saveAnnotations(fileId: String, annotations: [FileAnnotation], idempotencyKey: String) async throws
		-> [FileAnnotation]
	{ annotations }
}

/// Fails the first download of one file, then behaves: the shape of a request lost in a burst.
private actor FlakyFiles: FilesRemote {
	let html: [String: String]
	let flaky: String
	let briefingFiles: [FileSummary]
	private var failed = false
	init(html: [String: String], flaky: String, briefingFiles: [FileSummary]) {
		self.html = html
		self.flaky = flaky
		self.briefingFiles = briefingFiles
	}
	func briefings(limit: Int) async throws -> [FileSummary] { briefingFiles }
	func file(id: String) async throws -> FileDetail {
		if id == flaky, !failed {
			failed = true
			throw FileError("lost")
		}
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
		let items = [
			summary("1", "old.html", at: 100),
			summary("2", "deck.pdf", at: 900, mime: "application/pdf"),
			summary("3", "new.html", at: 300),
			summary("1", "old.html", at: 100),
			summary("4", "undated.html", at: nil),
		]
		#expect(StoryDerivation.pages(from: items).map(\.id) == ["3", "1", "4"])
		let many = (0..<30).map { summary("p\($0)", "p.html", at: TimeInterval($0)) }
		let capped = StoryDerivation.pages(from: many)
		#expect(capped.count == StoryDerivation.maxPages)
		#expect(capped.first?.id == "p29")
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
	/// Loop `l1` holds two briefings (a, b) and a notes file (c) that is not one. `d` is a briefing the
	/// Chief of Staff wrote, held by no loop. The server's list has only the briefings.
	private func store(
		brief: SpokenBrief? = nil,
		seen: SeenStories = SeenStories(defaults: defaults())
	) async -> StoriesStore {
		let api = FakeLoopsAPI([loopRow("l1", name: "Market & Competitors")])
		await api.setOverview(
			LoopOverview(
				members: [], posts: [],
				outputs: [
					page("a", "scan.html", at: 100), page("b", "plan.html", at: 200),
					page("c", "notes.html", at: 250),
				], statusOrder: []))
		let files = StubFiles(
			html: [
				"a": "<title>Competitor scan</title>", "b": "<h1>Plan</h1>", "c": "<h1>Notes</h1>",
				"d": "<title>Two bets need you</title>",
			],
			briefingFiles: [
				summary("a", "scan.html", at: 100), summary("b", "plan.html", at: 200),
				summary("d", "briefing.html", at: 300),
			])
		return StoriesStore(
			loops: api, files: files, briefing: brief.map { StubBrief(result: $0) }, seen: seen,
			readerName: { "Sam Lee" }, now: { Date(timeIntervalSince1970: 8 * 3600) })
	}

	@Test("only briefings are stories, newest first; a loop's other files are left out")
	func cards() async {
		let s = await store()
		await s.load()
		#expect(s.cards.map(\.id) == ["d", "b", "a"])
		#expect(s.cards[0].headline == "Two bets need you")
		#expect(s.cards[1].unit == "Market & Competitors")
		#expect(s.cards[1].headline == "Plan")
		#expect(s.cards[2].headline == "Competitor scan")
	}

	@Test("a briefing no loop holds is the Chief of Staff's; a loop's carries the loop")
	func origin() async {
		let s = await store()
		await s.load()
		#expect(s.cards[0].unit == StoryCard.chiefOfStaffUnit)
		#expect(s.cards[0].loopID == nil)
		#expect(s.cards[0].isFromChiefOfStaff)
		#expect(s.cards[1].loopID == "l1")
		#expect(!s.cards[1].isFromChiefOfStaff)
		#expect(s.cards[0].byline == "Chief of Staff")
		#expect(s.cards[1].byline == "Market & Competitors")
	}

	@Test("the spoken briefing is no longer in the row unless a client asks for it (the TV does)")
	func spokenBriefingIsOptIn() async {
		let without = await store()
		await without.load()
		#expect(!without.cards.contains { $0.isBriefing })
		let tv = await store(brief: SpokenBrief(headline: "Two things", script: "Hello"))
		await tv.load()
		#expect(tv.cards.first?.id == "briefing")
		#expect(tv.cards.dropFirst().map(\.id) == ["d", "b", "a"])
	}

	@Test("the files downloaded for headlines are kept, so opening a page doesn't fetch it again")
	func keepsDownloadedFiles() async {
		let s = await store()
		await s.load()
		#expect(s.preloadedFile(for: "b")?.text == "<h1>Plan</h1>")
		#expect(s.preloadedFile(for: "a")?.text == "<title>Competitor scan</title>")
		#expect(s.preloadedFile(for: "c") == nil)
	}

	@Test("a load that lost a request is partial, and loadCompletely retries until the row is whole")
	func retriesAPartialLoad() async {
		let api = FakeLoopsAPI([loopRow("l1", name: "Market")])
		await api.setOverview(
			LoopOverview(members: [], posts: [], outputs: [page("a", "scan.html", at: 100)], statusOrder: []))
		let s = StoriesStore(
			loops: api,
			files: FlakyFiles(
				html: ["a": "<title>Competitor scan</title>"], flaky: "a",
				briefingFiles: [summary("a", "scan.html", at: 100)]),
			briefing: nil, seen: SeenStories(defaults: defaults()))
		await s.load()
		#expect(s.isPartial)
		#expect(s.cards.first?.headline == "scan")
		await s.loadCompletely(pause: .zero)
		#expect(!s.isPartial)
		#expect(s.cards.first?.headline == "Competitor scan")
	}

	@Test("a clean load is not partial")
	func cleanLoad() async {
		let s = await store()
		await s.load()
		#expect(!s.isPartial)
	}

	@Test("a loop's own cards are its briefings, never the Chief of Staff's or another loop's")
	func cardsForLoop() async {
		let s = await store()
		#expect(!s.hasLoaded)
		await s.load()
		#expect(s.hasLoaded)
		#expect(s.cards(forLoop: "l1").map(\.id) == ["b", "a"])
		#expect(s.cards(forLoop: "other").isEmpty)
	}

	@Test("the row shows unseen cards first and moves a card to the end once it is opened")
	func rowOrder() async {
		let s = await store()
		await s.load()
		#expect(s.rowCards.map(\.id) == ["d", "b", "a"])
		s.markSeen(s.cards[0])
		#expect(s.rowCards.map(\.id) == ["b", "a", "d"])
		#expect(s.cards.map(\.id) == ["d", "b", "a"])  // the stored order is untouched
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
		#expect(briefing(words: 40).formatLabel == "1 MIN READ")
	}

	@Test func longerBriefingRoundsUp() {
		#expect(briefing(words: 450).formatLabel == "3 MIN READ")
	}

	@Test func pageIsLabelledABriefing() {
		let card = StoryCard(
			id: "p", unit: "Sales", headline: "Pipeline", updatedAt: nil,
			content: .page(LoopOutput(id: "f", name: "pipeline.html")))
		#expect(card.formatLabel == "BRIEFING")
	}
}
