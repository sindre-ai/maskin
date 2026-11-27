import Foundation
import Testing

@testable import MaskinCore

private struct NoLogin: Authenticating {
	func login(email: String, password: String) async throws -> LoginResult {
		throw AuthError.invalidCredentials
	}
}

/// Every store the app reads before the first frame is fed the three states saved state goes wrong
/// in: a corrupt blob (bytes that are not the expected JSON), an older-version blob (JSON written
/// before a field existed) and an expired entry. None may trap, and each falls back to a usable
/// default. This is the launch half of "Fix the iOS app crash loop": a crash that repeats on every
/// launch comes from state read on the launch path, and a reinstall (which wipes it) being the only
/// cure is what points at saved state rather than the code that runs later.
@MainActor
@Suite("Launch state")
struct LaunchStateTests {
	/// Bytes that no decoder in these stores can read as JSON.
	private let corrupt = Data([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x7F])

	private func scratchDefaults() -> UserDefaults {
		UserDefaults(suiteName: "launch-state-\(UUID().uuidString)")!
	}

	private func scratchDirectory(_ name: String) -> URL {
		FileManager.default.temporaryDirectory
			.appendingPathComponent("launch-\(name)-\(UUID().uuidString)", isDirectory: true)
	}

	private func json(_ text: String) -> Data { Data(text.utf8) }

	private func cacheFiles(in directory: URL) throws -> [URL] {
		try FileManager.default.subpathsOfDirectory(atPath: directory.path)
			.map { directory.appendingPathComponent($0) }
			.filter { $0.pathExtension == "cache" }
	}

	// MARK: Session (the Keychain blob)

	@Test("a corrupt session blob keeps the person signed out and leaves the item for the next read")
	func corruptSession() throws {
		let secrets = InMemorySecretStore(corrupt)
		let auth = AuthSession(authenticator: NoLogin(), store: secrets)
		auth.restore()

		#expect(auth.session == nil)
		#expect(auth.restoreFailed, "a failed decode must be told apart from 'nothing stored'")
		let stored = try secrets.read()
		#expect(stored == corrupt, "a decode failure must not wipe the stored session")
	}

	@Test("a session blob missing a required field is a miss, not a crash")
	func sessionMissingField() throws {
		let auth = AuthSession(
			authenticator: NoLogin(), store: InMemorySecretStore(json(#"{"apiKey":"k"}"#)))
		auth.restore()

		#expect(auth.session == nil)
		#expect(auth.restoreFailed)
	}

	@Test("a session blob from an older build decodes with defaults for the fields it lacks")
	func olderSession() throws {
		let auth = AuthSession(
			authenticator: NoLogin(),
			store: InMemorySecretStore(json(#"{"apiKey":"k","actorId":"a1"}"#)))
		auth.restore()

		#expect(auth.session?.actorId == "a1")
		#expect(auth.session?.name == "")
		#expect(auth.session?.workspaceId == nil)
	}

	@Test("a session blob from a newer build still decodes when this build ignores its extra keys")
	func newerSession() throws {
		let blob = json(
			#"{"apiKey":"k","actorId":"a1","name":"A","workspaceId":"ws","displayName":"A B"}"#)
		let auth = AuthSession(authenticator: NoLogin(), store: InMemorySecretStore(blob))
		auth.restore()

		#expect(auth.session?.apiKey == "k")
		#expect(auth.session?.workspaceId == "ws")
	}

	// MARK: Workspace list (the on-disk cache the shell reads on the first frame)

	@Test("a corrupt workspace cache opens with an empty list instead of trapping")
	func corruptWorkspaceCache() throws {
		let directory = scratchDirectory("workspaces")
		defer { try? FileManager.default.removeItem(at: directory) }
		let key = DiskCache.Key(actorId: "actor-1", name: WorkspaceStore.cacheName)
		let summary = WorkspaceSummary(id: "ws-1", name: "Firm", role: "owner", memberCount: 2)

		let writer = DiskCache(directory: directory)
		writer.write([summary], key: key, version: 1)
		writer.flush()

		let files = try cacheFiles(in: directory)
		#expect(!files.isEmpty)
		for file in files { try corrupt.write(to: file) }

		let session = try JSONEncoder().encode(
			StoredSession(apiKey: "k", actorId: "actor-1", name: "A"))
		let secrets = InMemorySecretStore(session)
		let auth = AuthSession(authenticator: NoLogin(), store: secrets)
		auth.restore()

		let store = WorkspaceStore(
			source: StaticWorkspaceSource([]), auth: auth, disk: DiskCache(directory: directory))

		#expect(store.workspaces.isEmpty)
		#expect(store.phase == .idle, "a corrupt cache is a miss, not a failed load")
	}

	@Test("a workspace cache written by another version is a miss")
	func workspaceCacheVersion() throws {
		let key = DiskCache.Key(actorId: "actor-1", name: WorkspaceStore.cacheName)
		let summary = WorkspaceSummary(id: "ws-1", name: "Firm", role: "owner", memberCount: 2)

		let wrongVersion = scratchDirectory("workspace-version")
		let currentVersion = scratchDirectory("workspace-current-version")
		defer {
			try? FileManager.default.removeItem(at: wrongVersion)
			try? FileManager.default.removeItem(at: currentVersion)
		}

		let oldWriter = DiskCache(directory: wrongVersion)
		oldWriter.write([summary], key: key, version: 2)
		oldWriter.flush()
		#expect(DiskCache(directory: wrongVersion).read([WorkspaceSummary].self, key: key, version: 1) == nil)

		let writer = DiskCache(directory: currentVersion)
		writer.write([summary], key: key, version: 2)
		writer.flush()
		#expect(
			DiskCache(directory: currentVersion).read([WorkspaceSummary].self, key: key, version: 2)?
				.value == [summary])
	}

	@Test("a workspace cache older than the age bound is a miss")
	func workspaceCacheExpiry() throws {
		let directory = scratchDirectory("workspace-expiry")
		defer { try? FileManager.default.removeItem(at: directory) }
		let key = DiskCache.Key(actorId: "actor-1", name: WorkspaceStore.cacheName)
		let summary = WorkspaceSummary(id: "ws-1", name: "Firm", role: "owner", memberCount: 2)

		let longAgo = Date(timeIntervalSinceNow: -30 * 24 * 3600)
		let writer = DiskCache(directory: directory, now: { longAgo })
		writer.write([summary], key: key, version: 1)
		writer.flush()

		let reader = DiskCache(directory: directory)
		#expect(reader.read([WorkspaceSummary].self, key: key, version: 1) == nil)
	}

	// MARK: Display preferences

	@Test("saved views from a corrupt or older blob bind as empty and the store still works")
	func savedViews() {
		let defaults = scratchDefaults()

		defaults.set(corrupt, forKey: "objects.savedViews.v1.ws-1")
		let corruptStore = SavedViewsStore(defaults: defaults)
		corruptStore.bind(workspaceId: "ws-1")
		#expect(corruptStore.views.isEmpty)
		corruptStore.add(SavedView(name: "Mine", scope: .all))
		#expect(corruptStore.views.count == 1, "a corrupt blob must not make the store unusable")

		// Written before a field existed: the whole list is dropped rather than half-decoded.
		defaults.set(json(#"[{"id":"v1","name":"Old"}]"#), forKey: "objects.savedViews.v1.ws-2")
		let olderStore = SavedViewsStore(defaults: defaults)
		olderStore.bind(workspaceId: "ws-2")
		#expect(olderStore.views.isEmpty)
	}

	@Test("the objects display decodes an older blob field by field and a corrupt one as a miss")
	func objectsDisplay() {
		let defaults = scratchDefaults()
		let storage = UserDefaultsObjectsDisplayStorage(defaults: defaults)

		defaults.set(corrupt, forKey: "objects.display.v1")
		#expect(storage.load() == nil)

		defaults.set(json(#"{"sort":"updated"}"#), forKey: "objects.display.v1")
		let older = storage.load()
		#expect(older?.sort == .updated)
		#expect(older?.layout == .list)
		#expect(older?.groupBy == .status)
		#expect(older?.isReversed == false)
	}

	@Test("the flows display decodes an older blob field by field and a corrupt one as a miss")
	func flowsDisplay() {
		let defaults = scratchDefaults()
		let storage = UserDefaultsLoopsDisplayStorage(defaults: defaults)

		defaults.set(corrupt, forKey: "flows.display.v1")
		#expect(storage.load() == nil)

		defaults.set(json("{}"), forKey: "flows.display.v1")
		#expect(storage.load() == LoopsDisplay())
	}

	@Test("team preferences with corrupt or wrongly typed values fall back to defaults")
	func teamPreferences() {
		let defaults = scratchDefaults()
		let scope = "team.v1.actor-1.ws-1"
		defaults.set(corrupt, forKey: "\(scope).display")
		defaults.set("not-an-array", forKey: "\(scope).pinOrder")
		defaults.set(42, forKey: "\(scope).pinnedFlows")

		let preferences = TeamPreferences(defaults: defaults, actorID: "actor-1", workspaceID: "ws-1")

		#expect(preferences.displayOptions == .default)
		#expect(preferences.pinOrder.isEmpty)
		#expect(preferences.pinnedFlowIDs.isEmpty)
	}

	// MARK: Later, calls and recents

	@Test("later entries that are corrupt, older or expired never trap a launch")
	func laterEntries() {
		let defaults = scratchDefaults()
		let key = LaterStore.key(workspace: "ws-1")
		let now = Date()

		defaults.set(corrupt, forKey: key)
		let corruptStore = LaterStore(
			defaults: defaults, workspaceId: { "ws-1" }, now: { now })
		#expect(corruptStore.entries.isEmpty)

		// Written before `label` existed: the dictionary is dropped rather than half-decoded.
		let older = json(
			#"{"card":{"until":\#(now.addingTimeInterval(3600).timeIntervalSinceReferenceDate)}}"#)
		defaults.set(older, forKey: key)
		let olderStore = LaterStore(defaults: defaults, workspaceId: { "ws-1" }, now: { now })
		#expect(olderStore.entries.isEmpty)

		// A deferral whose time has passed is not hidden and not "back again" forever.
		let expiredStore = LaterStore(defaults: defaults, workspaceId: { "ws-1" }, now: { now })
		expiredStore.`defer`("card", until: now.addingTimeInterval(-60), label: "This evening")
		#expect(expiredStore.isDeferred("card") == false)
		#expect(expiredStore.isBackFromLater("card"))
	}

	@Test("a corrupt call log reads as empty and a long one is trimmed to the newest limit")
	func liveCalls() {
		let defaults = scratchDefaults()
		let log = LiveCallLog(defaults: defaults)

		defaults.set(corrupt, forKey: "live.calls.v1")
		#expect(log.all().isEmpty)

		for index in 0..<(LiveCallLog.limit + 10) {
			log.save(
				LiveCallRecord(
					id: "call-\(index)", conversationID: "chat", leadName: "Lead",
					startedAt: Date(timeIntervalSinceReferenceDate: Double(index))))
		}
		let calls = log.all()
		#expect(calls.count == LiveCallLog.limit)
		#expect(calls.last?.id == "call-\(LiveCallLog.limit + 9)", "the newest calls are the ones kept")
	}

	@Test("a corrupt or wrongly typed recent search list reads as empty and stays capped")
	func recentSearches() {
		let defaults = scratchDefaults()
		let recents = SearchRecents(defaults: defaults, actorId: "actor-1")
		let key = "\(SearchRecents.keyPrefix)actor-1.ws-1"

		defaults.set("not-an-array", forKey: key)
		#expect(recents.load(workspaceId: "ws-1").isEmpty)

		for index in 0..<(SearchRecents.limit + 5) {
			recents.push("query-\(index)", workspaceId: "ws-1")
		}
		#expect(recents.load(workspaceId: "ws-1").count == SearchRecents.limit)
	}

	// MARK: Invites, share drafts and the notification prompt

	@Test("a corrupt, invalid or expired invite token is dropped instead of resuming a dead link")
	func pendingInvites() {
		let defaults = scratchDefaults()
		let now = Date()

		defaults.set(corrupt, forKey: "invite.pending.v1")
		let corruptStore = UserDefaultsPendingInviteStore(defaults: defaults, now: { now })
		#expect(corruptStore.load() == nil)
		#expect(defaults.data(forKey: "invite.pending.v1") == nil, "a bad token is cleared")

		let expiredStore = UserDefaultsPendingInviteStore(defaults: defaults, now: { now })
		expiredStore.save("nonsense")
		#expect(expiredStore.load() == nil, "a token that is not an invite link is dropped")
	}

	@Test("an expired invite is not resumed after a relaunch")
	func expiredInvite() throws {
		let defaults = scratchDefaults()
		let saved = Date(timeIntervalSinceNow: -8 * 24 * 3600)
		let valid = try #require(InviteLink(token: "abcdefghijklmnop1234"))
		#expect(valid.token == "abcdefghijklmnop1234")

		let oldStore = UserDefaultsPendingInviteStore(defaults: defaults, now: { saved })
		oldStore.save(valid.token)
		let reopened = UserDefaultsPendingInviteStore(defaults: defaults)
		#expect(reopened.load() == nil)
	}

	@Test("a corrupt share draft is a miss and does not come back for any content")
	func shareDraft() {
		let defaults = scratchDefaults()
		defaults.set(corrupt, forKey: "maskin.share.draft")
		let store = ShareDraftStore(defaults: defaults)
		#expect(store.load(fingerprint: "anything") == nil)
	}

	@Test("a corrupt share recents blob reads as empty")
	func shareRecents() {
		let defaults = scratchDefaults()
		defaults.set(corrupt, forKey: "maskin.share.suggestionRecents")
		let recents = ShareSuggestionRecents(defaults: defaults)
		#expect(recents.entries(workspaceId: "ws-1").isEmpty)
	}

	@Test("a snooze stored as something other than a date cannot block or force the prompt")
	func notificationPrompt() {
		let defaults = scratchDefaults()
		defaults.set("not-a-date", forKey: "push.prompt.snoozedUntil.v1")
		let policy = NotificationPromptPolicy(
			storage: UserDefaultsNotificationPromptStorage(defaults: defaults))

		#expect(policy.shouldOffer(permission: .notDetermined, now: Date()))
		#expect(!policy.shouldOffer(permission: .denied, now: Date()))
	}

	@Test("a snooze that has passed no longer holds the prompt back")
	func expiredSnooze() {
		let defaults = scratchDefaults()
		let storage = UserDefaultsNotificationPromptStorage(defaults: defaults)
		storage.snooze(until: Date(timeIntervalSinceNow: -60))
		let policy = NotificationPromptPolicy(storage: storage)

		#expect(policy.shouldOffer(permission: .notDetermined, now: Date()))
	}
}
