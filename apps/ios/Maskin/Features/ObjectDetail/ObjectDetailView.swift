import SwiftUI

/// Object detail — `GET /api/objects/:id` + `GET /api/events/history` for the comment
/// thread, composer posts via `POST /api/events`; Approve/Hold/chip actions reuse the
/// same card-kind classifier as For You/Chats (see plan §5).
struct ObjectDetailView: View {
	@Environment(AuthManager.self) private var auth
	@Environment(AppModel.self) private var appModel
	let objectId: String

	@State private var object: MaskinObject?
	@State private var comments: [CommentEvent] = []
	@State private var draft = ""
	@State private var isLoading = true
	@State private var isPosting = false
	@State private var errorMessage: String?

	private var syntheticUnreadItem: UnreadItem? {
		guard let object else { return nil }
		return UnreadItem(
			entityType: "object", entityId: object.id, unreadCount: 0, mentioningUnreadCount: 0,
			latestEventId: nil, latestActivityAt: nil, object: object
		)
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpacing.s4) {
				if let object {
					header(for: object)
					if let content = object.content, !content.isEmpty {
						Text(content).font(MaskinFont.sm).foregroundStyle(MaskinColor.ink2)
					}
					if let item = syntheticUnreadItem {
						let kind = CardClassifier.classify(item)
						if kind != .thread {
							decisionActions(kind: kind, object: object)
						}
					}
					Divider().overlay(MaskinColor.rule)
					ForEach(comments) { comment in
						CommentRow(comment: comment)
					}
				} else if isLoading {
					ProgressView().frame(maxWidth: .infinity).padding(.top, MaskinSpacing.s9)
				}
				if let errorMessage {
					Text(errorMessage).font(MaskinFont.xs).foregroundStyle(MaskinColor.danger)
				}
			}
			.padding(MaskinSpacing.s4)
		}
		.background(MaskinColor.surface)
		.safeAreaInset(edge: .bottom) { composer }
		.navigationBarTitleDisplayMode(.inline)
		.task { await load() }
	}

	private func header(for object: MaskinObject) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpacing.s2) {
			HStack {
				ObjectTypeTag(type: object.type)
				StatusPill(text: object.status.replacingOccurrences(of: "_", with: " "))
			}
			Text(object.title ?? "Untitled")
				.font(MaskinFont.display(22, weight: .bold))
				.foregroundStyle(MaskinColor.ink)
		}
	}

	private func decisionActions(kind: CardKind, object: MaskinObject) -> some View {
		HStack(spacing: MaskinSpacing.s2) {
			ForEach(CardClassifier.actions(for: kind)) { action in
				Button(action.label) { postDecision(label: action.label) }
					.font(MaskinFont.md.weight(.semibold))
					.frame(maxWidth: .infinity)
					.padding(.vertical, MaskinSpacing.s3)
					.background(action.isPrimary ? MaskinColor.ink : MaskinColor.surface)
					.foregroundStyle(action.isPrimary ? MaskinColor.surface : MaskinColor.ink)
					.overlay(
						RoundedRectangle(cornerRadius: MaskinRadius.xl)
							.stroke(action.isPrimary ? .clear : MaskinColor.rule, lineWidth: MaskinBorder.width)
					)
					.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.xl))
			}
		}
		.disabled(isPosting)
	}

	private var composer: some View {
		HStack(spacing: MaskinSpacing.s2) {
			TextField("Reply…", text: $draft, axis: .vertical)
				.font(MaskinFont.md)
				.padding(MaskinSpacing.s3)
				.background(MaskinColor.linen)
				.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.xl))
			Button {
				postDecision(label: draft)
				draft = ""
			} label: {
				Image(systemName: "arrow.up.circle.fill")
					.font(.system(size: 30))
					.foregroundStyle(draft.trimmingCharacters(in: .whitespaces).isEmpty ? MaskinColor.ink3 : MaskinColor.accent)
			}
			.disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || isPosting)
		}
		.padding(MaskinSpacing.s3)
		.background(.bar)
	}

	private func load() async {
		guard let workspaceId = auth.workspaceId else { return }
		isLoading = true
		defer { isLoading = false }
		do {
			async let objectFetch = ObjectsAPI.get(id: objectId, workspaceId: workspaceId)
			async let commentsFetch = EventsAPI.history(entityType: "object", entityId: objectId, action: "commented", workspaceId: workspaceId)
			let (obj, fetchedComments) = try await (objectFetch, commentsFetch)
			object = obj
			comments = fetchedComments
		} catch {
			errorMessage = (error as? APIError)?.message ?? error.localizedDescription
		}
	}

	private func postDecision(label: String) {
		let trimmed = label.trimmingCharacters(in: .whitespaces)
		guard !trimmed.isEmpty, let workspaceId = auth.workspaceId else { return }
		isPosting = true
		Task {
			defer { isPosting = false }
			do {
				let comment = try await EventsAPI.createComment(entityId: objectId, content: trimmed, workspaceId: workspaceId)
				comments.append(comment)
				await appModel.refreshUnread(workspaceId: workspaceId)
			} catch {
				errorMessage = (error as? APIError)?.message ?? error.localizedDescription
			}
		}
	}
}

private struct CommentRow: View {
	@Environment(AppModel.self) private var appModel
	let comment: CommentEvent

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpacing.s3) {
			ActorAvatar(name: appModel.actor(comment.actorId)?.name ?? "Agent", id: comment.actorId, size: 28)
			VStack(alignment: .leading, spacing: MaskinSpacing.s1) {
				Text(appModel.actor(comment.actorId)?.name ?? "Agent")
					.font(MaskinFont.sm.weight(.semibold))
					.foregroundStyle(MaskinColor.ink)
				if let content = comment.data.content {
					Text(content).font(MaskinFont.sm).foregroundStyle(MaskinColor.ink2)
				}
			}
		}
	}
}
