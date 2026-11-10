import Foundation
import Testing

@testable import MaskinCore

@Suite("Loop view bridge")
struct LoopViewBridgeTests {
	private func spec(_ type: String) -> JSONValue {
		.object(["scope": .string("workspace"), "type": .string(type)])
	}

	// MARK: Messages

	private func parse(_ body: [String: Any]) -> LoopViewBridge.Message? { LoopViewBridge.parse(body) }

	@Test("a query message needs a whole-number id and a name")
	func queryMessage() {
		#expect(
			parse(["type": "maskin:bridge:query", "id": NSNumber(value: 3), "name": "tasks"])
				== .query(id: 3, name: "tasks"))
		#expect(parse(["type": "maskin:bridge:query", "id": NSNumber(value: 1.5), "name": "tasks"]) == nil)
		#expect(parse(["type": "maskin:bridge:query", "id": "3", "name": "tasks"]) == nil)
		#expect(parse(["type": "maskin:bridge:query", "id": NSNumber(value: 3)]) == nil)
		#expect(parse(["type": "maskin:bridge:query", "id": NSNumber(value: 3), "name": 7]) == nil)
	}

	@Test("a size message needs a positive height")
	func sizeMessage() {
		#expect(
			parse([
				"type": "maskin:viewer:doc-size", "h": NSNumber(value: 480), "w": NSNumber(value: 900),
				"cw": NSNumber(value: 390),
			]) == .size(height: 480, width: 900, clientWidth: 390))
		#expect(parse(["type": "maskin:viewer:doc-size", "h": NSNumber(value: 0)]) == nil)
		#expect(parse(["type": "maskin:viewer:doc-size"]) == nil)
	}

	@Test("anything else the page posts is ignored")
	func other() {
		#expect(LoopViewBridge.parse("hello") == nil)
		#expect(parse(["type": "maskin:bridge:result", "id": NSNumber(value: 1)]) == nil)
		#expect(parse(["name": "tasks"]) == nil)
		#expect(LoopViewBridge.parse(NSNull()) == nil)
	}

	// MARK: Answers

	@Test("only declared names are answered, with the query the view declared")
	func declaredOnly() async {
		let declared = spec("task")
		let ran = Ran()
		let ok = await LoopViewBridge.answer(name: "tasks", sources: ["tasks": declared]) { s in
			await ran.add(s)
			return .object(["total": .object(["count": .number(4)])])
		}
		#expect(ok == .data(.object(["total": .object(["count": .number(4)])])))
		#expect(await ran.specs == [declared])

		let refused = await LoopViewBridge.answer(name: "secrets", sources: ["tasks": declared]) { s in
			await ran.add(s)
			return .null
		}
		#expect(refused == .error("Source \"secrets\" is not declared in the maskin-sources block."))
		#expect(await ran.specs == [declared])  // the undeclared name ran nothing
	}

	@Test("a failed query becomes an error for the page, in the server's words when it gave them")
	func failure() async {
		let readable = await LoopViewBridge.answer(name: "a", sources: ["a": spec("task")]) { _ in
			throw LoopViewError("The server may be busy. Try again.")
		}
		#expect(readable == .error("The server may be busy. Try again."))
		let opaque = await LoopViewBridge.answer(name: "a", sources: ["a": spec("task")]) { _ in
			throw URLError(.timedOut)
		}
		#expect(opaque == .error("The query failed."))
	}

	// MARK: Sources

	private func page(_ slot: String) -> String {
		"<html><head>\(slot)</head><body><script>window.maskin.query('a')</script></body></html>"
	}

	@Test("sources are read from the maskin-sources block")
	func sources() {
		let html = page(
			#"<script id="maskin-sources" type="application/json">{"tasks":{"scope":"workspace","type":"task"},"bets":{"type":"bet","group_by":"status"}}</script>"#
		)
		guard case .ok(let found) = LoopViewBridge.readSources(from: html) else {
			Issue.record("expected sources")
			return
		}
		#expect(Set(found.keys) == ["tasks", "bets"])
		#expect(found["bets"]?["group_by"]?.stringValue == "status")
	}

	@Test("a block spread over lines and written in capitals still reads")
	func sourcesMultiline() {
		let html = page("<SCRIPT TYPE='application/json' ID=maskin-sources>\n{\n \"a\": {\"type\": \"task\"}\n}\n</SCRIPT>")
		guard case .ok(let found) = LoopViewBridge.readSources(from: html) else {
			Issue.record("expected sources")
			return
		}
		#expect(Set(found.keys) == ["a"])
	}

	@Test("no block is a view with no data")
	func noSources() {
		#expect(LoopViewBridge.readSources(from: page("")) == .ok([:]))
	}

	@Test("bad JSON, a block that is not an object, or a source that is not an object is refused")
	func badSources() {
		func slot(_ json: String) -> String {
			page(#"<script id="maskin-sources" type="application/json">"# + json + "</script>")
		}
		#expect(
			LoopViewBridge.readSources(from: slot("{not json"))
				== .invalid("The maskin-sources block is not valid JSON."))
		#expect(
			LoopViewBridge.readSources(from: slot(#"["a"]"#))
				== .invalid("The maskin-sources block must be a JSON object."))
		#expect(
			LoopViewBridge.readSources(from: slot(#"{"a":"task"}"#))
				== .invalid("Source \"a\" is not a valid query."))
	}

	@Test("the same query always gives the same text")
	func canonical() {
		let a = JSONValue.object(["type": .string("task"), "scope": .string("workspace")])
		let b = JSONValue.object(["scope": .string("workspace"), "type": .string("task")])
		#expect(LoopViewBridge.canonical(a) == LoopViewBridge.canonical(b))
		#expect(LoopViewBridge.canonical(a) == #"{"scope":"workspace","type":"task"}"#)
	}

	// MARK: Scripts and rules

	@Test("the page's only way out is the one handler")
	func scripts() {
		#expect(LoopViewBridge.bridgeScript.contains("window.webkit.messageHandlers.maskin.postMessage"))
		#expect(LoopViewBridge.bridgeScript.contains("maskin:bridge:query"))
		#expect(LoopViewBridge.sizeScript.contains("maskin:viewer:doc-size"))
		#expect(LoopViewBridge.realtimeBlockScript.contains("RTCPeerConnection"))
		#expect(LoopViewBridge.realtimeBlockScript.contains("webkitRTCPeerConnection"))
	}

	@Test("the content rules are valid and refuse every network scheme")
	func rules() throws {
		let rules = try JSONDecoder().decode(
			JSONValue.self, from: Data(LoopViewBridge.blockNetworkRules.utf8))
		guard case .array(let list) = rules else {
			Issue.record("expected a list of rules")
			return
		}
		#expect(list.compactMap { $0["trigger"]?["url-filter"]?.stringValue } == ["^https?://", "^wss?://", "^ftp://"])
		#expect(list.allSatisfy { $0["action"]?["type"]?.stringValue == "block" })
	}

	// MARK: Data request

	@Test("the query goes in the request escaped, with the viewer's session and workspace")
	func request() throws {
		let spec = JSONValue.object([
			"type": .string("task"),
			"filters": .object(["metadata": .object(["note": .string("a+b&c=d")])]),
		])
		let request = try URLSessionLoopDataQuery.request(
			for: spec, baseURL: URL(string: "https://example.test")!, clientSource: "ios", apiKey: "ank_x",
			workspace: "w1")
		let url = try #require(request.url)
		#expect(url.path == "/api/data/query")
		let query = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery)
		#expect(query.hasPrefix("spec="))
		#expect(!query.dropFirst(5).contains("&"))
		#expect(!query.dropFirst(5).contains("+"))
		let value = try #require(String(query.dropFirst(5)).removingPercentEncoding)
		#expect(value == LoopViewBridge.canonical(spec))
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ank_x")
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == "w1")
		#expect(request.timeoutInterval == 30)
	}

	@Test("a refused query says why in plain words")
	func messages() {
		let body = Data(#"{"error":"type is required"}"#.utf8)
		#expect(URLSessionLoopDataQuery.message(status: 400, body: body) == "type is required")
		#expect(URLSessionLoopDataQuery.message(status: 400, body: Data("{}".utf8)) == "The server did not accept this query.")
		#expect(URLSessionLoopDataQuery.message(status: 401, body: Data()) == "Sign in again to see this view.")
		#expect(URLSessionLoopDataQuery.message(status: 503, body: Data()) == "The server may be busy. Try again.")
		#expect(URLSessionLoopDataQuery.message(status: 404, body: Data()) == "Couldn't load this number.")
	}
}

private actor Ran {
	var specs: [JSONValue] = []
	func add(_ spec: JSONValue) { specs.append(spec) }
}
