import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinCore

/// Answers every request with the same preferences document and remembers the paths.
private final class CannedTransport: ClientTransport, @unchecked Sendable {
	static let body = """
		{"timezone":"Europe/Oslo","quiet_hours_start":1320,"quiet_hours_end":420,
		"categories":{"needs_you":true,"conversation":false,"digest":true,"tips":false},
		"briefing_enabled":false,"briefing_time":480,"muted_workspace_ids":["00000000-0000-4000-8000-000000000001"],
		"updated_at":null}
		"""
	private let lock = NSLock()
	private var _paths: [String] = []
	var paths: [String] { lock.withLock { _paths } }

	func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws
		-> (HTTPResponse, HTTPBody?)
	{
		lock.withLock { _paths.append(request.path ?? "") }
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(Self.body))
	}
}

private actor FakePrefsAPI: NotificationPreferencesAPI {
	var server: NotificationPreferences
	var saves: [(patch: NotificationPreferencesPatch, key: String)] = []
	var loads = 0
	var failLoad = false
	var failSave = false
	var saveDelay: Duration?

	init(_ server: NotificationPreferences = NotificationPreferences()) { self.server = server }

	func setFailSave(_ v: Bool) { failSave = v }
	func setFailLoad(_ v: Bool) { failLoad = v }
	func setSaveDelay(_ d: Duration?) { saveDelay = d }

	func load() async throws -> NotificationPreferences {
		loads += 1
		if failLoad { throw SettingsError("offline") }
		return server
	}

	func save(_ patch: NotificationPreferencesPatch, idempotencyKey: String) async throws -> NotificationPreferences {
		if let saveDelay { try await Task.sleep(for: saveDelay) }
		if failSave { throw SettingsError("Couldn't save your notification settings.") }
		saves.append((patch, idempotencyKey))
		server = patch.applied(to: server)
		return server
	}
}

/// Waits (up to 5 s) for every queued change to be answered.
@MainActor
private func settle(_ store: NotificationPreferencesStore) async {
	for _ in 0..<500 where store.isSaving { try? await Task.sleep(for: .milliseconds(10)) }
}

@MainActor
@Suite("NotificationPreferencesStore")
struct NotificationPreferencesStoreTests {

	@Test("loads the server's preferences")
	func loads() async {
		let api = FakePrefsAPI(NotificationPreferences(briefingEnabled: false, briefingTime: 60))
		let store = NotificationPreferencesStore(api: api)
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.preferences.briefingEnabled == false)
		#expect(store.preferences.briefingTime == 60)
	}

	@Test("a failed first load is reported, not hidden")
	func loadFails() async {
		let api = FakePrefsAPI()
		await api.setFailLoad(true)
		let store = NotificationPreferencesStore(api: api)
		await store.load()
		#expect(store.phase == .failed)
	}

	@Test("a toggle shows at once and saves only that field with its own Idempotency-Key")
	func optimistic() async {
		let api = FakePrefsAPI()
		let store = NotificationPreferencesStore(api: api)
		await store.load()
		store.setCategory(.tips, enabled: false)
		#expect(store.preferences.categories.tips == false, "visible before the server answers")
		await settle(store)
		let saves = await api.saves
		#expect(saves.count == 1)
		var expected = NotificationPreferencesPatch()
		expected.tips = false
		#expect(saves.first?.patch == expected)
		#expect(saves.first?.key.isEmpty == false)
		#expect(store.preferences.categories.tips == false)
		#expect(store.error == nil)
	}

	@Test("two changes use two different keys")
	func distinctKeys() async {
		let api = FakePrefsAPI()
		let store = NotificationPreferencesStore(api: api)
		await store.load()
		store.setCategory(.tips, enabled: false)
		store.setCategory(.digest, enabled: false)
		await settle(store)
		let keys = await api.saves.map(\.key)
		#expect(keys.count == 2 && Set(keys).count == 2)
	}

	@Test("a refused change rolls back and says so; later changes survive")
	func rollback() async {
		let api = FakePrefsAPI()
		let store = NotificationPreferencesStore(api: api)
		await store.load()
		await api.setFailSave(true)
		store.setCategory(.conversation, enabled: false)
		await settle(store)
		#expect(store.preferences.categories.conversation == true, "put back")
		#expect(store.error != nil)
		store.dismissError()
		#expect(store.error == nil)
	}

	@Test("saves go in order and a failure drops only its own change")
	func partialRollback() async {
		let api = FakePrefsAPI()
		let store = NotificationPreferencesStore(api: api)
		await store.load()
		await api.setSaveDelay(.milliseconds(40))
		store.setCategory(.tips, enabled: false)
		store.setBriefing(enabled: false)
		#expect(store.preferences.categories.tips == false && store.preferences.briefingEnabled == false)
		await settle(store)
		#expect(store.preferences.categories.tips == false && store.preferences.briefingEnabled == false)
		let server = await api.server
		#expect(server.categories.tips == false && server.briefingEnabled == false)
	}

	@Test("quiet hours: on starts at 22:00 to 07:00, off clears, bounds move together")
	func quietHours() async {
		let api = FakePrefsAPI()
		let store = NotificationPreferencesStore(api: api)
		await store.load()
		#expect(store.preferences.quietHours == nil)
		store.setQuietHours(enabled: true)
		await settle(store)
		#expect(store.preferences.quietHours == .init(start: 1320, end: 420))
		store.setQuietHours(end: 8 * 60)
		await settle(store)
		#expect(store.preferences.quietHours == .init(start: 1320, end: 480))
		store.setQuietHours(enabled: false)
		await settle(store)
		#expect(store.preferences.quietHours == nil)
	}

	@Test("muting a workspace adds its id once; unmuting removes it; other ids stay")
	func mutes() async {
		let api = FakePrefsAPI(NotificationPreferences(mutedWorkspaceIds: ["ws-old"]))
		let store = NotificationPreferencesStore(api: api)
		await store.load()
		store.setMuted(true, workspaceId: "ws-1")
		store.setMuted(true, workspaceId: "ws-1")
		await settle(store)
		#expect(store.preferences.mutedWorkspaceIds.sorted() == ["ws-1", "ws-old"])
		#expect(store.isMuted(workspaceId: "ws-1"))
		store.setMuted(false, workspaceId: "ws-1")
		await settle(store)
		#expect(store.preferences.mutedWorkspaceIds == ["ws-old"])
	}
}

@MainActor
@Suite("Timezone sync")
struct TimezoneSyncTests {
	@Test("PUTs the timezone when the server has none or another")
	func puts() async {
		let api = FakePrefsAPI(NotificationPreferences(timezone: nil))
		let store = NotificationPreferencesStore(api: api)
		await store.syncTimezone("Europe/Oslo")
		var saves = await api.saves
		#expect(saves.count == 1)
		#expect(saves.first?.patch.timezone == .set("Europe/Oslo"))
		#expect(saves.first?.patch.quietHours == .keep, "nothing else is sent")
		await store.syncTimezone("America/New_York")
		saves = await api.saves
		#expect(saves.count == 2)
	}

	@Test("does nothing when the server already has it, and reads the server only once")
	func skipsWhenEqual() async {
		let api = FakePrefsAPI(NotificationPreferences(timezone: "Europe/Oslo"))
		let store = NotificationPreferencesStore(api: api)
		await store.syncTimezone("Europe/Oslo")
		await store.syncTimezone("Europe/Oslo")
		#expect(await api.saves.isEmpty)
		#expect(await api.loads == 1, "cached after the first read")
	}

	@Test("fails silently and tries again next time")
	func silentRetry() async {
		let api = FakePrefsAPI(NotificationPreferences(timezone: nil))
		let store = NotificationPreferencesStore(api: api)
		await api.setFailSave(true)
		await store.syncTimezone("Europe/Oslo")
		#expect(store.error == nil)
		#expect(await api.saves.isEmpty)
		await api.setFailSave(false)
		await store.syncTimezone("Europe/Oslo")
		#expect(await api.saves.count == 1)
	}

	@Test("an unreachable server on the first read is silent too")
	func silentLoad() async {
		let api = FakePrefsAPI()
		await api.setFailLoad(true)
		let store = NotificationPreferencesStore(api: api)
		await store.syncTimezone("Europe/Oslo")
		#expect(store.error == nil)
		#expect(await api.saves.isEmpty, "no blind PUT without knowing the server value")
	}
}

@Suite("Preferences wire format")
struct PreferencesWireTests {
	private func object(_ patch: NotificationPreferencesPatch) throws -> [String: Any] {
		try #require(JSONSerialization.jsonObject(with: patch.jsonBody()) as? [String: Any])
	}

	@Test("an empty patch sends an empty object")
	func empty() throws {
		#expect(try object(NotificationPreferencesPatch()).isEmpty)
	}

	@Test("clearing quiet hours sends both bounds as explicit null")
	func clearQuiet() throws {
		var patch = NotificationPreferencesPatch()
		patch.quietHours = .clear
		let json = try object(patch)
		#expect(json["quiet_hours_start"] is NSNull)
		#expect(json["quiet_hours_end"] is NSNull)
		#expect(json["timezone"] == nil)
	}

	@Test("setting quiet hours sends both numbers, clamped to the day")
	func setQuiet() throws {
		var patch = NotificationPreferencesPatch()
		patch.quietHours = .set(.init(start: 1320, end: 5000))
		let json = try object(patch)
		#expect(json["quiet_hours_start"] as? Int == 1320)
		#expect(json["quiet_hours_end"] as? Int == 1439)
	}

	@Test("only the touched category is sent, under categories")
	func category() throws {
		var patch = NotificationPreferencesPatch()
		patch.digest = false
		patch.timezone = .set("Europe/Oslo")
		patch.mutedWorkspaceIds = ["a"]
		patch.briefingTime = 510
		let json = try object(patch)
		#expect((json["categories"] as? [String: Bool]) == ["digest": false])
		#expect(json["timezone"] as? String == "Europe/Oslo")
		#expect(json["muted_workspace_ids"] as? [String] == ["a"])
		#expect(json["briefing_time"] as? Int == 510)
		#expect(json["briefing_enabled"] == nil)
	}

	@Test("minute and Date conversion round-trips")
	func minutes() {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "Europe/Oslo")!
		for m in [0, 59, 510, 1320, 1439] {
			let date = MinuteOfDay.date(minutes: m, calendar: calendar)
			#expect(MinuteOfDay.minutes(from: date, calendar: calendar) == m)
		}
		#expect(NotificationPreferences.clamp(minutes: -5) == 0)
		#expect(NotificationPreferences.clamp(minutes: 9999) == 1439)
	}

	@Test("the PUT request carries the key, a bearer token and no workspace header")
	func request() async throws {
		let source = APINotificationPreferencesSource(
			client: Client(serverURL: URL(string: "https://x.test")!, transport: CannedTransport()),
			baseURL: URL(string: "https://x.test")!, clientSource: "ios",
			credentials: { .init(apiKey: "k-1", workspaceId: "ws-1") })
		var patch = NotificationPreferencesPatch()
		patch.tips = true
		let request = await source.makeRequest(patch: patch, idempotencyKey: "idem-1")
		#expect(request.httpMethod == "PUT")
		#expect(request.url?.path == "/api/notification-preferences")
		#expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "idem-1")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer k-1")
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == nil)
	}

	@Test("decodes the server response")
	func decode() throws {
		let json = """
			{"timezone":null,"quiet_hours_start":1320,"quiet_hours_end":420,
			"categories":{"needs_you":true,"conversation":false,"digest":true,"tips":false},
			"briefing_enabled":true,"briefing_time":510,"muted_workspace_ids":["w"],"updated_at":null}
			"""
		let wire = try JSONDecoder().decode(APINotificationPreferencesSource.Wire.self, from: Data(json.utf8))
		let model = wire.model
		#expect(model.timezone == nil)
		#expect(model.quietHours == .init(start: 1320, end: 420))
		#expect(model.categories == .init(needsYou: true, conversation: false, digest: true, tips: false))
		#expect(model.mutedWorkspaceIds == ["w"])
	}
}

@Suite("Preferences GET through the generated client")
struct PreferencesLoadTests {
	@Test("maps the generated response into the model")
	func load() async throws {
		let transport = CannedTransport()
		let source = APINotificationPreferencesSource(
			client: Client(serverURL: URL(string: "https://x.test")!, transport: transport),
			baseURL: URL(string: "https://x.test")!, clientSource: "ios", credentials: { nil })
		let prefs = try await source.load()
		#expect(transport.paths == ["/api/notification-preferences"])
		#expect(prefs.timezone == "Europe/Oslo")
		#expect(prefs.quietHours == .init(start: 1320, end: 420))
		#expect(prefs.categories == .init(needsYou: true, conversation: false, digest: true, tips: false))
		#expect(prefs.briefingEnabled == false && prefs.briefingTime == 480)
		#expect(prefs.mutedWorkspaceIds.count == 1)
	}
}
