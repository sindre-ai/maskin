import Foundation
import Testing

@testable import MaskinCore

actor FakeSessionLogsAPI: SessionLogsAPI {
	var all: [SessionLogRow]
	var failNext = false
	private(set) var queries: [SessionLogQuery] = []

	init(_ rows: [SessionLogRow]) { all = rows }

	func append(_ rows: [SessionLogRow]) { all += rows }
	func fail() { failNext = true }

	func logs(sessionID: String, query: SessionLogQuery) async throws -> [SessionLogRow] {
		queries.append(query)
		if failNext {
			failNext = false
			throw SessionLogsError("Couldn't load the log.")
		}
		var rows = all.sorted { $0.id < $1.id }
		if let since = query.since { rows = rows.filter { $0.id > since } }
		if let before = query.before { rows = rows.filter { $0.id < before } }
		if query.order == .descending { rows.reverse() }
		return Array(rows.prefix(query.limit))
	}
}

private func row(_ id: Int, _ stream: String = "stdout", _ content: String = "line") -> SessionLogRow {
	SessionLogRow(id: id, stream: stream, content: content)
}

private func assistant(_ text: String) -> String {
	"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"\(text)\"}]}}"
}

@Suite("SessionLogsStore")
@MainActor
struct SessionLogsStoreTests {
	@Test("loads the newest page in ascending order and notes older rows")
	func loadsNewest() async {
		let rows = (1...(SessionLogsStore.pageSize + 20)).map { row($0) }
		let store = SessionLogsStore(sessionID: "s", api: FakeSessionLogsAPI(rows))
		await store.start(live: false)
		#expect(store.phase == .loaded)
		#expect(store.rows.count == SessionLogsStore.pageSize)
		#expect(store.rows.last?.id == SessionLogsStore.pageSize + 20)
		#expect(store.rows.map(\.id) == store.rows.map(\.id).sorted())
		#expect(store.hasOlder)
	}

	@Test("loadOlder prepends earlier rows without duplicates")
	func loadOlder() async {
		let rows = (1...(SessionLogsStore.pageSize + 20)).map { row($0) }
		let store = SessionLogsStore(sessionID: "s", api: FakeSessionLogsAPI(rows))
		await store.start(live: false)
		await store.loadOlder()
		#expect(store.rows.count == SessionLogsStore.pageSize + 20)
		#expect(store.rows.first?.id == 1)
		#expect(!store.hasOlder)
	}

	@Test("a poll appends only rows newer than the last one held")
	func poll() async {
		let api = FakeSessionLogsAPI([row(1), row(2)])
		let store = SessionLogsStore(sessionID: "s", api: api)
		await store.start(live: false)
		await api.append([row(3), row(4)])
		await store.refresh()
		#expect(store.rows.map(\.id) == [1, 2, 3, 4])
		let last = await api.queries.last
		#expect(last?.since == 2)
	}

	@Test("live mode keeps following the tail on its own")
	func livePolling() async throws {
		let api = FakeSessionLogsAPI([row(1)])
		let store = SessionLogsStore(sessionID: "s", api: api, pollInterval: .milliseconds(20))
		await store.start(live: true)
		await api.append([row(2)])
		for _ in 0..<100 where store.rows.count < 2 { try await Task.sleep(for: .milliseconds(50)) }
		store.stop()
		#expect(store.rows.map(\.id) == [1, 2])
	}

	@Test("a failed first load reports; a failed poll keeps the rows and shows a notice")
	func failures() async {
		let api = FakeSessionLogsAPI([row(1)])
		await api.fail()
		let store = SessionLogsStore(sessionID: "s", api: api)
		await store.start(live: false)
		#expect(store.phase == .failed("Couldn't load the log."))
		await store.refresh()
		#expect(store.phase == .loaded)
		await api.fail()
		await store.refresh()
		#expect(store.rows.count == 1)
		#expect(store.notice != nil)
	}

	@Test("Problems keeps stderr and failed envelopes only")
	func problems() async {
		let failed = "{\"type\":\"result\",\"is_error\":true,\"result\":\"boom\"}"
		let api = FakeSessionLogsAPI([row(1), row(2, "stderr", "oops"), row(3, "stdout", failed)])
		let store = SessionLogsStore(sessionID: "s", api: api)
		await store.start(live: false)
		store.filter = .problems
		#expect(store.visibleRows.map(\.id) == [2, 3])
	}
}

@Suite("SessionLogLine")
struct SessionLogLineTests {
	@Test("assistant text and tool calls become readable lines; tool names lose prefixes")
	func assistantBlocks() {
		let content =
			"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"On it.\"},{\"type\":\"tool_use\",\"name\":\"mcp__maskin__get_objects\"}]}}"
		let lines = SessionLogLine.lines(from: row(5, "stdout", content))
		#expect(lines.map(\.text) == ["On it.", "Used get objects"])
		#expect(lines.map(\.kind) == [.agent, .tool])
		#expect(Set(lines.map(\.id)).count == 2)
	}

	@Test("tool results and usage envelopes are left out")
	func skipped() {
		#expect(SessionLogLine.lines(from: row(1, "stdout", "{\"type\":\"user\",\"message\":{}}")).isEmpty)
	}

	@Test("plain text, stderr and system rows keep their text")
	func plain() {
		#expect(SessionLogLine.lines(from: row(1, "stdout", "hello")).first?.kind == .output)
		#expect(SessionLogLine.lines(from: row(2, "stderr", "bad")).first?.kind == .error)
		#expect(SessionLogLine.lines(from: row(3, "system", "booted")).first?.kind == .system)
	}

	@Test("a failed result is an error line")
	func failedResult() {
		let line = SessionLogLine.lines(
			from: row(1, "stdout", "{\"type\":\"result\",\"is_error\":true,\"result\":\"Out of credit\"}")
		).first
		#expect(line?.kind == .error)
		#expect(line?.text == "Out of credit")
	}
}
