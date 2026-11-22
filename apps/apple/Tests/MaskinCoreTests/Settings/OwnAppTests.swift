import Foundation
import Testing

@testable import MaskinCore

/// An own-app API that records its calls. State sits behind a lock: the protocol is async and
/// nonisolated.
final class FakeOwnApp: OwnAppAPI, @unchecked Sendable {
	private let lock = NSLock()
	private var _calls: [String] = []
	private var _secrets: [String] = []
	private var _keys: [String] = []
	var current = OwnAppStatus(configured: false, callbackURL: "https://maskin.example/api/integrations/salesforce/callback")
	var statusFailure: SettingsError?
	var saveFailure: SettingsError?
	var removeFailure: SettingsError?

	var calls: [String] { lock.withLock { _calls } }
	/// What `save` was sent, so a test can prove the secret went out once and nowhere else.
	var sentSecrets: [String] { lock.withLock { _secrets } }
	var idempotencyKeys: [String] { lock.withLock { _keys } }

	func status(provider: String) async throws -> OwnAppStatus {
		try lock.withLock {
			_calls.append("status:\(provider)")
			if let statusFailure { throw statusFailure }
			return current
		}
	}

	func save(provider: String, clientId: String, clientSecret: String, idempotencyKey: String)
		async throws -> OwnAppStatus
	{
		try lock.withLock {
			_calls.append("save:\(provider):\(clientId)")
			_secrets.append(clientSecret)
			_keys.append(idempotencyKey)
			if let saveFailure { throw saveFailure }
			// Never returns the secret, like the server.
			current = OwnAppStatus(configured: true, clientId: clientId, callbackURL: current.callbackURL)
			return current
		}
	}

	func remove(provider: String, idempotencyKey: String) async throws {
		try lock.withLock {
			_calls.append("remove:\(provider)")
			_keys.append(idempotencyKey)
			if let removeFailure { throw removeFailure }
			current = OwnAppStatus(configured: false, callbackURL: current.callbackURL)
		}
	}
}

@MainActor
@Suite("OwnAppStore")
struct OwnAppStoreTests {
	private func make(_ api: FakeOwnApp, connected: Bool = false) -> OwnAppStore {
		OwnAppStore(
			prompt: OwnAppPrompt(providerID: "salesforce", providerName: "Salesforce", connected: connected),
			api: api)
	}

	@Test("a tool with no app saved reads Connect, with the web's wording")
	func firstTime() async {
		let store = make(FakeOwnApp())
		await store.load()
		#expect(store.title == "Connect Salesforce")
		#expect(store.saveTitle == "Save and connect")
		#expect(store.secretPlaceholder == "Consumer secret")
		#expect(store.idPlaceholder == "Consumer key")
		#expect(store.connectsAfterSave)
		#expect(
			store.explanation
				== "Salesforce lets only your own admin create the app that signs in. Create it in your Salesforce account, then paste its id and secret here. The secret is stored encrypted and is never shown again."
		)
		#expect(store.status?.callbackURL == "https://maskin.example/api/integrations/salesforce/callback")
	}

	@Test("a saved app reads Change the app, and asks for the whole pair again")
	func changing() async {
		let api = FakeOwnApp()
		api.current = OwnAppStatus(configured: true, clientId: "3MVG-old", callbackURL: "https://x/cb")
		let store = make(api, connected: true)
		await store.load()
		#expect(store.replacing)
		#expect(store.title == "Change the Salesforce app")
		#expect(store.saveTitle == "Save")
		#expect(store.idPlaceholder == "3MVG-old")
		#expect(store.secretPlaceholder == "Paste the secret again to replace it")
		#expect(store.explanation.hasSuffix(" If you change to a different app, reconnect afterwards."))
		// Connected already: saving replaces the app and does not start a new sign-in.
		#expect(!store.connectsAfterSave)
	}

	@Test("the reconnect line is only for a tool that is connected")
	func reconnectLine() async {
		let api = FakeOwnApp()
		api.current = OwnAppStatus(configured: true, clientId: "id", callbackURL: "https://x/cb")
		let store = make(api, connected: false)
		await store.load()
		#expect(!store.explanation.contains("reconnect afterwards"))
		// Not connected: saving carries on to the sign-in, as on the web.
		#expect(store.connectsAfterSave)
		#expect(store.saveTitle == "Save")
	}

	@Test("save needs both fields")
	func needsBoth() {
		let store = make(FakeOwnApp())
		#expect(!store.canSave)
		store.clientId = "  3MVG-id  "
		#expect(!store.canSave)
		store.clientSecret = "s3cret"
		#expect(store.canSave)
		store.clientId = "   "
		#expect(!store.canSave)
	}

	@Test("saving sends the trimmed id and the secret once, then forgets the secret")
	func saves() async {
		let api = FakeOwnApp()
		let store = make(api)
		await store.load()
		store.clientId = "  3MVG-id  "
		store.clientSecret = "s3cret"
		await store.save()
		#expect(api.calls == ["status:salesforce", "save:salesforce:3MVG-id"])
		#expect(api.sentSecrets == ["s3cret"])
		#expect(api.idempotencyKeys.count == 1)
		#expect(store.didSave)
		#expect(store.error == nil)
		#expect(store.clientSecret.isEmpty)
		#expect(store.status?.clientId == "3MVG-id")
		// Nothing the store prints holds the secret.
		#expect(!String(describing: store.status as Any).contains("s3cret"))
		// A second tap does nothing.
		store.clientSecret = "again"
		#expect(!store.canSave)
	}

	@Test("a refused save keeps the form, shows the reason and holds on to the typed values")
	func saveFails() async {
		let api = FakeOwnApp()
		api.saveFailure = SettingsError("Only a workspace admin or owner can change the sign-in app.")
		let store = make(api)
		store.clientId = "id"
		store.clientSecret = "s3cret"
		await store.save()
		#expect(!store.didSave)
		#expect(store.error == "Only a workspace admin or owner can change the sign-in app.")
		#expect(store.clientSecret == "s3cret")
		#expect(store.canSave)
	}

	@Test("a failed lookup still leaves the form usable and says what is missing")
	func lookupFails() async {
		let api = FakeOwnApp()
		api.statusFailure = .offline
		let store = make(api)
		await store.load()
		#expect(store.status == nil)
		#expect(store.error == "You're offline.")
		#expect(!store.replacing)
		store.clientId = "id"
		store.clientSecret = "s"
		#expect(store.canSave)
		// A retry asks again.
		api.statusFailure = nil
		await store.load()
		#expect(store.status != nil)
	}

	@Test("remove needs a saved app and reports the server's refusal while connected")
	func remove() async {
		let api = FakeOwnApp()
		let store = make(api, connected: true)
		await store.load()
		#expect(!store.canRemove)
		await store.remove()
		#expect(api.calls == ["status:salesforce"])

		api.current = OwnAppStatus(configured: true, clientId: "id", callbackURL: "https://x/cb")
		let saved = make(api, connected: true)
		await saved.load()
		#expect(saved.canRemove)
		api.removeFailure = SettingsError("Disconnect Salesforce first: it still signs in and renews with this app.")
		await saved.remove()
		#expect(!saved.didRemove)
		#expect(saved.error == "Disconnect Salesforce first: it still signs in and renews with this app.")

		api.removeFailure = nil
		await saved.remove()
		#expect(saved.didRemove)
		#expect(saved.error == nil)
		#expect(api.calls.filter { $0.hasPrefix("remove") }.count == 2)
	}
}

@MainActor
@Suite("IntegrationsStore with an own-app provider")
struct IntegrationsOwnAppTests {
	private func callback(_ query: String) -> URL { URL(string: "maskin://integrations/callback?\(query)")! }

	private func make(
		_ fake: FakeSettings, _ own: FakeOwnApp?, auth: FakeWebAuth, role: MemberRole = .admin
	) -> IntegrationsStore {
		fake.providerList = [
			IntegrationProvider(id: "salesforce", displayName: "Salesforce", authKind: .oauth, customerApp: true),
			IntegrationProvider(id: "slack", displayName: "Slack", authKind: .oauth),
		]
		return IntegrationsStore(api: fake, currentRole: role, webAuth: auth, ownApp: own)
	}

	private func loaded(_ store: IntegrationsStore) async -> IntegrationsStore {
		await store.load()
		return store
	}

	@Test("with no app saved, Connect shows the form and starts no sign-in")
	func noApp() async {
		let fake = FakeSettings()
		let own = FakeOwnApp()
		let auth = FakeWebAuth()
		let store = await loaded(make(fake, own, auth: auth))
		await store.connect(providerID: "salesforce")
		#expect(
			store.ownAppPrompt
				== OwnAppPrompt(providerID: "salesforce", providerName: "Salesforce", connected: false))
		#expect(auth.opened.isEmpty)
		#expect(!fake.calls.contains { $0.hasPrefix("start-connect") })
		#expect(store.connectPhase == .idle)
		#expect(store.connectNotice == nil)
	}

	@Test("with an app saved, Connect goes straight to sign-in")
	func savedApp() async {
		let fake = FakeSettings()
		let own = FakeOwnApp()
		own.current = OwnAppStatus(configured: true, clientId: "id", callbackURL: "https://x/cb")
		let auth = FakeWebAuth()
		auth.result = .success(callback("status=connected&provider=salesforce&integration_id=i1"))
		let store = await loaded(make(fake, own, auth: auth))
		await store.connect(providerID: "salesforce")
		#expect(store.ownAppPrompt == nil)
		#expect(fake.calls.contains("start-connect:salesforce"))
		#expect(auth.opened.count == 1)
		#expect(store.connectNotice == IntegrationConnectCopy.connected("Salesforce"))
	}

	@Test("the form saves the app, then the sign-in starts without asking again")
	func afterSave() async {
		let fake = FakeSettings()
		let own = FakeOwnApp()
		let auth = FakeWebAuth()
		auth.result = .success(callback("status=connected&provider=salesforce&integration_id=i1"))
		let store = await loaded(make(fake, own, auth: auth))
		await store.connect(providerID: "salesforce")
		#expect(store.ownAppPrompt != nil)
		store.dismissOwnApp()
		#expect(store.ownAppPrompt == nil)
		let statusCalls = own.calls.count
		await store.connect(providerID: "salesforce", appChecked: true)
		#expect(own.calls.count == statusCalls)
		#expect(fake.calls.contains("start-connect:salesforce"))
		#expect(auth.opened.count == 1)
	}

	@Test("a lookup that fails is read as no app saved")
	func lookupFails() async {
		let own = FakeOwnApp()
		own.statusFailure = .offline
		let fake = FakeSettings()
		let store = await loaded(make(fake, own, auth: FakeWebAuth()))
		await store.connect(providerID: "salesforce")
		#expect(store.ownAppPrompt != nil)
		#expect(!fake.calls.contains { $0.hasPrefix("start-connect") })
	}

	@Test("a tool that does not want an app never asks for one")
	func otherTools() async {
		let fake = FakeSettings()
		let own = FakeOwnApp()
		let auth = FakeWebAuth()
		auth.result = .success(callback("status=connected&provider=slack&integration_id=i1"))
		let store = await loaded(make(fake, own, auth: auth))
		#expect(!store.needsOwnApp("slack"))
		await store.connect(providerID: "slack")
		#expect(own.calls.isEmpty)
		#expect(store.ownAppPrompt == nil)
		#expect(fake.calls.contains("start-connect:slack"))
	}

	@Test("without an own-app API the connect is the one it was")
	func noApi() async {
		let fake = FakeSettings()
		let auth = FakeWebAuth()
		auth.result = .success(callback("status=connected&provider=salesforce&integration_id=i1"))
		let store = await loaded(make(fake, nil, auth: auth))
		#expect(!store.needsOwnApp("salesforce"))
		await store.connect(providerID: "salesforce")
		#expect(store.ownAppPrompt == nil)
		#expect(fake.calls.contains("start-connect:salesforce"))
	}

	@Test("a person who cannot manage gets no form and no lookup")
	func viewer() async {
		let own = FakeOwnApp()
		let store = await loaded(make(FakeSettings(), own, auth: FakeWebAuth(), role: .member))
		await store.connect(providerID: "salesforce")
		store.changeApp(providerID: "salesforce")
		#expect(store.ownAppPrompt == nil)
		#expect(own.calls.isEmpty)
	}

	@Test("Change app opens the form for a connected tool, and only for one that wants an app")
	func changeApp() async {
		let store = await loaded(make(FakeSettings(), FakeOwnApp(), auth: FakeWebAuth()))
		store.changeApp(providerID: "slack")
		#expect(store.ownAppPrompt == nil)
		store.changeApp(providerID: "salesforce")
		#expect(
			store.ownAppPrompt
				== OwnAppPrompt(providerID: "salesforce", providerName: "Salesforce", connected: true))
	}
}

@Suite("Integration row menu with an own app")
struct OwnAppMenuTests {
	private func actions(hasOwnApp: Bool, canManage: Bool = true, toolServer: Bool = false)
		-> [SettingsRowRules.IntegrationAction]
	{
		SettingsRowRules.integrationActions(
			isToolServer: toolServer, canManage: canManage, canStartConnect: true, state: .connected,
			hasServices: true, hasOwnApp: hasOwnApp)
	}

	@Test("Change app sits between Agent access and Disconnect, for managers")
	func menu() {
		#expect(actions(hasOwnApp: true) == [.agentAccess, .changeApp, .disconnect])
		#expect(actions(hasOwnApp: false) == [.agentAccess, .disconnect])
		#expect(actions(hasOwnApp: true, canManage: false) == [.agentAccess, .disconnect])
		#expect(actions(hasOwnApp: true, toolServer: true) == [.agentAccess, .remove])
	}
}
