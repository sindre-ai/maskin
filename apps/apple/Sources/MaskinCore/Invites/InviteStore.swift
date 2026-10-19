import Foundation
import Observation

/// Who is signed in, as far as an invite needs to know.
public struct InviteViewer: Equatable, Sendable {
	public var apiKey: String
	public var email: String?
	public init(apiKey: String, email: String?) {
		self.apiKey = apiKey
		self.email = email
	}
}

/// One invite screen's state machine: load the preview, then accept it as the signed-in actor.
///
/// Signed out, the screen can only preview; `requiresSignIn` tells it to offer sign-in instead of
/// Accept. Accepting with a different email than the invite was sent to succeeds on the server, so
/// the warning is ours: `accept()` stops at `.confirmingMismatch` until the person says they mean it.
@MainActor
@Observable
public final class InviteStore {
	public enum Phase: Equatable, Sendable {
		case loading
		/// Preview shown; waiting for Accept / Decline.
		case ready
		/// Signed in as a different email than the one invited: asking before joining.
		case confirmingMismatch
		case accepting
		case accepted(workspaceId: String)
		/// Loading the preview (`preview == nil`) or accepting it (`preview != nil`) failed.
		case failed(InviteFailure)
	}

	public let token: String
	public private(set) var phase: Phase = .loading
	public private(set) var preview: InvitePreview?

	/// FE-2 HOOK POINT. Signed-out people without an account land here. FE-2 (native sign-up) sets
	/// this to start account creation for the invite; until it is set the screen says plainly that
	/// an account has to be created on the web first. Nothing else in the invite flow changes.
	@ObservationIgnored public var createAccount: (@MainActor (InvitePreview) -> Void)?

	@ObservationIgnored private let remote: any InviteRemote
	@ObservationIgnored private let viewer: @MainActor () -> InviteViewer?
	@ObservationIgnored private let joined: @MainActor (String) async -> Void

	/// - Parameters:
	///   - viewer: the signed-in actor right now, or nil. Read on demand, so signing in while the
	///     screen is up takes effect.
	///   - joined: runs after the server accepted, to refresh the workspace list and switch to it.
	public init(
		token: String, remote: any InviteRemote,
		viewer: @escaping @MainActor () -> InviteViewer?,
		joined: @escaping @MainActor (String) async -> Void
	) {
		self.token = token
		self.remote = remote
		self.viewer = viewer
		self.joined = joined
	}

	public var requiresSignIn: Bool { viewer() == nil }

	/// The signed-in email differs from the one the invite was sent to. Unknown email (older
	/// sessions) is not treated as a mismatch: we can't tell, and warning on every accept would
	/// teach people to ignore it.
	public var emailMismatch: Bool {
		guard let preview, let email = viewer()?.email else { return false }
		return Self.normalized(email) != Self.normalized(preview.inviteEmail)
	}

	public var signedInEmail: String? { viewer()?.email }

	public func load() async {
		guard preview == nil else { return }
		phase = .loading
		do {
			preview = try await remote.preview(token: token)
			phase = .ready
		} catch {
			phase = .failed(InviteFailure.transport(error))
		}
	}

	/// Retry after a retryable failure: reloads the preview if it never loaded, else re-accepts.
	public func retry() async {
		if preview == nil { await load() } else { phase = .ready }
	}

	/// Accept as the signed-in actor. Signed out this does nothing: the view offers sign-in.
	public func accept(confirmedMismatch: Bool = false) async {
		guard let current = viewer(), preview != nil else { return }
		switch phase {
		case .ready, .confirmingMismatch, .failed: break
		default: return
		}
		if emailMismatch, !confirmedMismatch {
			phase = .confirmingMismatch
			return
		}
		phase = .accepting
		do {
			let result = try await remote.accept(token: token, apiKey: current.apiKey)
			await joined(result.workspaceId)
			phase = .accepted(workspaceId: result.workspaceId)
		} catch {
			phase = .failed(InviteFailure.transport(error))
		}
	}

	/// Back out of the mismatch warning without joining.
	public func cancelMismatch() {
		if phase == .confirmingMismatch { phase = .ready }
	}

	/// Whether the held token should be forgotten now: the invite is gone for good, or joined.
	public var isFinished: Bool {
		switch phase {
		case .accepted: true
		case .failed(let failure): failure.discardsInvite
		default: false
		}
	}

	private static func normalized(_ email: String) -> String {
		email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	}
}
