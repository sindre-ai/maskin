import Foundation
import Testing

@testable import MaskinCore

private struct ThrowingStore: SecretStore {
	func read() throws -> Data? { throw KeychainError(status: -25308) }
	func write(_ data: Data) throws {}
	func delete() throws {}
}

private final class SpyStore: SecretStore, @unchecked Sendable {
	private let inner: InMemorySecretStore
	private let lock = NSLock()
	private(set) var mutations = 0
	init(_ data: Data?) { inner = InMemorySecretStore(data) }
	func read() throws -> Data? { try inner.read() }
	func write(_ data: Data) throws { lock.withLock { mutations += 1 }; try inner.write(data) }
	func delete() throws { lock.withLock { mutations += 1 }; try inner.delete() }
}

private func blob(workspace: String? = "ws-1", key: String = "ank_secret") throws -> Data {
	try JSONEncoder().encode(StoredSession(apiKey: key, actorId: "a-1", name: "Sebastian", workspaceId: workspace))
}

@Suite("ShareSession credentials")
struct ShareSessionTests {
	@Test("reads the key and workspace the app saved")
	func signedIn() throws {
		let creds = try ShareSession.credentials(from: InMemorySecretStore(try blob()))
		#expect(creds == ShareCredentials(apiKey: "ank_secret", workspaceId: "ws-1"))
	}

	@Test("nothing stored means signed out")
	func signedOut() {
		#expect(throws: ShareError.signedOut) { _ = try ShareSession.credentials(from: InMemorySecretStore()) }
	}

	@Test("a corrupt blob or an empty key means signed out, not a crash")
	func corrupt() throws {
		#expect(throws: ShareError.signedOut) {
			_ = try ShareSession.credentials(from: InMemorySecretStore(Data("nope".utf8)))
		}
		#expect(throws: ShareError.signedOut) {
			_ = try ShareSession.credentials(from: InMemorySecretStore(try blob(key: "")))
		}
	}

	@Test("signed in with no workspace chosen is its own state")
	func noWorkspace() throws {
		#expect(throws: ShareError.noWorkspace) {
			_ = try ShareSession.credentials(from: InMemorySecretStore(try blob(workspace: nil)))
		}
		#expect(throws: ShareError.noWorkspace) {
			_ = try ShareSession.credentials(from: InMemorySecretStore(try blob(workspace: "")))
		}
	}

	@Test("a Keychain read error is not reported as signed out")
	func unreadable() {
		#expect(throws: ShareError.sessionUnreadable) { _ = try ShareSession.credentials(from: ThrowingStore()) }
	}

	@Test("the extension never writes or deletes the shared session")
	func readOnly() throws {
		let store = SpyStore(try blob())
		_ = try ShareSession.credentials(from: store)
		#expect(store.mutations == 0)
	}

	@Test("error messages name the next step and never carry the key")
	func messages() {
		#expect(ShareError.signedOut.message.contains("Open Maskin to sign in"))
		for error: ShareError in [.signedOut, .noWorkspace, .sessionExpired, .offline, .server, .rejected, .unknown] {
			#expect(!error.message.contains("ank_"))
		}
		#expect(ShareError.signedOut.needsApp && !ShareError.signedOut.isRetryable)
		#expect(ShareError.offline.isRetryable && !ShareError.offline.needsApp)
	}
}
