import Foundation
import Testing

@testable import MaskinCore

private actor FakeKeychain: KeychainAPI {
	var stored: [KeychainCredential]
	var team: [KeychainAgent]
	var failNext: KeychainAccessError?
	private(set) var removed: [String] = []
	private(set) var granted: [(String, [String])] = []
	private(set) var added: [String] = []

	init(_ stored: [KeychainCredential], team: [KeychainAgent] = []) {
		self.stored = stored
		self.team = team
	}

	func credentials() async throws -> [KeychainCredential] { stored }
	func agents() async throws -> [KeychainAgent] { team }
	func setAgents(credentialID: String, agentIDs: [String]) async throws {
		if let failNext { self.failNext = nil; throw failNext }
		granted.append((credentialID, agentIDs))
	}
	func remove(credentialID: String) async throws {
		if let failNext { self.failNext = nil; throw failNext }
		removed.append(credentialID)
	}
	func audit(credentialID: String, before: String?) async throws -> KeychainAuditPage {
		before == nil
			? KeychainAuditPage(entries: [KeychainAuditEntry(id: "1", actorID: "a1", action: .read)], nextBeforeID: "1")
			: KeychainAuditPage(entries: [KeychainAuditEntry(id: "0", actorID: "a1", action: .create, viaChat: true)], nextBeforeID: nil)
	}
	func add(name: String, value: KeychainNewValue) async throws -> String {
		added.append(name)
		stored.append(KeychainCredential(id: "new", name: name, kind: .apiKey, createdAt: Date()))
		return "new"
	}
	func failOnce(_ error: KeychainAccessError) { failNext = error }
}

@MainActor
@Suite("KeychainStore")
struct KeychainStoreTests {
	private let infra = KeychainAgent(id: "a1", name: "Infra")
	private let cto = KeychainAgent(id: "a2", name: "CTO")

	private func store(_ creds: [KeychainCredential], api: FakeKeychain? = nil) -> (KeychainStore, FakeKeychain) {
		let fake = api ?? FakeKeychain(creds, team: [infra, cto])
		return (KeychainStore(api: fake), fake)
	}

	@Test func listsNewestFirstAndNamesWhoCanUseEach() async {
		let old = KeychainCredential(id: "1", name: "Old", kind: .login, createdAt: Date(timeIntervalSince1970: 1), agentIDs: [])
		let new = KeychainCredential(id: "2", name: "New", kind: .apiKey, createdAt: Date(timeIntervalSince1970: 9), agentIDs: ["a1", "a2"])
		let (store, _) = store([old, new])
		await store.load()
		#expect(store.credentials.map(\.id) == ["2", "1"])
		#expect(store.scopeSummary(new) == "Infra + 1 more")
		#expect(store.scopeSummary(old) == "No agents can use it")
		#expect(store.scopeSummary(KeychainCredential(id: "3", name: "n", kind: .apiKey, agentIDs: ["a2"])) == "CTO")
	}

	@Test func anAgentThatIsGoneIsNeverShownAsAnId() async {
		let (store, _) = store([KeychainCredential(id: "1", name: "k", kind: .apiKey, agentIDs: ["deadbeef"])])
		await store.load()
		#expect(store.scopeSummary(store.credentials[0]) == "Unknown agent")
	}

	@Test func savingAccessSendsTheChosenAgentsAndUpdatesTheRow() async {
		let (store, fake) = store([KeychainCredential(id: "1", name: "k", kind: .apiKey)])
		await store.load()
		#expect(await store.setAgents(of: store.credentials[0], to: ["a2"]))
		#expect(store.credentials[0].agentIDs == ["a2"])
		#expect(await fake.granted.first?.1 == ["a2"])
	}

	@Test func aRefusedAccessChangeKeepsTheOldAgentsAndSaysWhy() async {
		let fake = FakeKeychain([KeychainCredential(id: "1", name: "k", kind: .apiKey, agentIDs: ["a1"])], team: [infra])
		let (store, _) = store([], api: fake)
		await store.load()
		await fake.failOnce(KeychainAccessError("Only a person can change who can use a credential."))
		#expect(await store.setAgents(of: store.credentials[0], to: []) == false)
		#expect(store.credentials[0].agentIDs == ["a1"])
		#expect(store.actionError == "Only a person can change who can use a credential.")
	}

	@Test func removingTakesItOutOfTheList() async {
		let (store, fake) = store([KeychainCredential(id: "1", name: "k", kind: .apiKey)])
		await store.load()
		#expect(await store.remove(store.credentials[0]))
		#expect(store.credentials.isEmpty)
		#expect(await fake.removed == ["1"])
	}

	@Test func addingReloadsTheList() async {
		let (store, fake) = store([])
		await store.load()
		#expect(await store.add(name: "Coolify", value: .apiKey("secret")))
		#expect(store.credentials.map(\.name) == ["Coolify"])
		#expect(await fake.added == ["Coolify"])
	}

	@Test func activityPagesOnAndReadsInPlainWords() async {
		let cred = KeychainCredential(id: "1", name: "k", kind: .apiKey)
		let (store, _) = store([cred])
		await store.load()
		await store.loadAudit(for: cred)
		#expect(store.audit.count == 1)
		#expect(store.auditNext == "1")
		#expect(store.sentence(for: store.audit[0]) == "Infra read this credential.")
		await store.loadAudit(for: cred, more: true)
		#expect(store.audit.count == 2)
		#expect(store.auditNext == nil)
		#expect(store.sentence(for: store.audit[1]) == "Captured via chat: vaulted and redacted from the transcript.")
	}

	@Test func theMenuListsKeychainRightAfterIntegrations() {
		let workspace = ProfileMenuItem.allCases.filter { $0.group == .workspace }
		let after = workspace.firstIndex(of: .integrations).map { workspace[$0 + 1] }
		#expect(after == .keychain)
		#expect(ProfileMenuItem.keychain.title == "Keychain")
	}
}

@Suite("APIKeychainSource")
struct APIKeychainSourceTests {
	/// The routes reject unknown fields (`.strict()`), so an extra one fails every add with a 400.
	@Test func anApiKeyIsSentWithExactlyTheFieldsTheServerAccepts() {
		let (path, body) = APIKeychainSource.addRequest(name: "Stripe", value: .apiKey("sk"))
		#expect(path == "api/integrations/byo-apikey")
		#expect(Set(body.keys) == ["displayName", "rawSecret"])
	}

	@Test func aLoginIsSentWithExactlyTheFieldsTheServerAccepts() {
		let (path, body) = APIKeychainSource.addRequest(name: "e-conomic", value: .login(username: "u", password: "p"))
		#expect(path == "api/integrations/byo-login")
		#expect(Set(body.keys) == ["displayName", "username", "password"])
	}
}
