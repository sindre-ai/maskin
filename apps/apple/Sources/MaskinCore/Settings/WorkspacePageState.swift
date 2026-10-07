import Foundation

/// How a trailing state reads on a pushed workspace page: Patina for on/active, grey for
/// paused/revoked, amber only for "needs sign-in", plain ink for anything else.
public enum PageStateTone: Equatable, Sendable {
	case active, muted, notice, plain
}

public struct PageState: Equatable, Sendable {
	public var text: String
	public var tone: PageStateTone
	public init(_ text: String, _ tone: PageStateTone) {
		self.text = text
		self.tone = tone
	}
}

/// Row state mapping for the pushed Members, Integrations, Triggers and Keys pages.
public enum WorkspacePageState {
	public static func trigger(enabled: Bool) -> PageState {
		enabled ? PageState("On", .active) : PageState("Paused", .muted)
	}

	public static func integration(_ state: ConnectedIntegration.State) -> PageState {
		switch state {
		case .connected: PageState("Connected", .active)
		case .needsReconnect, .disconnected: PageState("Reconnect", .notice)
		case .incomplete: PageState("Finish setup", .notice)
		}
	}

	public static let integrationAvailable = PageState("Connect", .plain)

	/// The line under an integration's name: never a provider id, only a name or a sentence.
	public static func integrationSubtitle(_ state: ConnectedIntegration.State, account: String?)
		-> String
	{
		switch state {
		case .connected: account.map { "Connected as \($0)" } ?? "Connected"
		case .needsReconnect, .disconnected, .incomplete: "Needs sign-in"
		}
	}

	public static let integrationAvailableSubtitle = "Not connected"

	public static func member(role: MemberRole) -> PageState { PageState(role.label, .plain) }

	/// The line under a member's name: "Owner · you" for yourself, "Agent" for an agent.
	public static func memberSubtitle(isAgent: Bool, role: MemberRole, isYou: Bool) -> String? {
		if isAgent { return "Agent" }
		return isYou ? "\(role.label) · you" : nil
	}

	public static let activeKey = PageState("Active", .active)

	/// The sub line of a trigger row: the plain-language When, or "Paused".
	public static func triggerSubtitle(_ trigger: Trigger) -> String {
		trigger.enabled ? trigger.summary : "Paused"
	}

	/// Whether the person can add or remove people and change roles on the Members page.
	public static func canManageMembers(_ role: MemberRole) -> Bool { role.canManage }
}
