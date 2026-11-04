import Foundation
import Observation

/// Owns "which invite is the person looking at": takes links, holds the token across sign-in and
/// relaunch, and builds the screen's `InviteStore`.
///
///  1. `open(url)` parses an invite link, persists its token and presents the screen. Works signed
///     out too: the preview needs no account.
///  2. Signed out, the screen's "Sign in" closes it (`dismiss()` keeps the token); the sign-in that
///     follows calls `resume(isSignedIn: true)`, which presents it again.
///  3. Joined, declined, or a dead invite (404/410) forgets the token (`finish()`); swiping the
///     screen away while signed in is "not now" and forgets it too, while signed out it is kept.
@MainActor
@Observable
public final class InviteCoordinator {
	public private(set) var store: InviteStore?
	public var isPresented = false {
		didSet { if !isPresented, oldValue { presentationEnded() } }
	}

	@ObservationIgnored private let pending: any PendingInviteStore
	@ObservationIgnored private let makeStore: @MainActor (String) -> InviteStore
	@ObservationIgnored private let universalHosts: Set<String>

	public init(
		pending: any PendingInviteStore,
		universalHosts: Set<String> = DeepLink.defaultUniversalHosts,
		makeStore: @escaping @MainActor (String) -> InviteStore
	) {
		self.pending = pending
		self.universalHosts = universalHosts
		self.makeStore = makeStore
	}

	/// The token held for after sign-in, if any.
	public var pendingToken: String? { pending.load() }

	/// Returns whether the URL was an invite link (and so must not reach the deep-link router).
	@discardableResult
	public func open(_ url: URL) -> Bool {
		guard let link = InviteLink(url: url, universalHosts: universalHosts) else { return false }
		present(token: link.token)
		return true
	}

	/// Call when the signed-in state changes and at launch. Presents a held invite once the
	/// person is signed in; a signed-out launch does not nag.
	public func resume(isSignedIn: Bool) {
		guard isSignedIn, !isPresented, let token = pending.load() else { return }
		present(token: token)
	}

	/// The person closed the screen (swipe or Close).
	public func dismiss() { isPresented = false }

	/// Joined or declined: forget the token and close.
	public func finish() {
		pending.clear()
		store = nil
		isPresented = false
	}

	/// Sign-out: close the screen; the held token stays (it is not account data).
	public func signedOut() {
		isPresented = false
		store = nil
	}

	private func present(token: String) {
		pending.save(token)
		if store?.token != token { store = makeStore(token) }
		isPresented = true
	}

	private func presentationEnded() {
		guard let store else { return }
		// Closed signed in = not now. Closed signed out = on the way to sign in, keep it.
		if store.isFinished || !store.requiresSignIn { pending.clear() }
		self.store = nil
	}
}
