import Foundation
import Testing

@testable import MaskinCore

private struct NoLogin: Authenticating {
	func login(email: String, password: String) async throws -> LoginResult { throw AuthError.invalidCredentials }
}

private actor FakeAuthorizer: DeviceAuthorizing {
	var polls: [Result<DevicePollResult, DeviceSignInError>]
	var startError: DeviceSignInError?
	private(set) var pollCount = 0

	init(polls: [Result<DevicePollResult, DeviceSignInError>], startError: DeviceSignInError? = nil) {
		self.polls = polls
		self.startError = startError
	}

	func start(deviceName: String) async throws -> DeviceCode {
		if let startError { throw startError }
		return DeviceCode(
			deviceCode: "secret", userCode: "BCDF-2345", verificationURI: URL(string: "https://maskin.io/tv")!,
			verificationURIComplete: URL(string: "https://maskin.io/tv?code=BCDF-2345")!,
			expiresAt: Date(timeIntervalSince1970: 1_000), interval: 5)
	}

	func poll(deviceCode: String) async throws -> DevicePollResult {
		pollCount += 1
		return try polls.removeFirst().get()
	}
}

@MainActor
private func make(_ authorizer: FakeAuthorizer) -> (DeviceSignInModel, AuthSession) {
	let auth = AuthSession(authenticator: NoLogin(), store: InMemorySecretStore())
	let model = DeviceSignInModel(
		authorizer: authorizer, auth: auth, deviceName: "Living room",
		sleep: { _ in }, now: { Date(timeIntervalSince1970: 0) })
	return (model, auth)
}

@MainActor
struct DeviceSignInTests {
	@Test func approvalSignsTheDeviceIn() async {
		let login = LoginResult(apiKey: "ank_x", actorId: "a1", name: "Sebastian", email: nil, workspaceId: "w1")
		let (model, auth) = make(FakeAuthorizer(polls: [.success(.pending(interval: nil)), .success(.approved(login))]))
		await model.run()
		#expect(auth.session?.apiKey == "ank_x")
		#expect(auth.session?.workspaceId == "w1")
	}

	@Test func deniedStopsPolling() async {
		let authorizer = FakeAuthorizer(polls: [.success(.denied)])
		let (model, auth) = make(authorizer)
		await model.run()
		#expect(model.phase == .denied)
		#expect(auth.session == nil)
	}

	@Test func serverExpiryShowsExpired() async {
		let (model, _) = make(FakeAuthorizer(polls: [.success(.expired)]))
		await model.run()
		#expect(model.phase == .expired)
	}

	@Test func aDroppedConnectionKeepsWaiting() async {
		let (model, _) = make(FakeAuthorizer(polls: [.failure(.network), .success(.denied)]))
		await model.run()
		#expect(model.phase == .denied)
	}

	@Test func startFailureIsReported() async {
		let (model, _) = make(FakeAuthorizer(polls: [], startError: .network))
		await model.run()
		#expect(model.phase == .failed("Can\u{2019}t reach Maskin."))
	}

	@Test func addressDropsTheScheme() {
		let code = DeviceCode(
			deviceCode: "d", userCode: "u", verificationURI: URL(string: "https://maskin.io/tv")!,
			verificationURIComplete: URL(string: "https://maskin.io/tv?code=u")!, expiresAt: .now, interval: 5)
		#expect(code.displayAddress == "maskin.io/tv")
	}
}
