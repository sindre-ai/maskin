import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Objects: type pills and a two-column grid of cards. Read only on TV; deciding goes through For
/// you, editing stays on the iPhone and iPad.
struct TVObjects: View {
	let environment: AppEnvironment
	let forYou: ForYouRuntime?
	@State private var store: ObjectsStore?

	private let columns = [GridItem(.flexible(), spacing: 40), GridItem(.flexible(), spacing: 40)]

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 32) {
					Text("Objects").font(.system(size: 64, weight: .bold))
					if let store {
						pills(store)
						grid(store)
					} else {
						ProgressView().frame(maxWidth: .infinity, minHeight: 300)
					}
				}
				.padding(.horizontal, 96)
				.padding(.top, 56)
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.navigationDestination(for: WorkObject.self) {
				TVObjectDetail(
					environment: environment, forYou: forYou, object: $0, schema: store?.directory.schema)
			}
			.navigationDestination(for: TVDecisionRoute.self) { route in
				if let store = forYou?.store {
					TVDecision(environment: environment, store: store, chief: forYou?.chief, id: route.id)
				}
			}
		}
		.task(id: environment.workspaceId) { await start() }
	}

	private func pills(_ store: ObjectsStore) -> some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 16) {
				pill("All", selected: store.typeFilter == nil) { Task { await store.setType(nil) } }
				ForEach(store.presentTypes, id: \.self) { type in
					pill(store.directory.schema.displayName(for: type), selected: store.typeFilter == type) {
						Task { await store.setType(type) }
					}
				}
			}
			.padding(.vertical, 12)
		}
		.scrollClipDisabled()
	}

	private func pill(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(title).font(.system(size: 28, weight: selected ? .bold : .regular))
				.padding(.horizontal, 32).frame(minHeight: 72)
				.background(selected ? MaskinSurface.fillStrong : Color.clear, in: Capsule())
		}
		.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 36))
	}

	@ViewBuilder private func grid(_ store: ObjectsStore) -> some View {
		if store.objects.isEmpty, store.phase == .loaded {
			EmptyState(symbol: "square.stack.3d.up", title: "Nothing here yet")
		} else if store.objects.isEmpty {
			ProgressView().frame(maxWidth: .infinity, minHeight: 300)
		} else {
			LazyVGrid(columns: columns, spacing: 40) {
				ForEach(store.visibleObjects) { object in
					NavigationLink(value: object) { TVObjectCard(object: object, schema: store.directory.schema) }
						.buttonStyle(TVFocusStyle())
				}
			}
			.padding(.vertical, 24)
		}
	}

	private func start() async {
		guard environment.auth.session != nil else {
			store = nil
			return
		}
		let remote = APIObjectsRemote(
			client: environment.client, credentials: environment.auth.credentialsProvider)
		let auth = environment.auth
		let directory = ObjectsDirectory(remote: remote, workspaceId: { auth.session?.workspaceId })
		let next = ObjectsStore(remote: remote, directory: directory, cache: environment.snapshotCache)
		store = next
		await next.load()
	}
}

private struct TVObjectCard: View {
	let object: WorkObject
	let schema: ObjectsSchema

	var body: some View {
		VStack(alignment: .leading, spacing: 14) {
			HStack(spacing: 12) {
				Circle().fill(MaskinColor.ink3).frame(width: 14, height: 14)
				Text(schema.displayName(for: object.type).uppercased())
					.font(.system(size: 24, weight: .semibold, design: .monospaced))
					.foregroundStyle(MaskinColor.ink4)
				Spacer(minLength: 0)
				if object.unreadCount > 0 {
					Text("NEEDS YOU")
						.font(.system(size: 24, weight: .semibold, design: .monospaced))
						.padding(.horizontal, 14).padding(.vertical, 6)
						.background(MaskinSurface.inverse, in: Capsule())
						.foregroundStyle(MaskinSurface.onInverse)
				}
			}
			Text(object.title ?? "Untitled").font(.system(size: 32, weight: .bold)).lineLimit(2)
			HStack(spacing: 8) {
				Text(object.status.replacingOccurrences(of: "_", with: " "))
				if let updated = object.updatedAt {
					Text("\u{00B7}")
					RelativeTime(updated, style: .compact)
				}
			}
			.font(.system(size: 24)).foregroundStyle(MaskinColor.ink4)
		}
		.padding(32)
		.frame(maxWidth: .infinity, minHeight: 200, alignment: .topLeading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 32, style: .continuous))
	}
}

/// Where Approve and Hold go: the Decision screen for this object's card.
struct TVDecisionRoute: Hashable {
	let id: String
}

/// An object, read only: body, properties, and (when it needs you) Approve / Hold, which open the
/// Decision screen. Editing properties is for iPhone and iPad.
struct TVObjectDetail: View {
	let environment: AppEnvironment
	let forYou: ForYouRuntime?
	let object: WorkObject
	let schema: ObjectsSchema?
	@State private var thread: TVThreadRoute?
	@State private var opening = false
	@State private var askFailed = false

	private var card: ForYouCard? {
		forYou?.store.entries.first { $0.id == object.id && $0.section == .needs }?.card
	}

	private var properties: [(String, String)] {
		var rows = [("Status", object.status.replacingOccurrences(of: "_", with: " "))]
		if let updated = object.updatedAt {
			rows.append(("Updated", updated.formatted(date: .abbreviated, time: .shortened)))
		}
		rows += object.metadata.sorted { $0.key < $1.key }.map {
			($0.key.replacingOccurrences(of: "_", with: " ").capitalized, $0.value)
		}
		return rows
	}

	var body: some View {
		ScrollView {
			HStack(alignment: .top, spacing: 80) {
				VStack(alignment: .leading, spacing: 32) {
					HStack(spacing: 14) {
						Circle().fill(MaskinPatina.dotWatch).frame(width: 18, height: 18)
						Text(((schema?.displayName(for: object.type)) ?? object.type).uppercased())
							.font(.system(size: 26, weight: .semibold, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
					}
					Text(object.title ?? "Untitled").font(.system(size: 68, weight: .bold))
					if let content = object.content?.trimmingCharacters(in: .whitespacesAndNewlines), !content.isEmpty {
						Text(content).font(.system(size: 30)).foregroundStyle(MaskinColor.ink3)
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				VStack(spacing: 20) {
					VStack(alignment: .leading, spacing: 14) {
						Text("PROPERTIES").font(.system(size: 24, weight: .semibold, design: .monospaced))
							.foregroundStyle(MaskinColor.ink4)
						ForEach(properties, id: \.0) { name, value in
							HStack {
								Text(name).font(.system(size: 26)).foregroundStyle(MaskinColor.ink4)
								Spacer(minLength: 16)
								Text(value).font(.system(size: 28, weight: .semibold)).lineLimit(1)
							}
						}
						Text("Edit on iPhone or iPad").font(.system(size: 24)).foregroundStyle(MaskinColor.ink4)
							.padding(.top, 8)
					}
					.padding(34).frame(maxWidth: .infinity, alignment: .leading)
					.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 32, style: .continuous))
					.focusable()
					if card != nil {
						NavigationLink(value: TVDecisionRoute(id: object.id)) {
							TVCapsuleLabel(title: "Approve", prominent: true)
						}
						.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
						NavigationLink(value: TVDecisionRoute(id: object.id)) { TVCapsuleLabel(title: "Hold") }
							.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
					}
					if let card, let chief = forYou?.chief {
						Button {
							Task { await ask(card, chief) }
						} label: {
							TVCapsuleLabel(title: opening ? "Opening\u{2026}" : "Ask Chief of Staff", symbol: "mic.fill")
						}
						.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
					}
				}
				.frame(width: 640)
			}
			.padding(.horizontal, 96)
			.padding(.top, 56)
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.navigationDestination(item: $thread) { TVThread(environment: environment, conversationID: $0.id) }
		.alert("Can't open the thread", isPresented: $askFailed) { Button("OK", role: .cancel) {} }
		.userActivity(TVHandoff.activityType) { activity in
			guard let workspace = environment.workspaceId else { return }
			let handoff = TVHandoff(workspaceId: workspace, objectId: object.id, title: object.title ?? "Object")
			activity.title = handoff.title
			activity.userInfo = handoff.userInfo
			activity.isEligibleForHandoff = true
		}
	}

	private func ask(_ card: ForYouCard, _ chief: ChiefOfStaffDesk) async {
		guard !opening else { return }
		opening = true
		defer { opening = false }
		do {
			let outcome = try await ChiefOfStaffThreads.open(about: card, conversations: chief.conversations)
			thread = TVThreadRoute(id: outcome.conversation.id)
		} catch {
			askFailed = true
		}
	}
}
