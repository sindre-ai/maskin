import Foundation
import Testing

@testable import MaskinCore

private func session(key: String = "ank_a", actor: String = "actor-1", workspace: String? = "ws-1")
	-> StoredSession
{
	StoredSession(apiKey: key, actorId: actor, name: "Alex", workspaceId: workspace)
}

@Suite("WatchHandoff")
struct WatchHandoffTests {
	@Test("a session survives the application-context round trip")
	func roundTrip() {
		let original = WatchHandoff(session: session())
		#expect(WatchHandoff(context: original.context()) == original)
	}

	@Test("an empty context means signed out")
	func emptyContext() {
		#expect(WatchHandoff(context: [:]) == WatchHandoff(session: nil))
	}

	@Test("a payload this build can't decode is dropped, not read as a sign-out")
	func undecodable() {
		#expect(WatchHandoff(context: ["maskin.handoff.v1": Data("nope".utf8)]) == nil)
	}
}

@Suite("WatchHandoffPolicy")
struct WatchHandoffPolicyTests {
	private func decide(_ incoming: StoredSession?, current: StoredSession?, adopted: String? = nil)
		-> WatchHandoffAction
	{
		WatchHandoffPolicy.decide(
			incoming: WatchHandoff(session: incoming), current: current, adoptedKey: adopted)
	}

	@Test("a signed-out watch adopts the phone's session")
	func adoptsWhenSignedOut() {
		#expect(decide(session(), current: nil) == .adopt(session()))
	}

	@Test("the same key changes nothing")
	func sameKey() {
		#expect(decide(session(workspace: "ws-2"), current: session()) == .ignore)
	}

	@Test("a rotated key for the same person is adopted and the wearer's workspace kept")
	func rotatedKey() {
		let action = decide(session(key: "ank_b", workspace: "ws-2"), current: session(workspace: "ws-1"))
		#expect(action == .adopt(session(key: "ank_b", workspace: "ws-1")))
	}

	@Test("a different person is followed only while the watch mirrors the phone")
	func differentPerson() {
		let other = session(key: "ank_c", actor: "actor-2")
		#expect(decide(other, current: session(), adopted: "ank_a") == .adopt(other))
		#expect(decide(other, current: session(), adopted: nil) == .ignore)
	}

	@Test("a phone sign-out ends a mirrored session but never one typed in on the watch")
	func phoneSignOut() {
		#expect(decide(nil, current: session(), adopted: "ank_a") == .signOut)
		#expect(decide(nil, current: session(), adopted: nil) == .ignore)
		#expect(decide(nil, current: nil) == .ignore)
	}
}

@MainActor
@Suite("AuthSession.adopt")
struct AuthSessionAdoptTests {
	@Test("adopting persists the session and signs in")
	func adopts() throws {
		let store = InMemorySecretStore()
		let auth = AuthSession(authenticator: UnusedAuthenticator(), store: store)
		try auth.adopt(session())
		#expect(auth.session == session())
		#expect(try store.read() != nil)
	}
}

private struct UnusedAuthenticator: Authenticating {
	func login(email: String, password: String) async throws -> LoginResult {
		throw AuthError.invalidCredentials
	}
}
