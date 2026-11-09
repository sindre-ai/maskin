import Foundation

/// The product area an event belongs to, sent as `feature_area`. The values and the event-name
/// mapping mirror `packages/shared/src/analytics-feature-area.ts`, the list the web app and the
/// server use. A new value or a rename here splits every chart that groups by it, so change both
/// files together.
public enum AnalyticsFeatureArea: String, CaseIterable, Sendable {
	case chats
	case forYou = "for_you"
	case objects
	case loopsTriggers = "loops_triggers"
	case agents
	case filesBriefings = "files_briefings"
	case integrations
	case search
	case voice
	case billing
	case settings

	/// Exact names win over prefixes. Events with no product area (app lifecycle, sign-in, push)
	/// carry no `feature_area`.
	private static let exact: [String: AnalyticsFeatureArea] = [
		"sindre_message_received": .chats,
		"sindre_message_sent": .chats,
		"foryou_card_action": .forYou,
		"object_updated": .objects,
		"object_created": .objects,
		"command_palette_opened": .search,
		"live_call_started": .voice,
	]

	/// Checked in order, so the narrow prefix (`agent_chat_`) comes before the wide one (`agent_`).
	private static let prefixes: [(String, AnalyticsFeatureArea)] = [
		("chat_", .chats),
		("agent_chat_", .chats),
		("group_chat_", .chats),
		("foryou_", .forYou),
		("for_you_", .forYou),
		("object_", .objects),
		("objects_", .objects),
		("loop_", .loopsTriggers),
		("trigger_", .loopsTriggers),
		("agent_", .agents),
		("search_", .search),
		("voice_", .voice),
	]

	/// The area of an event name, or nil when it has none.
	public static func forEvent(_ event: String) -> AnalyticsFeatureArea? {
		if let area = exact[event] { return area }
		return prefixes.first { event.hasPrefix($0.0) }?.1
	}
}
