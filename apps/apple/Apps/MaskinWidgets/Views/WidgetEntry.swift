import MaskinCore
import WidgetKit

/// One moment on a widget's timeline. The state is already resolved for `date`: a cached
/// snapshot that has expired by then arrives as `.unavailable`.
struct MaskinWidgetEntry: TimelineEntry {
	let date: Date
	let state: WidgetState

	var relevance: TimelineEntryRelevance? {
		TimelineEntryRelevance(score: WidgetPolicy.relevance(of: state))
	}
}

extension WidgetSnapshot {
	/// Gallery and placeholder data. Invented, never real content.
	static func sample(now: Date = Date()) -> WidgetSnapshot {
		WidgetSnapshot(
			actorId: "preview", workspaceId: "preview", needsCount: 3,
			decisions: [
				Decision(
					objectId: "d1", title: "Ship the new pricing page this week?", agentName: "Forge",
					optionLabels: ["Ship it", "Hold a week", "Revise copy"], recommendedLabel: "Ship it",
					since: now.addingTimeInterval(-3 * 86_400)),
				Decision(
					objectId: "d2", title: "Approve the outreach sequence for Q4 leads",
					agentName: "Relay", optionLabels: ["Approve", "Edit"], recommendedLabel: "Approve",
					since: now.addingTimeInterval(-3_600)),
				Decision(
					objectId: "d3", title: "Merge the onboarding experiment?", agentName: "Compass",
					optionLabels: ["Merge", "Keep testing"], since: now.addingTimeInterval(-600)),
			],
			unreadCount: 5, updatedAt: now)
	}

	static func sampleEmpty(now: Date = Date()) -> WidgetSnapshot {
		WidgetSnapshot(
			actorId: "preview", workspaceId: "preview", needsCount: 0, decisions: [], unreadCount: 0,
			updatedAt: now)
	}
}
