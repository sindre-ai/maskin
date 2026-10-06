import Foundation

/// Turns the For You feed into a `WidgetSnapshot`, with the same rules `ForYouStore.entries` uses
/// for its "needs you" bucket: unread, not an onboarding session, and carrying an agent-authored
/// decision. Ordered by the sender's attention score, then latest activity (the store's default).
public enum WidgetSnapshotBuilder {
	public static func make(
		cards: [ForYouCard], actors: [ForYouActor], unreadNotifications: Int, actorId: String,
		workspaceId: String, now: Date
	) -> WidgetSnapshot {
		let names = Dictionary(actors.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
		let needs = cards.filter {
			$0.unreadCount > 0 && $0.objectType != "onboarding_session" && $0.kind == .decision
		}
		.sorted {
			let a = $0.maxAttention ?? -1
			let b = $1.maxAttention ?? -1
			if a != b { return a > b }
			return ($0.latestActivityAt ?? .distantPast) > ($1.latestActivityAt ?? .distantPast)
		}
		let decisions = needs.prefix(WidgetSnapshot.maxDecisions).map { card in
			let options = card.decision?.options ?? []
			// The recommended option leads, so a narrow widget that shows one shows that one.
			let ordered = options.filter(\.recommended) + options.filter { !$0.recommended }
			return WidgetSnapshot.Decision(
				objectId: card.id, title: clip(card.headline),
				agentName: card.mention?.actorId.flatMap { names[$0] }?.trimmed.nonEmpty,
				optionLabels: ordered.prefix(WidgetSnapshot.maxOptions).map { clip($0.label, to: 40) },
				recommendedLabel: card.decision?.recommended.map { clip($0.label, to: 40) },
				since: card.latestActivityAt)
		}
		return WidgetSnapshot(
			actorId: actorId, workspaceId: workspaceId, needsCount: needs.count,
			decisions: decisions, unreadCount: unreadNotifications, updatedAt: now)
	}

	/// Keeps the cached file (and the process) tiny however long an agent's title runs.
	static func clip(_ text: String, to limit: Int = WidgetSnapshot.maxTitleLength) -> String {
		let t = text.trimmed
		return t.count > limit ? String(t.prefix(limit - 1)) + "…" : t
	}
}
