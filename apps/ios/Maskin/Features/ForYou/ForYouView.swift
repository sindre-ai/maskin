import SwiftUI

/// "For you" — the subset of the unread feed that classifies as a decision-shaped card
/// (see `CardClassifier`). No card-stack swipe or "Today's brief" player in v1 (see plan
/// Context: audio digest has no backend support, deferred to v2) — a plain list of the
/// same cards the prototype's queue surfaces.
struct ForYouView: View {
	@Environment(AuthManager.self) private var auth
	@Environment(AppModel.self) private var appModel

	private var decisionItems: [UnreadItem] {
		appModel.unreadItems.filter { CardClassifier.classify($0) != .thread }
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpacing.s4) {
					header
					if decisionItems.isEmpty && !appModel.isLoadingUnread {
						emptyState
					} else {
						ForEach(decisionItems) { item in
							if let object = item.object {
								NavigationLink(value: object.id) {
									ForYouCard(item: item, object: object)
								}
								.buttonStyle(.plain)
							}
						}
					}
				}
				.padding(MaskinSpacing.s4)
			}
			.background(MaskinColor.surface)
			.navigationTitle("For you")
			.navigationDestination(for: String.self) { objectId in
				ObjectDetailView(objectId: objectId)
			}
			.refreshable {
				if let workspaceId = auth.workspaceId {
					await appModel.refreshUnread(workspaceId: workspaceId)
				}
			}
		}
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: MaskinSpacing.s1) {
			Text("For you").font(MaskinFont.display(28, weight: .bold)).foregroundStyle(MaskinColor.ink)
			Text("\(decisionItems.count) need\(decisionItems.count == 1 ? "s" : "") you")
				.font(MaskinFont.sm)
				.foregroundStyle(MaskinColor.ink2)
		}
	}

	private var emptyState: some View {
		VStack(spacing: MaskinSpacing.s2) {
			Text("All caught up").font(MaskinFont.md.weight(.semibold)).foregroundStyle(MaskinColor.ink)
			Text("Nothing needs a decision right now.")
				.font(MaskinFont.sm)
				.foregroundStyle(MaskinColor.ink2)
		}
		.frame(maxWidth: .infinity)
		.padding(.top, MaskinSpacing.s9)
	}
}

private struct ForYouCard: View {
	@Environment(AuthManager.self) private var auth
	@Environment(AppModel.self) private var appModel
	let item: UnreadItem
	let object: MaskinObject
	@State private var isSubmitting = false

	private var kind: CardKind { CardClassifier.classify(item) }

	var body: some View {
		MaskinCard {
			HStack(spacing: MaskinSpacing.s2) {
				let creatorId = object.driver ?? object.createdBy
				ActorAvatar(name: appModel.actor(creatorId)?.name ?? "Agent", id: creatorId, size: 22)
				ObjectTypeTag(type: object.type)
				Spacer()
				if item.mentioningUnreadCount > 0 {
					StatusPill(text: "Mentioned", accent: true)
				}
			}
			Text(object.title ?? "Untitled").font(MaskinFont.md.weight(.semibold)).foregroundStyle(MaskinColor.ink)
			if let content = object.content, !content.isEmpty {
				Text(content).font(MaskinFont.sm).foregroundStyle(MaskinColor.ink2).lineLimit(2)
			}
			HStack(spacing: MaskinSpacing.s2) {
				ForEach(CardClassifier.actions(for: kind).prefix(3)) { action in
					Button(action.label) { perform(action) }
						.font(MaskinFont.sm.weight(.semibold))
						.padding(.horizontal, MaskinSpacing.s3)
						.padding(.vertical, MaskinSpacing.s2)
						.background(action.isPrimary ? MaskinColor.ink : MaskinColor.linen)
						.foregroundStyle(action.isPrimary ? MaskinColor.surface : MaskinColor.ink)
						.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.sm))
				}
			}
			.disabled(isSubmitting)
			.padding(.top, MaskinSpacing.s1)
		}
	}

	private func perform(_ action: CardAction) {
		guard let workspaceId = auth.workspaceId else { return }
		isSubmitting = true
		Task {
			defer { isSubmitting = false }
			try? await appModel.postDecision(entityId: object.id, label: action.label, workspaceId: workspaceId)
		}
	}
}
