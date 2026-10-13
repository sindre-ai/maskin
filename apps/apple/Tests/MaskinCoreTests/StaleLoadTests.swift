import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

/// A latch: `wait()` suspends until `release()`. Lets a test hold a load in flight while the
/// world changes underneath it, with no sleeps near a limit.
actor Gate {
	private var isOpen = false
	private var waiters: [CheckedContinuation<Void, Never>] = []
	private(set) var started = 0

	func wait() async {
		started += 1
		if isOpen { return }
		await withCheckedContinuation { waiters.append($0) }
	}

	func release() {
		isOpen = true
		for w in waiters { w.resume() }
		waiters = []
	}

	func waitUntilStarted(_ count: Int = 1) async {
		let deadline = ContinuousClock.now.advanced(by: .seconds(20))
		while started < count, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(2)) }
	}
}

@MainActor
@Suite("Stale loads are not applied")
struct StaleLoadTests {
	// MARK: WorkspaceStore

	@Test("a workspace list fetched for a signed-out user never selects a workspace for the next one")
	func workspacesAcrossUsers() async throws {
		struct Gated: WorkspaceListing {
			let gate: Gate
			func listWorkspaces() async throws -> [WorkspaceSummary] {
				await gate.wait()
				return [WorkspaceSummary(id: "alices-ws", name: "Alice", role: "owner", memberCount: 1)]
			}
		}
		struct NoLogin: Authenticating {
			func login(email: String, password: String) async throws -> LoginResult {
				throw AuthError.invalidCredentials
			}
		}
		func blob(_ actor: String) throws -> Data {
			try JSONEncoder().encode(StoredSession(apiKey: "k-\(actor)", actorId: actor, name: actor))
		}
		let secrets = InMemorySecretStore(try blob("alice"))
		let auth = AuthSession(authenticator: NoLogin(), store: secrets)
		auth.restore()
		let gate = Gate()
		let store = WorkspaceStore(source: Gated(gate: gate), auth: auth)
		let load = Task { await store.refresh() }
		await gate.waitUntilStarted()

		auth.signOut()
		try secrets.write(try blob("bob"))
		auth.restore()
		await gate.release()
		await load.value

		#expect(store.workspaces.isEmpty)
		#expect(auth.session?.workspaceId == nil, "bob must not be dropped into alice's workspace")
	}

	// MARK: ForYouStore

	@Test("an older, slower feed response cannot overwrite a newer one")
	func feedSequencing() async {
		final class Source: ForYouSource, @unchecked Sendable {
			let slow: Gate
			private let lock = NSLock()
			private var calls = 0
			init(slow: Gate) { self.slow = slow }
			func fetchFeed(workspaceId: String) async throws -> [ForYouCard] {
				let n = lock.withLock {
					calls += 1
					return calls
				}
				if n == 1 {
					await slow.wait()
					return [ForYouCard(id: "stale", objectType: "bet", unreadCount: 1)]
				}
				return [ForYouCard(id: "fresh", objectType: "bet", unreadCount: 1)]
			}
			func fetchActors(workspaceId: String) async throws -> [ForYouActor] { [] }
			func fetchBrief(workspaceId: String) async throws -> ForYouBrief { ForYouBrief(markdown: "") }
		}
		let gate = Gate()
		let backend = FakeDecisionBackend()
		let outbox = Outbox(
			fileURL: temporaryOutboxFile(), executor: DecisionOutboxExecutor(backend: backend),
			network: ManualNetworkMonitor(), workspaceId: { "ws-1" }, backoff: { _ in 0.02 })
		let store = ForYouStore(
			source: Source(slow: gate), decisions: DecisionService(outbox: outbox),
			workspaceId: { "ws-1" }, defaults: UserDefaults(suiteName: "stale-\(UUID().uuidString)")!)

		let first = Task { await store.load() }
		await gate.waitUntilStarted()
		await store.refresh()  // newer request, answers at once
		#expect(store.cards.map(\.id) == ["fresh"])

		await gate.release()
		await first.value

		#expect(store.cards.map(\.id) == ["fresh"], "the slow first response must not win")
	}
}
