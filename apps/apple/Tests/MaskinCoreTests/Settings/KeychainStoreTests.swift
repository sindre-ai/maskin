import Foundation
import Testing

@testable import MaskinCore

private actor FakeKeychain: KeychainAPI {
	var stored: [KeychainCredential]
	var team: [KeychainMember]
	private var failNext: KeychainAccessError?
	private(set) var writes: [String] = []
	private(set) var removed: [String] = []
	private(set) var added: [String] = []

	init(_ stored: [KeychainCredential], team: [KeychainMember]) {
		self.stored = stored
		self.team = team
	}

	func credentials() async throws -> [KeychainCredential] { stored }
	func members() async throws -> [KeychainMember] { team }
	func setAccess(credentialID: String, agentID: String, to grant: KeychainGrant?) async throws {
		if let failNext { self.failNext = nil; throw failNext }
		writes.append("\(agentID)=\(grant?.rawValue ?? "removed")")
	}
	func remove(credentialID: String) async throws {
		if let failNext { self.failNext = nil; throw failNext }
		removed.append(credentialID)
	}
	func audit(credentialID: String, before: String?) async throws -> KeychainAuditPage {
		before == nil
			? KeychainAuditPage(entries: [KeychainAuditEntry(id: "1", actorID: "a1", action: .read)], nextBeforeID: "1")
			: KeychainAuditPage(entries: [KeychainAuditEntry(id: "0", actorID: "me", action: .create, viaChat: false)], nextBeforeID: nil)
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
	private let infra = KeychainMember(id: "a1", name: "Infra", isAgent: true)
	private let cto = KeychainMember(id: "a2", name: "CTO", isAgent: true)
	private let me = KeychainMember(id: "me", name: "Sebastian", isAgent: false)
	private let magnus = KeychainMember(id: "p2", name: "Magnus", isAgent: false)

	private func store(
		_ creds: [KeychainCredential], canManage: Bool = false, api: FakeKeychain? = nil
	) -> (KeychainStore, FakeKeychain) {
		let fake = api ?? FakeKeychain(creds, team: [infra, cto, me, magnus])
		return (KeychainStore(api: fake, currentActorID: "me", canManageWorkspace: canManage), fake)
	}

	private func cred(
		_ id: String = "1", grants: [String: KeychainGrant] = [:], defaultOn: Bool = false,
		kind: KeychainCredential.Kind = .apiKey, status: String = "active", createdBy: String = "me"
	) -> KeychainCredential {
		KeychainCredential(
			id: id, name: "k", kind: kind, status: status, createdByID: createdBy, grants: grants, defaultOn: defaultOn)
	}

	// MARK: Who may use it: the server's rules

	@Test func anExplicitNoneRowIsOffAndAMissingRowFollowsTheDefault() {
		let blocked = cred(grants: ["a1": .none], defaultOn: true)
		#expect(blocked.allows("a1") == false)
		#expect(blocked.allows("a2"))
		#expect(cred(grants: ["a1": .readWrite], defaultOn: false).allows("a1"))
		#expect(cred(grants: [:], defaultOn: false).allows("a1") == false)
	}

	@Test func aNoneRowIsNotCountedAsSomeoneWhoCanUseIt() async {
		let (store, _) = store([cred(grants: ["a1": .none], defaultOn: false)])
		await store.load()
		#expect(store.scopeSummary(store.credentials[0]) == "No agents can use it")
		#expect(store.agentsWithAccess(store.credentials[0]).isEmpty)
	}

	@Test func aDefaultOnCredentialIsNotShownAsUnassigned() async {
		let (store, _) = store([cred(defaultOn: true)])
		await store.load()
		#expect(store.scopeSummary(store.credentials[0]) == "All agents")
		#expect(store.agentsWithAccess(store.credentials[0]).count == 2)
	}

	@Test func untickingAnAgentWhenTheDefaultIsOnWritesAnExplicitNone() async {
		let (store, fake) = store([cred(defaultOn: true)])
		await store.load()
		// Removing the row would leave the agent on, since the default is on: it needs a none row.
		#expect(await store.setAccess(of: store.credentials[0], to: ["a1"]))
		#expect(await fake.writes == ["a2=none"])
		#expect(store.credentials[0].allows("a2") == false)
		#expect(store.credentials[0].allows("a1"))
	}

	@Test func untickingAnAgentWhenTheDefaultIsOffRemovesItsRow() async {
		let (store, fake) = store([cred(grants: ["a1": .readWrite, "a2": .readWrite], defaultOn: false)])
		await store.load()
		#expect(await store.setAccess(of: store.credentials[0], to: ["a1"]))
		#expect(await fake.writes == ["a2=removed"])
	}

	@Test func anAgentExplicitlyDeniedStaysDeniedWhenNothingAboutItChanged() async {
		let (store, fake) = store([cred(grants: ["a2": .none], defaultOn: true)])
		await store.load()
		// a1 is on by default, a2 is blocked: saving the screen as it is must write nothing.
		#expect(await store.setAccess(of: store.credentials[0], to: ["a1"]))
		#expect(await fake.writes.isEmpty)
	}

	@Test func onlyTheAgentsThatChangedAreWritten() async {
		let (store, fake) = store([cred(grants: ["a1": .readWrite], defaultOn: false)])
		await store.load()
		#expect(await store.setAccess(of: store.credentials[0], to: ["a1", "a2"]))
		#expect(await fake.writes == ["a2=read_write"])
	}

	@Test func aRefusedChangeKeepsWhatWasWrittenAndSaysWhy() async {
		let (store, fake) = store([cred(grants: ["a1": .readWrite], defaultOn: false)])
		await store.load()
		await fake.failOnce(KeychainAccessError("Couldn't update access: it is still inside its undo window."))
		#expect(await store.setAccess(of: store.credentials[0], to: ["a1", "a2"]) == false)
		#expect(store.credentials[0].allows("a2") == false)
		#expect(store.actionError == "Couldn't update access: it is still inside its undo window.")
	}

	@Test func onlyALiveSavedKeyOrLoginCanHaveItsAccessEdited() {
		#expect(cred().canEditAccess)
		#expect(cred(kind: .login).canEditAccess)
		#expect(cred(kind: .oauth).canEditAccess == false)
		#expect(cred(status: "pending_undo").canEditAccess == false)
	}

	// MARK: Removing

	@Test func removingIsOfferedToTheSaverOrAnAdminOnly() {
		let (plain, _) = store([])
		#expect(plain.canRemove(cred(createdBy: "me")))
		#expect(plain.canRemove(cred(createdBy: "p2")) == false)
		let (admin, _) = store([], canManage: true)
		#expect(admin.canRemove(cred(createdBy: "p2")))
	}

	@Test func removingTakesItOutOfTheList() async {
		let (store, fake) = store([cred()])
		await store.load()
		#expect(await store.remove(store.credentials[0]))
		#expect(store.credentials.isEmpty)
		#expect(await fake.removed == ["1"])
	}

	// MARK: Listing, adding, activity

	@Test func listsNewestFirst() async {
		let old = KeychainCredential(id: "1", name: "Old", kind: .login, createdAt: Date(timeIntervalSince1970: 1))
		let new = KeychainCredential(id: "2", name: "New", kind: .apiKey, createdAt: Date(timeIntervalSince1970: 9))
		let (store, _) = store([old, new])
		await store.load()
		#expect(store.credentials.map(\.id) == ["2", "1"])
	}

	@Test func addingReloadsTheListAndCanShareItInTheSameStep() async {
		let (store, fake) = store([])
		await store.load()
		#expect(await store.add(name: "Stripe", value: .apiKey("k"), agentIDs: ["a1", "a2"]) == .saved)
		#expect(await fake.writes == ["a1=read_write", "a2=read_write"])
		#expect(store.credentials.map(\.name) == ["Stripe"])
	}

	@Test func aCredentialThatSavedButCouldNotBeSharedCountsAsSavedAndSaysSo() async {
		let fake = FakeKeychain([], team: [infra])
		let (store, _) = store([], api: fake)
		await store.load()
		await fake.failOnce(KeychainAccessError("nope"))
		// The first call is the share (the add does not consume the failure), so it fails there.
		let outcome = await store.add(name: "Stripe", value: .apiKey("k"), agentIDs: ["a1"])
		#expect(outcome == .savedNotShared)
		#expect(outcome.didSave)
		#expect(store.credentials.map(\.name) == ["Stripe"])
		#expect(store.actionError == "nope")
	}

	@Test func activityNamesPeopleAndYouNeverAnIdOrUnknownAgent() async {
		let (store, _) = store([cred()])
		await store.load()
		#expect(store.actorName("me") == "You")
		#expect(store.actorName("p2") == "Magnus")
		#expect(store.actorName("a1") == "Infra")
		#expect(store.actorName("deadbeef") == "Someone")
		await store.loadAudit(for: store.credentials[0])
		#expect(store.sentence(for: store.audit[0]) == "Infra read this credential.")
		await store.loadAudit(for: store.credentials[0], more: true)
		#expect(store.sentence(for: store.audit[1]) == "You added this credential.")
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

	@Test func theServersReasonIsShownForARefusedAccessChange() {
		#expect(APIKeychainSource.refusal(409, "It is still inside its undo window.").message == "Couldn't update access: It is still inside its undo window.")
		#expect(APIKeychainSource.refusal(0, nil).message == "Couldn't update access.")
	}
}
