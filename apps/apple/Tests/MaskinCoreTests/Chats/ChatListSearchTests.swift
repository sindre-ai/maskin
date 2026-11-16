import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

private struct StubSearch: ChatSearching {
	var hits: [ChatSearchHit] = []
	var fail = false
	func search(query: String) async throws -> [ChatSearchHit] {
		if fail { throw ChatsError("boom") }
		return hits
	}
}

@Suite("Chat list search rules")
struct ChatSearchRulesTests {
	private func hit(
		id: String = "chat-1", archived: Bool = false, updatedAt: Date? = Date(timeIntervalSince1970: 2_000),
		people: String? = "Developer, Me", snippet: String? = nil
	) -> ChatSearchHit {
		ChatSearchHit(id: id, title: "Billing", people: people, snippet: snippet, archived: archived, updatedAt: updatedAt)
	}

	private let oldest = Date(timeIntervalSince1970: 1_000)

	@Test("a chat the person archived reads as archived")
	func archivedByPerson() {
		#expect(ChatSearchRules.isArchived(hit(archived: true), loadedIDs: ["chat-1"], hasMore: true, oldestActivity: oldest))
	}

	@Test("a chat the list holds is not archived")
	func inList() {
		#expect(!ChatSearchRules.isArchived(hit(), loadedIDs: ["chat-1"], hasMore: false, oldestActivity: oldest))
	}

	@Test("a chat missing from a fully loaded list is left out")
	func missingFromFullList() {
		#expect(ChatSearchRules.isArchived(hit(), loadedIDs: ["other"], hasMore: false, oldestActivity: oldest))
	}

	@Test("while pages remain, a missing chat newer than the oldest loaded row is left out")
	func missingNewer() {
		#expect(ChatSearchRules.isArchived(hit(), loadedIDs: ["other"], hasMore: true, oldestActivity: oldest))
	}

	@Test("while pages remain, a missing chat older than the oldest loaded row is not marked")
	func missingOlder() {
		let old = hit(updatedAt: Date(timeIntervalSince1970: 500))
		#expect(!ChatSearchRules.isArchived(old, loadedIDs: ["other"], hasMore: true, oldestActivity: oldest))
	}

	@Test("with pages remaining and no activity time it cannot tell")
	func cannotTell() {
		#expect(!ChatSearchRules.isArchived(hit(updatedAt: nil), loadedIDs: ["other"], hasMore: true, oldestActivity: oldest))
	}

	@Test("the line is the matching message")
	func lineIsMessage() {
		#expect(ChatSearchRules.line(for: hit(snippet: "retries run at noon"), query: "noon") == "retries run at noon")
	}

	@Test("the line is the people when only the name matched")
	func lineIsPeople() {
		#expect(ChatSearchRules.line(for: hit(snippet: "retries run at noon"), query: "developer") == "Developer, Me")
	}

	@Test("the line falls back to the people with no message, and is nil with neither")
	func lineFallback() {
		#expect(ChatSearchRules.line(for: hit(), query: "billing") == "Developer, Me")
		#expect(ChatSearchRules.line(for: hit(people: nil), query: "billing") == nil)
	}
}

@Suite("Chat list search model")
@MainActor
struct ChatListSearchModelTests {
	@Test("a typed word loads the hits")
	func loads() async {
		let model = ChatListSearchModel(
			source: StubSearch(hits: [ChatSearchHit(id: "a", title: "Old chat", archived: true)]), debounce: .zero)
		await model.update("old")
		#expect(model.phase == .loaded)
		#expect(model.hits.map(\.id) == ["a"])
	}

	@Test("an empty text clears the hits and goes idle")
	func clears() async {
		let model = ChatListSearchModel(source: StubSearch(hits: [ChatSearchHit(id: "a", title: "x")]), debounce: .zero)
		await model.update("x")
		await model.update("   ")
		#expect(model.phase == .idle)
		#expect(model.hits.isEmpty)
	}

	@Test("a failing search is reported")
	func fails() async {
		let model = ChatListSearchModel(source: StubSearch(fail: true), debounce: .zero)
		await model.update("x")
		#expect(model.phase == .failed)
		#expect(model.hits.isEmpty)
	}

	@Test("without a source it is unavailable and stays idle")
	func noSource() async {
		let model = ChatListSearchModel(source: nil)
		await model.update("x")
		#expect(!model.isAvailable)
		#expect(model.phase == .idle)
	}
}

@Suite("Chat list search request")
struct APIChatSearchTests {
	private func search() -> APIChatSearch {
		APIChatSearch(
			baseURL: URL(string: "https://example.test")!, clientSource: "ios",
			credentials: { MaskinCredentials(apiKey: "ank_test", workspaceId: "ws-1") })
	}

	@Test("asks for chats only, in the workspace, with the key")
	func request() async throws {
		let request = await search().makeRequest(query: "csv export")
		let url = try #require(request.url)
		let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
		#expect(url.path == "/api/search")
		#expect(items.first { $0.name == "q" }?.value == "csv export")
		#expect(items.first { $0.name == "types" }?.value == "chat")
		#expect(items.first { $0.name == "statuses" }?.value?.contains("archived") == true)
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == "ws-1")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ank_test")
	}

	@Test("reads the hits and marks the archived ones")
	func decodes() throws {
		let json = """
			{"results":[
			 {"id":"a","group":"chats","type":"chat","title":"Old invoice export","sub":"Developer, Me",
			  "snippet":"the csv export times out","status":"archived","statusGroup":"archived",
			  "updatedAt":"2026-09-01T10:00:00.000Z"},
			 {"id":"b","group":"chats","type":"chat","title":"Billing","sub":null,"snippet":null,
			  "status":"read","statusGroup":"done","updatedAt":null}],
			 "total":2,"capped":false}
			"""
		let hits = try APIChatSearch.decode(Data(json.utf8))
		#expect(hits.map(\.id) == ["a", "b"])
		#expect(hits[0].archived)
		#expect(hits[0].snippet == "the csv export times out")
		#expect(hits[0].updatedAt != nil)
		#expect(!hits[1].archived)
		#expect(hits[1].updatedAt == nil)
	}

	@Test("an unreadable reply says to update the app")
	func unreadable() {
		#expect(throws: ChatsError.self) { try APIChatSearch.decode(Data("{}".utf8)) }
	}
}
