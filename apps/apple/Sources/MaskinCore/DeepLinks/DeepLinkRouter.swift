import Foundation
import Observation

/// Holds an incoming `DeepLink` until the app can act on it, switching workspace first when the
/// link points into another workspace the user belongs to.
///
/// Flow: anything that receives a URL (`onOpenURL`, a push tap, a universal link) calls
/// `open(_:)`. The router decides, in order:
/// 1. not signed in → hold the link (`incoming`); `evaluate()` runs again after sign-in;
/// 2. workspace list not loaded yet → hold; `evaluate()` runs again once it loads;
/// 3. link's workspace is the selected one → `pending = link`;
/// 4. a workspace the user belongs to → select it, then `pending = link`;
/// 5. otherwise → `rejection` (the user isn't a member, or the link is stale); never navigates.
///
/// The shell observes `pending`, navigates, and calls `consume()`.
@MainActor
@Observable
public final class DeepLinkRouter {
	public enum Rejection: Equatable, Sendable {
		/// The link names a workspace this actor isn't a member of.
		case notAMember(workspaceId: String)
		/// The URL wasn't a Maskin link at all.
		case unrecognized
	}

	/// A link ready to navigate to; the workspace is already selected.
	public private(set) var pending: DeepLink?
	/// A link received but not yet resolvable (signed out, workspaces still loading).
	public private(set) var incoming: DeepLink?
	public private(set) var rejection: Rejection?

	@ObservationIgnored private let isSignedIn: () -> Bool
	@ObservationIgnored private let currentWorkspaceId: () -> String?
	/// `nil` until the workspace list has loaded.
	@ObservationIgnored private let memberWorkspaceIds: () -> Set<String>?
	@ObservationIgnored private let selectWorkspace: (String) -> Void
	@ObservationIgnored private let universalHosts: Set<String>

	public init(
		isSignedIn: @escaping () -> Bool,
		currentWorkspaceId: @escaping () -> String?,
		memberWorkspaceIds: @escaping () -> Set<String>?,
		selectWorkspace: @escaping (String) -> Void,
		universalHosts: Set<String> = DeepLink.defaultUniversalHosts
	) {
		self.isSignedIn = isSignedIn
		self.currentWorkspaceId = currentWorkspaceId
		self.memberWorkspaceIds = memberWorkspaceIds
		self.selectWorkspace = selectWorkspace
		self.universalHosts = universalHosts
	}

	/// Production wiring over the app environment.
	public convenience init(environment: AppEnvironment) {
		self.init(
			isSignedIn: { [unowned environment] in environment.auth.session != nil },
			currentWorkspaceId: { [unowned environment] in environment.workspaceId },
			memberWorkspaceIds: { [unowned environment] in
				environment.workspaces.phase == .loaded
					? Set(environment.workspaces.workspaces.map(\.id)) : nil
			},
			selectWorkspace: { [unowned environment] in environment.workspaces.select($0) })
	}

	/// Returns whether the URL was a Maskin link (accepted or held), so callers can tell the
	/// system whether they handled it.
	@discardableResult
	public func open(_ url: URL) -> Bool {
		guard let link = DeepLink(url: url, universalHosts: universalHosts) else {
			rejection = .unrecognized
			return false
		}
		open(link)
		return true
	}

	public func open(_ link: DeepLink) {
		rejection = nil
		incoming = link
		evaluate()
	}

	/// Re-attempt a held link. Call when sign-in completes or the workspace list loads.
	public func evaluate() {
		guard let link = incoming, isSignedIn() else { return }
		guard let members = memberWorkspaceIds() else { return }  // still loading
		incoming = nil
		if link.workspaceId == currentWorkspaceId() {
			pending = link
		} else if members.contains(link.workspaceId) {
			selectWorkspace(link.workspaceId)
			pending = link
		} else {
			rejection = .notAMember(workspaceId: link.workspaceId)
		}
	}

	/// The shell took `pending`.
	@discardableResult
	public func consume() -> DeepLink? {
		defer { pending = nil }
		return pending
	}

	public func clearRejection() { rejection = nil }

	/// Sign-out: drop anything held, so a link can't fire for the next user.
	public func reset() {
		pending = nil
		incoming = nil
		rejection = nil
	}
}
