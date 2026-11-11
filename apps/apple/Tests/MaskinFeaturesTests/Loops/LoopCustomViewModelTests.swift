import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

private let openSpec = JSONValue.object(["type": .string("task")])
private let doneSpec = JSONValue.object(["type": .string("task"), "status": .string("done")])

private func page(sources: String? = #"{"open":{"type":"task"},"done":{"type":"task","status":"done"}}"#)
	-> String
{
	let block = sources.map { #"<script id="maskin-sources" type="application/json">\#($0)</script>"# } ?? ""
	return "<!doctype html><html><head><title>t</title></head><body><p>Hello view</p>\(block)</body></html>"
}

private func html(_ text: String, mimeType: String = "text/html") -> FileDetail {
	FileDetail(id: "f1", name: "view", mimeType: mimeType, sizeBytes: text.count, data: Data(text.utf8))
}

/// Hands out one file, or fails; switchable between calls so Try again can be tested.
private actor ScriptedFiles: FilesRemote {
	private var detail: FileDetail?
	private(set) var reads = 0
	init(_ detail: FileDetail?) { self.detail = detail }
	func set(_ detail: FileDetail?) { self.detail = detail }
	func file(id: String) async throws -> FileDetail {
		reads += 1
		guard let detail else { throw FileError("offline", isOffline: true) }
		return detail
	}
}

/// Answers each query by its canonical text and keeps a log of what was asked.
private actor ScriptedQueries: LoopDataQuerying {
	private var answers: [String: JSONValue] = [:]
	private var failing: [String: String?] = [:]
	private(set) var asked: [String] = []

	init(_ answers: [(JSONValue, JSONValue)] = []) {
		for (spec, answer) in answers { self.answers[LoopViewBridge.canonical(spec)] = answer }
	}

	func set(_ spec: JSONValue, to answer: JSONValue) {
		let key = LoopViewBridge.canonical(spec)
		answers[key] = answer
		failing[key] = nil
	}

	/// The next asks of `spec` fail, with `message` as the words a page may be told (nil: a plain failure).
	func fail(_ spec: JSONValue, message: String? = nil) {
		failing[LoopViewBridge.canonical(spec)] = .some(message)
	}

	func run(_ spec: JSONValue) async throws -> JSONValue {
		let key = LoopViewBridge.canonical(spec)
		asked.append(key)
		if let failure = failing[key] {
			if let message = failure { throw LoopViewError(message) }
			throw FileError("boom")
		}
		return answers[key] ?? .null
	}
}

private final class TestClock: @unchecked Sendable {
	private let lock = NSLock()
	private var current: Date
	init(_ start: Date) { current = start }
	var now: Date { lock.withLock { current } }
	func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

@MainActor
@Suite("Loop custom view model")
struct LoopCustomViewModelTests {
	private let start = Date(timeIntervalSince1970: 1_800_000_000)

	private func make(
		files: ScriptedFiles, queries: ScriptedQueries = ScriptedQueries(), clock: TestClock? = nil
	) -> LoopCustomViewModel {
		let clock = clock ?? TestClock(start)
		return LoopCustomViewModel(fileID: "f1", files: files, queries: queries, now: { clock.now })
	}

	/// A model that has loaded the two-source page, with the page having asked for `open`.
	private func ready(
		queries: ScriptedQueries, clock: TestClock? = nil, askFor names: [String] = ["open"]
	) async -> LoopCustomViewModel {
		let model = make(files: ScriptedFiles(html(page())), queries: queries, clock: clock)
		await model.load()
		for name in names { _ = await model.answer(name: name) }
		return model
	}

	// MARK: First load

	@Test("first load shows the page under the platform policy")
	func firstLoad() async {
		let queries = ScriptedQueries()
		let model = make(files: ScriptedFiles(html(page())), queries: queries)
		#expect(model.phase == .loading)
		#expect(model.document == nil)

		await model.load()

		#expect(model.phase == .ready)
		#expect(model.generation == 1)
		#expect(model.document?.contains("Hello view") == true)
		#expect(model.document?.contains("Content-Security-Policy") == true)
		#expect(model.updatedAt == nil)
		#expect(model.height == LoopCustomViewModel.minHeight)
		#expect(await queries.asked.isEmpty)
	}

	@Test("a view with no sources block is a valid view with no data")
	func noSources() async {
		let model = make(files: ScriptedFiles(html(page(sources: nil))))
		await model.load()
		#expect(model.phase == .ready)
		guard case .error = await model.answer(name: "open") else {
			Issue.record("a name nobody declared must not be answered")
			return
		}
	}

	@Test("a charset on the file type is still an HTML page")
	func charset() async {
		let model = make(files: ScriptedFiles(html(page(), mimeType: "text/html; charset=utf-8")))
		await model.load()
		#expect(model.phase == .ready)
	}

	// MARK: Load failures and Try again

	@Test("a failed read says so in plain words and shows no page")
	func readFails() async {
		let model = make(files: ScriptedFiles(nil))
		await model.load()
		#expect(model.phase == .failed("Couldn't load this view. Check your connection and try again."))
		#expect(model.document == nil)
	}

	@Test("Try again loads the page once the file can be read, and starts the numbers over")
	func tryAgain() async {
		let files = ScriptedFiles(nil)
		let queries = ScriptedQueries([(openSpec, .number(4))])
		let model = make(files: files, queries: queries)
		await model.load()
		#expect(model.phase != .ready)

		await files.set(html(page()))
		await model.load()

		#expect(model.phase == .ready)
		#expect(model.generation == 1)
		#expect(model.document != nil)
		#expect(model.refreshFailed == false)
		#expect(model.queryFailed == false)
		#expect(model.updatedAt == nil)
	}

	@Test("Try again on a loaded view clears the old notes and loads a fresh page")
	func reloadClearsNotes() async {
		let queries = ScriptedQueries([(openSpec, .number(4))])
		let model = await ready(queries: queries)
		await queries.fail(openSpec)
		await model.refresh()
		#expect(model.refreshFailed)

		await model.load()

		#expect(model.phase == .ready)
		#expect(model.generation == 2)
		#expect(model.refreshFailed == false)
		#expect(model.updatedAt == nil)
	}

	@Test("a file that is not an HTML page is refused")
	func notHTML() async {
		let model = make(files: ScriptedFiles(html("%PDF", mimeType: "application/pdf")))
		await model.load()
		#expect(model.phase == .failed("This view's file is not an HTML page."))
		#expect(model.document == nil)
	}

	@Test("a file that is not text is refused")
	func notText() async {
		let bytes = FileDetail(
			id: "f1", name: "view", mimeType: "text/html", sizeBytes: 2, data: Data([0xFF, 0xFE]))
		let model = make(files: ScriptedFiles(bytes))
		await model.load()
		#expect(model.phase == .failed("This view's file could not be read."))
	}

	@Test("a sources block that is not JSON is refused with the reason")
	func badSources() async {
		let model = make(files: ScriptedFiles(html(page(sources: "{nope"))))
		await model.load()
		#expect(model.phase == .failed("The maskin-sources block is not valid JSON."))
		#expect(model.document == nil)
	}

	// MARK: The page's questions

	@Test("a declared question is answered and the time of the answer is shown")
	func answers() async {
		let clock = TestClock(start)
		let queries = ScriptedQueries([(openSpec, .number(4))])
		let model = await ready(queries: queries, clock: clock, askFor: [])

		let reply = await model.answer(name: "open")

		#expect(reply == .data(.number(4)))
		#expect(model.updatedAt == start)
		#expect(model.queryFailed == false)
	}

	@Test("the oldest answer on screen is the one dated")
	func oldestAnswerDated() async {
		let clock = TestClock(start)
		let queries = ScriptedQueries([(openSpec, .number(4)), (doneSpec, .number(1))])
		let model = await ready(queries: queries, clock: clock, askFor: ["open"])
		clock.advance(10)
		_ = await model.answer(name: "done")
		#expect(model.updatedAt == start)
	}

	@Test("a question the page never declared is refused and never reaches the server")
	func undeclared() async {
		let queries = ScriptedQueries()
		let model = await ready(queries: queries, askFor: [])

		let reply = await model.answer(name: "secret")

		guard case .error = reply else {
			Issue.record("expected an error reply")
			return
		}
		#expect(model.queryFailed == false)
		#expect(await queries.asked.isEmpty)
	}

	@Test("a failed question tells the page and raises the note")
	func questionFails() async {
		let queries = ScriptedQueries()
		await queries.fail(openSpec)
		let model = await ready(queries: queries, askFor: [])

		let reply = await model.answer(name: "open")

		#expect(reply == .error("The query failed."))
		#expect(model.queryFailed)
	}

	@Test("a failure with words of its own passes them to the page")
	func questionFailsWithWords() async {
		let queries = ScriptedQueries()
		await queries.fail(openSpec, message: "Sign in again to see this view.")
		let model = await ready(queries: queries, askFor: [])
		#expect(await model.answer(name: "open") == .error("Sign in again to see this view."))
	}

	@Test("an answer cut at the server's limit is marked partial")
	func partialAnswer() async {
		let queries = ScriptedQueries([
			(openSpec, .object(["rows_truncated": .bool(true)])),
			(doneSpec, .object(["groups_truncated": .bool(true)])),
		])
		let rows = await ready(queries: queries, askFor: ["open"])
		#expect(rows.partial)
		let groups = await ready(queries: queries, askFor: ["done"])
		#expect(groups.partial)
	}

	@Test("a whole answer is not marked partial")
	func wholeAnswer() async {
		let queries = ScriptedQueries([(openSpec, .object(["rows_truncated": .bool(false)]))])
		let model = await ready(queries: queries)
		#expect(model.partial == false)
	}

	// MARK: Staying current

	@Test("the tab checks for new numbers every 30 seconds")
	func interval() {
		#expect(LoopCustomViewModel.refreshEvery == .seconds(30))
	}

	@Test("a refresh asks nothing before the page has asked for anything")
	func refreshBeforeAsking() async {
		let queries = ScriptedQueries([(openSpec, .number(4))])
		let model = await ready(queries: queries, askFor: [])

		await model.refresh()

		#expect(await queries.asked.isEmpty)
		#expect(model.generation == 1)
		#expect(model.updatedAt == nil)
	}

	@Test("a refresh asks only what the page asked for")
	func refreshAsksWhatWasAsked() async {
		let queries = ScriptedQueries([(openSpec, .number(4)), (doneSpec, .number(1))])
		let model = await ready(queries: queries, askFor: ["open"])
		await model.refresh()
		let asked = await queries.asked
		#expect(asked == [LoopViewBridge.canonical(openSpec), LoopViewBridge.canonical(openSpec)])
	}

	@Test("two names for one query are asked once per refresh")
	func refreshAsksOnce() async {
		let same = #"{"a":{"type":"task"},"b":{"type":"task"}}"#
		let queries = ScriptedQueries([(openSpec, .number(4))])
		let model = make(files: ScriptedFiles(html(page(sources: same))), queries: queries)
		await model.load()
		_ = await model.answer(name: "a")
		_ = await model.answer(name: "b")
		let before = await queries.asked.count

		await model.refresh()

		#expect(await queries.asked.count == before + 1)
	}

	@Test("numbers that did not move leave the page alone and move the date")
	func refreshUnchanged() async {
		let clock = TestClock(start)
		let queries = ScriptedQueries([(openSpec, .number(4))])
		let model = await ready(queries: queries, clock: clock)
		let page = model.document
		clock.advance(30)

		await model.refresh()

		#expect(model.generation == 1)
		#expect(model.document == page)
		#expect(model.refreshFailed == false)
		#expect(model.updatedAt == start.addingTimeInterval(30))
	}

	@Test("a number that moved replaces the page, and the new page gets that number as it is")
	func refreshChanged() async {
		let queries = ScriptedQueries([(openSpec, .number(4))])
		let model = await ready(queries: queries)
		await queries.set(openSpec, to: .number(5))

		await model.refresh()

		#expect(model.generation == 2)
		let askedByRefresh = await queries.asked.count

		// The fresh page asks again and is handed the answer the refresh already found.
		#expect(await model.answer(name: "open") == .data(.number(5)))
		#expect(await queries.asked.count == askedByRefresh)

		// That answer is now what is on screen, so the same number moves nothing.
		await model.refresh()
		#expect(model.generation == 2)
	}

	@Test("a new page drops the notes about the old one")
	func refreshChangedClearsNotes() async {
		let queries = ScriptedQueries([
			(openSpec, .object(["rows_truncated": .bool(true), "total": .number(1)]))
		])
		await queries.fail(doneSpec)
		let model = await ready(queries: queries, askFor: ["open", "done"])
		#expect(model.partial)
		#expect(model.queryFailed)

		await queries.set(openSpec, to: .object(["total": .number(2)]))
		await model.refresh()

		#expect(model.generation == 2)
		#expect(model.partial == false)
		#expect(model.queryFailed == false)
	}

	@Test("a failed refresh keeps the page on screen and says the numbers may be old")
	func refreshFails() async {
		let queries = ScriptedQueries([(openSpec, .number(4))])
		let model = await ready(queries: queries)
		let page = model.document
		await queries.fail(openSpec)

		await model.refresh()

		#expect(model.phase == .ready)
		#expect(model.document == page)
		#expect(model.generation == 1)
		#expect(model.refreshFailed)
	}

	@Test("the next refresh that works clears the note")
	func refreshRecovers() async {
		let queries = ScriptedQueries([(openSpec, .number(4))])
		let model = await ready(queries: queries)
		await queries.fail(openSpec)
		await model.refresh()
		#expect(model.refreshFailed)

		await queries.set(openSpec, to: .number(4))
		await model.refresh()

		#expect(model.refreshFailed == false)
		#expect(model.generation == 1)
	}

	@Test("a refresh does nothing while the view is not showing a page")
	func refreshNotReady() async {
		let queries = ScriptedQueries([(openSpec, .number(4))])
		let model = make(files: ScriptedFiles(nil), queries: queries)
		await model.refresh()
		await model.load()
		await model.refresh()
		#expect(await queries.asked.isEmpty)
		#expect(model.generation == 0)
	}

	// MARK: Size and web process

	@Test("the view is never drawn smaller than its minimum, and rounds up")
	func size() async {
		let model = await ready(queries: ScriptedQueries(), askFor: [])
		model.sizeChanged(10)
		#expect(model.height == LoopCustomViewModel.minHeight)
		model.sizeChanged(300.2)
		#expect(model.height == 301)
	}

	@Test("a stopped web process loads the same page again, but only when there is a page")
	func reload() async {
		let model = make(files: ScriptedFiles(html(page())))
		model.reload()
		#expect(model.generation == 0)
		await model.load()
		model.reload()
		#expect(model.generation == 2)
	}
}
