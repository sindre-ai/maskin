import Foundation
import Testing

@testable import MaskinCore

private final class FakeDevice: DeviceSignInAPI, @unchecked Sendable {
	private let lock = NSLock()
	var failure: SettingsError?
	private var _log: [String] = []
	var log: [String] { lock.withLock { _log } }
	func preview(code: String) async throws -> DeviceSignInPreview {
		lock.withLock { _log.append("preview \(code)") }
		if let failure { throw failure }
		return DeviceSignInPreview(client: "tvos", deviceName: "Living room")
	}
	func approve(code: String, idempotencyKey: String) async throws {
		lock.withLock { _log.append("approve \(code)") }
		if let failure { throw failure }
	}
	func deny(code: String, idempotencyKey: String) async throws {
		lock.withLock { _log.append("deny \(code)") }
	}
}

@Suite("Device sign-in")
struct DeviceSignInTests {
	@Test func normalizesLikeTheServer() {
		#expect(DeviceCode.normalize("bcdf-2345") == "BCDF2345")
		#expect(DeviceCode.normalize(" BCDF 2345 ") == "BCDF2345")
		#expect(DeviceCode.normalize("BCDF-234") == nil)
		// Vowels and 0/1 are not in the alphabet.
		#expect(DeviceCode.normalize("ABCD-2345") == nil)
		#expect(DeviceCode.normalize("BCDF-2340") == nil)
	}

	@Test func typingKeepsOnlyCodeCharactersAndAddsTheDash() {
		#expect(DeviceCode.typed("bcdf23") == "BCDF-23")
		#expect(DeviceCode.typed("bcdf-2345-9999") == "BCDF-2345")
		#expect(DeviceCode.typed("a!b") == "B")
	}

	@Test func deviceLabelNamesTheKindAndTheDevice() {
		#expect(DeviceSignInPreview(client: "tvos", deviceName: "Living room").deviceLabel == "Apple TV · Living room")
		#expect(DeviceSignInPreview(client: "tvos", deviceName: nil).deviceLabel == "Apple TV")
	}

	@MainActor @Test func approveWalksCodeThenConfirmThenApproved() async {
		let api = FakeDevice()
		let store = DeviceSignInStore(api: api)
		#expect(!store.canContinue)
		store.setCode("bcdf2345")
		#expect(store.canContinue)
		await store.lookUp()
		guard case .confirm(let preview) = store.step else { Issue.record("not confirming"); return }
		#expect(preview.deviceName == "Living room")
		await store.approve()
		#expect(store.step == .approved)
		#expect(api.log == ["preview BCDF2345", "approve BCDF2345"])
	}

	@MainActor @Test func refuseSendsDeny() async {
		let api = FakeDevice()
		let store = DeviceSignInStore(api: api)
		store.setCode("BCDF-2345")
		await store.lookUp()
		await store.refuse()
		#expect(store.step == .refused)
		#expect(api.log.last == "deny BCDF2345")
	}

	@MainActor @Test func aWrongCodeStaysOnTheFormWithTheServersSentence() async {
		let api = FakeDevice()
		api.failure = SettingsError("That code isn't valid or has expired. Check the screen on your device.")
		let store = DeviceSignInStore(api: api)
		store.setCode("BCDF2345")
		await store.lookUp()
		#expect(store.step == .enterCode)
		#expect(store.error?.contains("isn't valid") == true)
	}

	@MainActor @Test func incompleteCodeNeverCallsTheServer() async {
		let api = FakeDevice()
		let store = DeviceSignInStore(api: api)
		store.setCode("BCDF")
		await store.lookUp()
		#expect(api.log.isEmpty)
	}
}

private final class FakeInvites: InvitationsAPI, @unchecked Sendable {
	private let lock = NSLock()
	var list: [PendingInvitation] = []
	var failure: SettingsError?
	private var _log: [String] = []
	var log: [String] { lock.withLock { _log } }
	func pending(workspaceId: String) async throws -> [PendingInvitation] { list }
	func invite(workspaceId: String, email: String, idempotencyKey: String) async throws {
		lock.withLock { _log.append("invite \(email)") }
		if let failure { throw failure }
	}
	func resend(id: String, idempotencyKey: String) async throws { lock.withLock { _log.append("resend \(id)") } }
	func revoke(id: String, idempotencyKey: String) async throws {
		lock.withLock { _log.append("revoke \(id)") }
		if let failure { throw failure }
	}
}

@Suite("Invitations")
struct InvitationsTests {
	@Test func emailValidation() {
		#expect(InvitationsStore.isValidEmail("a@b.co"))
		#expect(!InvitationsStore.isValidEmail("a@b"))
		#expect(!InvitationsStore.isValidEmail("a b@c.com"))
		#expect(!InvitationsStore.isValidEmail("@c.com"))
		#expect(!InvitationsStore.isValidEmail("a@c..com"))
	}

	@Test func expiryText() {
		let now = Date(timeIntervalSince1970: 1_000_000)
		let inDays = { (d: Double) in PendingInvitation(id: "1", email: "a@b.co", role: "member", expiresAt: now.addingTimeInterval(d * 86_400 - 60)) }
		#expect(inDays(5).expiryText(now: now) == "Expires in 5 days")
		#expect(inDays(1).expiryText(now: now) == "Expires today")
		#expect(inDays(-1).expiryText(now: now) == "Expired")
		#expect(PendingInvitation(id: "1", email: "a@b.co", role: "member", expiresAt: nil).expiryText() == nil)
	}

	@MainActor @Test func inviteTrimsSendsAndReloads() async {
		let api = FakeInvites()
		let store = InvitationsStore(api: api, workspaceId: "w", canManage: true)
		let ok = await store.invite(email: "  bente@firm.dk ")
		#expect(ok)
		#expect(api.log == ["invite bente@firm.dk"])
		#expect(store.notice == "Invitation sent to bente@firm.dk.")
	}

	@MainActor @Test func membersWhoCannotManageNeverCallTheServer() async {
		let api = FakeInvites()
		let store = InvitationsStore(api: api, workspaceId: "w", canManage: false)
		#expect(await store.invite(email: "a@b.co") == false)
		await store.load()
		#expect(api.log.isEmpty)
		#expect(store.pending.isEmpty)
	}

	@MainActor @Test func clearErrorDropsTheStaleMessage() async {
		let api = FakeInvites()
		api.failure = SettingsError("Nope")
		let store = InvitationsStore(api: api, workspaceId: "w", canManage: true)
		_ = await store.invite(email: "a@b.co")
		#expect(store.actionError == "Nope")
		store.clearError()
		#expect(store.actionError == nil)
	}

	@MainActor @Test func cancelRemovesTheRowOnlyOnSuccess() async {
		let api = FakeInvites()
		let item = PendingInvitation(id: "i1", email: "a@b.co", role: "member", expiresAt: nil)
		api.list = [item]
		let store = InvitationsStore(api: api, workspaceId: "w", canManage: true)
		await store.load()
		api.failure = SettingsError("Nope")
		await store.cancel(item)
		#expect(store.pending.count == 1)
		#expect(store.actionError == "Nope")
		api.failure = nil
		await store.cancel(item)
		#expect(store.pending.isEmpty)
	}
}

private final class FakeExtensions: ExtensionsAPI, @unchecked Sendable {
	var items: [WorkspaceExtension] = []
	var failure: SettingsError?
	func list() async throws -> [WorkspaceExtension] { items }
	func setEnabled(id: String, enabled: Bool, idempotencyKey: String) async throws -> WorkspaceExtension {
		if let failure { throw failure }
		var ext = items.first { $0.id == id }!
		ext.status = enabled ? .active : .disabled
		return ext
	}
}

@Suite("Extensions")
struct ExtensionsTests {
	@MainActor @Test func listIsAlphabeticalAndSwitchUpdatesTheRow() async {
		let api = FakeExtensions()
		api.items = [
			WorkspaceExtension(id: "2", name: "webhooks", status: .active, webhookURL: "https://x/hook"),
			WorkspaceExtension(id: "1", name: "Calendar", status: .disabled, hasMcp: true),
		]
		let store = ExtensionsStore(api: api, canManage: true)
		await store.load()
		#expect(store.extensions.map(\.name) == ["Calendar", "webhooks"])
		await store.setEnabled(true, for: store.extensions[0])
		#expect(store.extensionRow(id: "1")?.status == .active)
		#expect(store.extensionRow(id: "1")?.statusLabel == "On")
	}

	@MainActor @Test func nonOwnersAndDraftsCannotSwitch() async {
		let api = FakeExtensions()
		api.items = [WorkspaceExtension(id: "1", name: "A", status: .draft)]
		let store = ExtensionsStore(api: api, canManage: true)
		await store.load()
		await store.setEnabled(true, for: store.extensions[0])
		#expect(store.extensions[0].status == .draft)
		let readOnly = ExtensionsStore(api: api, canManage: false)
		await readOnly.load()
		await readOnly.setEnabled(true, for: readOnly.extensions[0])
		#expect(readOnly.extensions[0].status == .draft)
	}

	@Test func summaryOnlyNamesWhatItHas() {
		#expect(WorkspaceExtension(id: "1", name: "A", status: .active).summary == nil)
		#expect(WorkspaceExtension(id: "1", name: "A", status: .active, hasWebhook: true).summary == "Webhook")
		#expect(WorkspaceExtension(id: "1", name: "A", status: .active, hasWebhook: true, hasMcp: true).summary == "Webhook and tool server")
	}
}

@Suite("Tool servers and Claude")
struct ToolServerTests {
	@Test func aKeyNeedsHTTPS() {
		let plain = ToolServerDraft(name: "n", url: "http://x.io", key: "k")
		#expect(!plain.isValid)
		#expect(plain.keyProblem != nil)
		#expect(ToolServerDraft(name: "n", url: "https://x.io", key: "k").isValid)
		#expect(ToolServerDraft(name: "n", url: "http://x.io").isValid)
	}

	@Test func draftValidation() {
		#expect(ToolServerDraft(name: "linear-mcp", url: "https://mcp.linear.app/mcp").isValid)
		#expect(!ToolServerDraft(name: "", url: "https://x.io").isValid)
		#expect(!ToolServerDraft(name: "a", url: "ftp://x.io").isValid)
		#expect(!ToolServerDraft(name: "a", url: "not a url").isValid)
		#expect(!ToolServerDraft(name: String(repeating: "a", count: 61), url: "https://x.io").isValid)
	}

	@Test func bodyCarriesTheKeyAsABearerHeaderOnlyWhenGiven() throws {
		let withKey = try JSONSerialization.jsonObject(
			with: ToolServerDraft(name: " n ", url: "https://x.io", key: "k").requestBody()) as? [String: Any]
		let server = withKey?["server"] as? [String: Any]
		#expect(withKey?["name"] as? String == "n")
		#expect(server?["type"] as? String == "http")
		#expect((server?["headers"] as? [String: String])?["Authorization"] == "Bearer k")
		let bare = try JSONSerialization.jsonObject(
			with: ToolServerDraft(name: "n", url: "https://x.io").requestBody()) as? [String: Any]
		#expect((bare?["server"] as? [String: Any])?["headers"] == nil)
	}

	@Test func claudeSlotLabelsNeverShowAnId() {
		#expect(ClaudeSlot(id: "primary", subscriptionType: "max").title == "Claude Max")
		#expect(ClaudeSlot(id: "primary", nickname: "Work", subscriptionType: "max").title == "Work")
		#expect(ClaudeSlot(id: "slot_3").title == "Claude subscription")
	}

	@MainActor @Test func toolServerRowsAreSeparatedAndNamed() async {
		let fake = FakeSettings()
		fake.connectedList = [
			ConnectedIntegration(id: "1", provider: "slack", state: .connected),
			ConnectedIntegration(id: "2", provider: IntegrationsStore.toolServerProvider, state: .connected, displayName: "ahrefs-mcp"),
			ConnectedIntegration(id: "3", provider: IntegrationsStore.toolServerProvider, state: .connected),
		]
		let store = IntegrationsStore(api: fake, currentRole: .admin)
		await store.load()
		#expect(store.accounts.map(\.id) == ["1"])
		#expect(Set(store.toolServers.map { store.displayName(for: $0) }) == ["ahrefs-mcp", "Tool server"])
	}
}

@Suite("Integration tabs, search and categories")
struct IntegrationFilterTests {
	@MainActor private func loadedStore() async -> IntegrationsStore {
		let fake = FakeSettings()
		fake.providerList = [
			IntegrationProvider(id: "slack", displayName: "Slack", authKind: .oauth),
			IntegrationProvider(id: "gmail", displayName: "Gmail", authKind: .oauth),
			IntegrationProvider(id: "github", displayName: "GitHub", authKind: .oauth),
		]
		fake.connectedList = [
			ConnectedIntegration(id: "1", provider: "slack", state: .connected),
			ConnectedIntegration(
				id: "2", provider: IntegrationsStore.toolServerProvider, state: .connected,
				displayName: "internal-crm"),
		]
		let store = IntegrationsStore(api: fake, currentRole: .admin)
		await store.load()
		return store
	}

	@MainActor @Test func tabsCountConnectedAndUnconnected() async {
		let store = await loadedStore()
		#expect(store.connectedCount == 2)
		#expect(store.discoverCount == 2)
	}

	@MainActor @Test func discoverFiltersBySearchAndCategory() async {
		let store = await loadedStore()
		#expect(store.availableProviders(query: "hub", category: nil).map(\.id) == ["github"])
		#expect(store.availableProviders(query: "", category: .code).map(\.id) == ["github"])
		#expect(store.availableProviders(query: "", category: .emailAndCalendar).map(\.id) == ["gmail"])
		#expect(store.availableProviders(query: "zzz", category: nil).isEmpty)
	}

	@MainActor @Test func toolServersSitUnderAllAndCustomOnly() async {
		let store = await loadedStore()
		#expect(store.connectedToolServers(query: "", category: nil).count == 1)
		#expect(store.connectedToolServers(query: "", category: .custom).count == 1)
		#expect(store.connectedToolServers(query: "", category: .code).isEmpty)
		#expect(store.connectedToolServers(query: "crm", category: nil).count == 1)
		#expect(store.connectedToolServers(query: "nope", category: nil).isEmpty)
	}

	@Test func unknownProvidersFallUnderDocsAndData() {
		#expect(IntegrationCategory.category(for: "brand-new") == .docsAndData)
		#expect(IntegrationCategory.category(for: "slack") == .chatAndSocial)
		#expect(IntegrationCategory.category(for: IntegrationsStore.toolServerProvider) == .custom)
	}
}

private final class FakeAccess: IntegrationAccessAPI, @unchecked Sendable {
	var current = IntegrationGrants(defaultAccess: .read, byAgent: ["b": .readWrite])
	var failure: SettingsError?
	/// When set, the write for this actor parks on `gate`, then fails with `failure`.
	var parkedActor: String?
	var gate: Gate?
	var chat: [ChatGrant] = []
	var chatFailure: SettingsError?
	var removed: [String] = []
	func grants(integrationId: String) async throws -> IntegrationGrants { current }
	func chatGrants(integrationId: String) async throws -> [ChatGrant] {
		if let chatFailure { throw chatFailure }
		return chat
	}
	func removeChatGrant(integrationId: String, grantId: String, idempotencyKey: String) async throws {
		if let failure { throw failure }
		removed.append(grantId)
	}
	func setGrant(integrationId: String, actorId: String, access: AgentAccess, idempotencyKey: String) async throws {
		if actorId == parkedActor {
			await gate?.wait()
			throw SettingsError("Refused")
		}
		if let failure { throw failure }
	}
}

@Suite("Integration agent access")
struct IntegrationAccessTests {
	private let agents = [
		IntegrationAccessStore.AgentRef(id: "b", name: "Developer"),
		IntegrationAccessStore.AgentRef(id: "a", name: "code reviewer"),
	]

	@MainActor @Test func agentsWithoutARowShowTheDefaultAndAreAlphabetical() async {
		let store = IntegrationAccessStore(api: FakeAccess(), integrationId: "i", agents: agents, canManage: true)
		await store.load()
		#expect(store.agents.map(\.name) == ["code reviewer", "Developer"])
		#expect(store.access(for: "a") == .read)
		#expect(store.access(for: "b") == .readWrite)
	}

	@MainActor @Test func aRefusedChangeIsPutBack() async {
		let api = FakeAccess()
		let store = IntegrationAccessStore(api: api, integrationId: "i", agents: agents, canManage: true)
		await store.load()
		api.failure = SettingsError("Only a person can change agent access")
		await store.set(.none, for: agents[1])
		#expect(store.access(for: "a") == .read)
		#expect(store.actionError == "Only a person can change agent access")
	}

	@MainActor @Test func aFailedWriteOnlyRevertsItsOwnAgent() async {
		let api = FakeAccess()
		let gate = Gate()
		api.parkedActor = "a"
		api.gate = gate
		let store = IntegrationAccessStore(api: api, integrationId: "i", agents: agents, canManage: true)
		await store.load()
		let first = Task { await store.set(.none, for: agents[1]) }
		await gate.waitUntilStarted()
		await store.set(.read, for: agents[0])
		#expect(store.access(for: "b") == .read)
		await gate.release()
		await first.value
		#expect(store.access(for: "a") == .read)
		#expect(store.access(for: "b") == .read)
		#expect(store.grants.byAgent["b"] == .read)
	}

	@MainActor @Test func readersCannotChange() async {
		let store = IntegrationAccessStore(api: FakeAccess(), integrationId: "i", agents: agents, canManage: false)
		await store.load()
		await store.set(.none, for: agents[1])
		#expect(store.access(for: "a") == .read)
	}

	@MainActor @Test func chatGrantsAreListedAndRemovedOnce() async {
		let api = FakeAccess()
		api.chat = [ChatGrant(id: "g1", actorId: "a", expiresAt: nil), ChatGrant(id: "g2", actorId: "b", expiresAt: nil)]
		let store = IntegrationAccessStore(api: api, integrationId: "i", agents: agents, canManage: true)
		await store.load()
		#expect(store.chatGrants.map(\.id) == ["g1", "g2"])
		await store.removeChatGrant(store.chatGrants[0])
		#expect(api.removed == ["g1"])
		#expect(store.chatGrants.map(\.id) == ["g2"])
	}

	@MainActor @Test func aRefusedRemoveKeepsTheGrantAndSaysWhy() async {
		let api = FakeAccess()
		api.chat = [ChatGrant(id: "g1", actorId: "a", expiresAt: nil)]
		let store = IntegrationAccessStore(api: api, integrationId: "i", agents: agents, canManage: true)
		await store.load()
		api.failure = SettingsError("Only a person can change agent access")
		await store.removeChatGrant(store.chatGrants[0])
		#expect(store.chatGrants.map(\.id) == ["g1"])
		#expect(store.actionError == "Only a person can change agent access")
	}

	@MainActor @Test func readersCannotRemoveAChatGrant() async {
		let api = FakeAccess()
		api.chat = [ChatGrant(id: "g1", actorId: "a", expiresAt: nil)]
		let store = IntegrationAccessStore(api: api, integrationId: "i", agents: agents, canManage: false)
		await store.load()
		await store.removeChatGrant(store.chatGrants[0])
		#expect(api.removed.isEmpty)
		#expect(store.chatGrants.count == 1)
	}

	@MainActor @Test func aChatListThatFailsToLoadDoesNotBreakThePage() async {
		let api = FakeAccess()
		api.chatFailure = SettingsError("down")
		let store = IntegrationAccessStore(api: api, integrationId: "i", agents: agents, canManage: true)
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.chatGrants.isEmpty)
	}

	@Test func aChatGrantSaysWhenItEnds() {
		#expect(ChatGrant(id: "g", actorId: "a", expiresAt: nil).detail == "Only in one chat")
		#expect(ChatGrant(id: "g", actorId: "a", expiresAt: Date(timeIntervalSince1970: 0)).detail.hasPrefix("Only in one chat · expires "))
	}

	@Test func chatGrantDatesReadWithAndWithoutFractions() {
		#expect(APISettingsIntegrationAccessSource.date("2026-11-13T20:00:00.000Z") != nil)
		#expect(APISettingsIntegrationAccessSource.date("2026-11-13T20:00:00Z") != nil)
		#expect(APISettingsIntegrationAccessSource.date(nil) == nil)
	}

	@Test func labelsMatchTheServer() {
		#expect(AgentAccess.readWrite.label == "Read & write")
		#expect(AgentAccess.none.label == "No access")
	}
}
