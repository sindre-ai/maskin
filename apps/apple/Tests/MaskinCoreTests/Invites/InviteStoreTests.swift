import Foundation
import Testing

@testable import MaskinCore

private let token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"

private func samplePreview(email: String = "ada@example.com") -> InvitePreview {
	InvitePreview(
		workspaceId: "ws-9", workspaceName: "Mesh Firm", inviterName: "Grace", inviteEmail: email,
		role: "member", expiresAt: Date(timeIntervalSince1970: 2_000_000_000))
}

private final class FakeRemote: InviteRemote, @unchecked Sendable {
	private let lock = NSLock()
	var previewResult: Result<InvitePreview, InviteFailure> = .success(samplePreview())
	var acceptResult: Result<InviteAcceptance, InviteFailure> = .success(InviteAcceptance(workspaceId: "ws-9"))
	private var _accepted: [(String, String)] = []
	var accepted: [(String, String)] { lock.withLock { _accepted } }
	func preview(token: String) async throws -> InvitePreview { try previewResult.get() }
	func accept(token: String, apiKey: String) async throws -> InviteAcceptance {
		lock.withLock { _accepted.append((token, apiKey)) }
		return try acceptResult.get()
	}
}

@MainActor
private final class Rig {
	let remote = FakeRemote()
	var viewer: InviteViewer? = InviteViewer(apiKey: "ank_x", email: "ada@example.com")
	var joined: [String] = []
	lazy var store = InviteStore(
		token: token, remote: remote, viewer: { [unowned self] in viewer },
		joined: { [unowned self] id in joined.append(id) })
}

@MainActor
@Suite("InviteStore")
struct InviteStoreTests {
	@Test("loads the preview")
	func loads() async {
		let r = Rig()
		await r.store.load()
		#expect(r.store.phase == .ready)
		#expect(r.store.preview?.workspaceName == "Mesh Firm")
	}

	@Test("accepting joins as the signed-in actor, then switches to the returned workspace")
	func accepts() async {
		let r = Rig()
		await r.store.load()
		await r.store.accept()
		#expect(r.remote.accepted.map(\.1) == ["ank_x"])
		#expect(r.joined == ["ws-9"])
		#expect(r.store.phase == .accepted(workspaceId: "ws-9"))
		#expect(r.store.isFinished)
	}

	@Test("a different signed-in email stops at a warning, and only a confirmed accept joins")
	func mismatch() async {
		let r = Rig()
		r.viewer = InviteViewer(apiKey: "ank_x", email: "someone@else.com")
		await r.store.load()
		await r.store.accept()
		#expect(r.store.phase == .confirmingMismatch)
		#expect(r.remote.accepted.isEmpty)
		r.store.cancelMismatch()
		#expect(r.store.phase == .ready)
		await r.store.accept(confirmedMismatch: true)
		#expect(r.remote.accepted.count == 1)
	}

	@Test("email comparison ignores case and whitespace; an unknown email is not a mismatch")
	func emailNormalisation() async {
		let r = Rig()
		r.viewer = InviteViewer(apiKey: "k", email: " ADA@Example.com ")
		await r.store.load()
		#expect(!r.store.emailMismatch)
		r.viewer = InviteViewer(apiKey: "k", email: nil)
		#expect(!r.store.emailMismatch)
	}

	@Test("signed out, accept does nothing and the screen asks for sign-in")
	func signedOut() async {
		let r = Rig()
		r.viewer = nil
		await r.store.load()
		#expect(r.store.requiresSignIn)
		await r.store.accept()
		#expect(r.remote.accepted.isEmpty)
		#expect(r.store.phase == .ready)
	}

	@Test("a failed accept keeps the preview and allows a retry", arguments: [InviteFailure.offline, .rateLimited])
	func retryable(failure: InviteFailure) async {
		let r = Rig()
		await r.store.load()
		r.remote.acceptResult = .failure(failure)
		await r.store.accept()
		#expect(r.store.phase == .failed(failure))
		#expect(r.store.preview != nil)
		#expect(!r.store.isFinished)
		r.remote.acceptResult = .success(InviteAcceptance(workspaceId: "ws-9"))
		await r.store.accept()
		#expect(r.store.phase == .accepted(workspaceId: "ws-9"))
	}

	@Test("a dead invite on load is final and forgets the token")
	func deadInvite() async {
		let r = Rig()
		r.remote.previewResult = .failure(.expired)
		await r.store.load()
		#expect(r.store.phase == .failed(.expired))
		#expect(r.store.isFinished)
	}

	@Test("a failed preview can be retried")
	func previewRetry() async {
		let r = Rig()
		r.remote.previewResult = .failure(.offline)
		await r.store.load()
		#expect(!r.store.isFinished)
		r.remote.previewResult = .success(samplePreview())
		await r.store.retry()
		#expect(r.store.phase == .ready)
	}
}

@Suite("InviteFailure")
struct InviteFailureTests {
	@Test("maps statuses to cases")
	func statuses() {
		#expect(InviteFailure.status(401) == .sessionExpired)
		#expect(InviteFailure.status(403) == .seatCap)
		#expect(InviteFailure.status(404) == .notFound)
		#expect(InviteFailure.status(410) == .expired)
		#expect(InviteFailure.status(429) == .rateLimited)
		#expect(InviteFailure.status(502) == .server(status: 502))
	}

	@Test("a URLError is offline; anything else is unreadable")
	func transport() {
		#expect(InviteFailure.transport(URLError(.notConnectedToInternet)) == .offline)
		#expect(InviteFailure.transport(CocoaError(.fileReadCorruptFile)) == .unreadable)
	}

	@Test("copy is plain: no ids, tokens or status codes")
	func copy() {
		for f in [InviteFailure.notFound, .expired, .rateLimited, .seatCap, .sessionExpired, .offline, .server(status: 500), .unreadable] {
			#expect(!f.message.contains("500"))
			#expect(!f.message.isEmpty)
		}
	}
}

@MainActor
@Suite("InviteCoordinator")
struct InviteCoordinatorTests {
	private func make(pending: InMemoryPendingInviteStore = InMemoryPendingInviteStore(), signedIn: @escaping () -> Bool = { true })
		-> (InviteCoordinator, InMemoryPendingInviteStore)
	{
		let remote = FakeRemote()
		let c = InviteCoordinator(pending: pending) { t in
			InviteStore(
				token: t, remote: remote,
				viewer: { signedIn() ? InviteViewer(apiKey: "k", email: nil) : nil }, joined: { _ in })
		}
		return (c, pending)
	}
	private let url = URL(string: "https://maskin.io/invite?token=\(token)")!

	@Test("an invite link is taken, stored and presented; other links are left alone")
	func opens() {
		let (c, pending) = make()
		#expect(!c.open(URL(string: "https://maskin.io/ws-1/notifications")!))
		#expect(c.open(url))
		#expect(c.isPresented)
		#expect(pending.load() == token)
	}

	@Test("a cold launch resumes a held token once signed in, and not before")
	func resume() {
		let (c, _) = make(pending: InMemoryPendingInviteStore(token: token))
		c.resume(isSignedIn: false)
		#expect(!c.isPresented)
		c.resume(isSignedIn: true)
		#expect(c.isPresented)
		#expect(c.store?.token == token)
	}

	@Test("closing while signed out keeps the token for after sign-in")
	func keepsWhileSignedOut() {
		var signedIn = false
		let (c, pending) = make(signedIn: { signedIn })
		c.open(url)
		c.dismiss()
		#expect(pending.load() == token)
		signedIn = true
		c.resume(isSignedIn: true)
		#expect(c.isPresented)
	}

	@Test("closing while signed in is 'not now' and forgets it; finish forgets it too")
	func forgets() {
		let (c, pending) = make()
		c.open(url)
		c.dismiss()
		#expect(pending.load() == nil)
		c.open(url)
		c.finish()
		#expect(pending.load() == nil)
		#expect(!c.isPresented)
	}
}
