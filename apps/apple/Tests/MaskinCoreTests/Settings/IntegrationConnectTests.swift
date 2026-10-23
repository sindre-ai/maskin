import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

private func callback(_ query: String) -> URL {
	URL(string: "maskin://integrations/callback?\(query)")!
}

@Suite("IntegrationConnectOutcome.parse")
struct IntegrationCallbackParsingTests {
	@Test("connected, with and without the billing flag")
	func connected() {
		#expect(
			IntegrationConnectOutcome.parse(callback("status=connected&provider=slack&workspace_id=w&integration_id=i1"))
				== .connected(integrationId: "i1", billingRequired: false))
		#expect(
			IntegrationConnectOutcome.parse(
				callback("status=connected&provider=linkedin-unipile&integration_id=i2&billing=required"))
				== .connected(integrationId: "i2", billingRequired: true))
		// An unrecognised billing value is not "required".
		#expect(
			IntegrationConnectOutcome.parse(callback("status=connected&billing=maybe"))
				== .connected(integrationId: nil, billingRequired: false))
	}

	@Test("selection_required needs an integration id")
	func selection() {
		#expect(
			IntegrationConnectOutcome.parse(callback("status=selection_required&provider=github&integration_id=i3"))
				== .selectionRequired(integrationId: "i3"))
		#expect(
			IntegrationConnectOutcome.parse(callback("status=selection_required&provider=github"))
				== .failed(.unknown))
	}

	@Test("every server reason maps to its own failure")
	func reasons() {
		for reason in IntegrationConnectFailure.allCases {
			#expect(
				IntegrationConnectOutcome.parse(callback("status=error&provider=github&reason=\(reason.rawValue)"))
					== .failed(reason))
		}
		#expect(IntegrationConnectFailure.allCases.count == 14)
	}

	@Test("unknown, missing and malformed input becomes an unknown error")
	func malformed() {
		let bad = [
			"status=error&reason=something_new", "status=error", "status=weird", "status=", "provider=slack", "",
		]
		for query in bad {
			#expect(IntegrationConnectOutcome.parse(callback(query)) == .failed(.unknown), "\(query)")
		}
		// Not the callback URL at all.
		for raw in [
			"maskin://integrations/other?status=connected", "maskin://ws-1/objects/o1?status=connected",
			"https://maskin.io/native/integrations/callback?status=connected",
			"maskin://integrations/callback/extra?status=connected",
		] {
			#expect(IntegrationConnectOutcome.parse(URL(string: raw)!) == .failed(.unknown), "\(raw)")
		}
	}

	@Test("isCallback matches only the callback")
	func isCallback() {
		#expect(IntegrationConnectOutcome.isCallback(callback("status=connected")))
		#expect(IntegrationConnectOutcome.isCallback(URL(string: "maskin://integrations/callback")!))
		#expect(!IntegrationConnectOutcome.isCallback(URL(string: "maskin://integrations/x")!))
		#expect(!IntegrationConnectOutcome.isCallback(URL(string: "maskin://ws-1/objects/o1")!))
	}

	@Test("the router leaves the callback alone: no rejection, no pending link, even signed out")
	@MainActor
	func routerIgnoresCallback() {
		let router = DeepLinkRouter(
			isSignedIn: { false }, currentWorkspaceId: { nil }, memberWorkspaceIds: { nil },
			selectWorkspace: { _ in })
		#expect(router.open(callback("status=connected&provider=slack")))
		#expect(router.rejection == nil)
		#expect(router.pending == nil)
		#expect(router.incoming == nil)
	}

	@Test("copy: every reason has a sentence that names the provider and no ids")
	func copy() {
		for reason in IntegrationConnectFailure.allCases {
			let text = IntegrationConnectCopy.failureText(reason, name: "Slack")
			#expect(!text.isEmpty)
			#expect(!text.contains("_"), "\(reason): \(text)")
		}
		#expect(IntegrationConnectCopy.connectedBillingRequired("LinkedIn").text.contains("completed on the web"))
	}
}

@MainActor
@Suite("IntegrationsStore native connect")
struct IntegrationsConnectStoreTests {
	private func make(
		_ fake: FakeSettings, _ auth: FakeWebAuth?, role: MemberRole = .admin
	) -> IntegrationsStore {
		fake.providerList = [
			IntegrationProvider(id: "slack", displayName: "Slack", authKind: .oauth),
			IntegrationProvider(id: "github", displayName: "GitHub", authKind: .oauth),
			IntegrationProvider(id: "linkedin-unipile", displayName: "LinkedIn", authKind: .oauth),
			IntegrationProvider(id: "linear", displayName: "Linear", authKind: .oauth),
		]
		return IntegrationsStore(api: fake, currentRole: role, webAuth: auth)
	}

	@Test("connected: opens the install URL on the maskin scheme, then refreshes the list")
	func connects() async {
		let fake = FakeSettings()
		let auth = FakeWebAuth()
		auth.result = .success(callback("status=connected&provider=slack&integration_id=i1"))
		let store = make(fake, auth)
		await store.connect(providerID: "slack")
		#expect(auth.opened.map(\.scheme) == ["maskin"])
		#expect(auth.opened.first?.url == fake.connectStart.installURL)
		#expect(store.connectNotice == IntegrationConnectCopy.connected("Slack"))
		#expect(store.connectPhase == .idle)
		#expect(fake.calls == ["start-connect:slack", "providers", "connected"])
		#expect(fake.idempotencyKeys.count == 1)
	}

	@Test("billing=required is informational and offers nothing to tap")
	func billing() async {
		let auth = FakeWebAuth()
		auth.result = .success(callback("status=connected&provider=linkedin-unipile&billing=required"))
		let store = make(FakeSettings(), auth)
		await store.connect(providerID: "linkedin-unipile")
		#expect(store.connectNotice == IntegrationConnectCopy.connectedBillingRequired("LinkedIn"))
		#expect(store.connectNotice?.kind == .info)
	}

	@Test("an error callback shows its reason's sentence")
	func errorCallback() async {
		let auth = FakeWebAuth()
		auth.result = .success(callback("status=error&provider=slack&reason=denied"))
		let store = make(FakeSettings(), auth)
		await store.connect(providerID: "slack")
		#expect(store.connectNotice == IntegrationConnectCopy.failure(.denied, name: "Slack"))
	}

	@Test("closing the sheet is a quiet cancel, not an error")
	func cancelled() async {
		let auth = FakeWebAuth()
		auth.result = .failure(.cancelled)
		let store = make(FakeSettings(), auth)
		await store.connect(providerID: "github")
		#expect(store.connectNotice == IntegrationConnectCopy.cancelled("GitHub"))
		#expect(store.connectNotice?.kind == .info)
		#expect(store.connectPhase == .idle)
	}

	@Test("offline at start says so and never opens the sheet")
	func offline() async {
		let fake = FakeSettings()
		fake.failure = .offline
		let auth = FakeWebAuth()
		let store = make(fake, auth)
		await store.connect(providerID: "slack")
		#expect(store.connectNotice == IntegrationConnectCopy.offline)
		#expect(auth.opened.isEmpty)
		#expect(store.connectPhase == .idle)
	}

	@Test("a failed start is a plain retry message")
	func startFails() async {
		let fake = FakeSettings()
		fake.failure = SettingsError("Couldn't start connecting.")
		let store = make(fake, FakeWebAuth())
		await store.connect(providerID: "slack")
		#expect(store.connectNotice == IntegrationConnectCopy.couldNotStart("Slack"))
	}

	@Test("a second tap while one connect is running does nothing")
	func doubleTap() async {
		let fake = FakeSettings()
		let auth = FakeWebAuth()
		auth.holds = true
		auth.result = .success(callback("status=connected"))
		let store = make(fake, auth)
		let first = Task { await store.connect(providerID: "slack") }
		while store.connectPhase != .inBrowser(provider: "slack") { await Task.yield() }
		await store.connect(providerID: "slack")
		await store.connect(providerID: "github")
		#expect(auth.opened.count == 1)
		#expect(fake.calls.filter { $0.hasPrefix("start-connect") }.count == 1)
		auth.release()
		await first.value
		#expect(store.connectPhase == .idle)
	}

	@Test("members cannot connect, and providers without a native flow are ignored")
	func guards() async {
		let fake = FakeSettings()
		let auth = FakeWebAuth()
		let member = make(fake, auth, role: .member)
		await member.connect(providerID: "slack")
		let admin = make(fake, auth)
		await admin.connect(providerID: "linear")
		#expect(fake.calls.isEmpty)
		#expect(!admin.supportsNativeConnect("linear"))
		#expect(IntegrationsStore(api: fake, currentRole: .admin).supportsNativeConnect("slack") == false)
	}

	@Test("GitHub selection_required loads installations, then binds the chosen one")
	func githubSelection() async {
		let fake = FakeSettings()
		fake.installations = [
			GitHubInstallationChoice(id: "101", name: "acme"),
			GitHubInstallationChoice(id: "202", name: nil),
		]
		let auth = FakeWebAuth()
		auth.result = .success(callback("status=selection_required&provider=github&integration_id=pend-1"))
		let store = make(fake, auth)
		await store.connect(providerID: "github")
		#expect(store.connectPhase == .choosingInstallation(provider: "github"))
		#expect(store.installationPicker?.choices.map(\.id) == ["101", "202"])
		// Still blocks a new connect while the picker is up.
		await store.connect(providerID: "slack")
		#expect(auth.opened.count == 1)

		await store.chooseInstallation(fake.installations[0])
		#expect(fake.calls.contains("select-installation:pend-1:101"))
		#expect(store.connectNotice == IntegrationConnectCopy.connected("GitHub"))
		#expect(store.connectPhase == .idle)
		#expect(store.installationPicker == nil)
	}

	@Test("dismissing the picker ends the connect without binding anything")
	func pickerDismissed() async {
		let fake = FakeSettings()
		fake.installations = [GitHubInstallationChoice(id: "101", name: "acme")]
		let auth = FakeWebAuth()
		auth.result = .success(callback("status=selection_required&integration_id=pend-1"))
		let store = make(fake, auth)
		await store.connect(providerID: "github")
		store.cancelInstallationChoice()
		#expect(store.connectPhase == .idle)
		#expect(!fake.calls.contains { $0.hasPrefix("select-installation") })
		#expect(store.connectNotice?.kind == .info)
	}

	@Test("no reachable installations is an error, not an empty picker")
	func noInstallations() async {
		let auth = FakeWebAuth()
		auth.result = .success(callback("status=selection_required&integration_id=pend-1"))
		let store = make(FakeSettings(), auth)
		await store.connect(providerID: "github")
		#expect(store.installationPicker == nil)
		#expect(store.connectNotice?.kind == .failure)
		#expect(store.connectPhase == .idle)
	}
}

private final class BodyTransport: ClientTransport, @unchecked Sendable {
	private let lock = NSLock()
	private var _requests: [(path: String, headers: HTTPFields, body: String)] = []
	var requests: [(path: String, headers: HTTPFields, body: String)] { lock.withLock { _requests } }

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		var text = ""
		if let body { text = String(decoding: try await Data(collecting: body, upTo: 1 << 20), as: UTF8.self) }
		lock.withLock { _requests.append((request.path ?? "", request.headerFields, text)) }
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		let json =
			request.path?.contains("linkedin") == true
			? #"{"install_url":"https://hosted.example/wizard","integration_id":"8d1f0a4e-3c63-4e1b-9d2e-0c6f7a2b1c11"}"#
			: #"{"install_url":"https://maskin.example/api/integrations/slack/native-launch?ticket=t"}"#
		return (response, HTTPBody(json))
	}
}

@Suite("Native connect request")
struct NativeConnectRequestTests {
	private func source(_ transport: BodyTransport) -> APISettingsSource {
		let client = Client(
			serverURL: URL(string: "http://localhost:3000")!, transport: transport,
			middlewares: [IdempotencyMiddleware()])
		return APISettingsSource(client: client, workspaceID: "ws-1")
	}

	@Test("slack/github connect sends native_return_url exactly, with the workspace and idempotency headers")
	func genericBody() async throws {
		let transport = BodyTransport()
		let start = try await source(transport).startConnect(provider: "slack", idempotencyKey: "k-1")
		let request = try #require(transport.requests.first)
		#expect(request.path == "/api/integrations/slack/connect")
		let decoded = try JSONSerialization.jsonObject(with: Data(request.body.utf8)) as? [String: String]
		#expect(decoded == ["native_return_url": "maskin://integrations/callback"])
		#expect(request.headers[IdempotencyMiddleware.header] == "k-1")
		#expect(request.headers[HTTPField.Name("X-Workspace-Id")!] == "ws-1")
		#expect(start.installURL.host == "maskin.example")
		#expect(start.integrationId == nil)
	}

	@Test("linkedin connect uses its own route, sends the same body and returns the integration id")
	func linkedIn() async throws {
		let transport = BodyTransport()
		let start = try await source(transport).startConnect(
			provider: "linkedin-unipile", idempotencyKey: "k-2")
		let request = try #require(transport.requests.first)
		#expect(request.path == "/api/integrations/linkedin-unipile/connect")
		let decoded = try JSONSerialization.jsonObject(with: Data(request.body.utf8)) as? [String: String]
		#expect(decoded == ["native_return_url": "maskin://integrations/callback"])
		#expect(start.integrationId == "8d1f0a4e-3c63-4e1b-9d2e-0c6f7a2b1c11")
	}
}
