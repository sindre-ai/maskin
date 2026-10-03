import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One object, full screen: header, decision slot, description, relationships and the activity
/// timeline with a glass composer. Push it from anywhere:
///
///     ObjectDetailScreen(environment: env, objectId: id) { MyDecisionCard() }
///
/// `decisionSection` renders directly under the header; the For You slice plugs its approve /
/// hold card in there. Tapping a related object calls `onOpenObject` (omit it to make the
/// relationships list read-only).
public struct ObjectDetailScreen<Decision: View>: View {
	@State private var store: ObjectDetailStore
	private let environment: AppEnvironment
	private let onOpenObject: ((String) -> Void)?
	private let onClose: (() -> Void)?
	private let decision: Decision

	@Environment(\.dismiss) private var dismiss
	@Environment(\.horizontalSizeClass) private var sizeClass
	@State private var comment = ""
	@State private var editing = false
	@State private var confirmingDelete = false
	/// Set when the reader sends a comment, so the timeline follows it to the bottom.
	@State private var followNextItem = false
	@State private var atTop = true

	public init(
		environment: AppEnvironment, objectId: String, onOpenObject: ((String) -> Void)? = nil,
		@ViewBuilder decisionSection: () -> Decision
	) {
		let services = ObjectsServices(environment: environment)
		self.init(
			services: services, objectId: objectId, preload: nil, listStore: nil,
			onOpenObject: onOpenObject, onClose: nil, decision: decisionSection())
	}

	init(
		services: ObjectsServices, objectId: String, preload: WorkObject?, listStore: ObjectsStore?,
		onOpenObject: ((String) -> Void)?, onClose: (() -> Void)?, decision: Decision
	) {
		let store = services.detailStore(for: objectId, preload: preload)
		store.onObjectChanged = { [weak listStore] in listStore?.apply($0) }
		store.onObjectDeleted = { [weak listStore] in listStore?.remove($0) }
		_store = State(initialValue: store)
		environment = services.environment
		self.onOpenObject = onOpenObject
		self.onClose = onClose
		self.decision = decision
	}

	public var body: some View {
		Group {
			if store.object != nil {
				VStack(spacing: 0) {
					ObjectDetailContent(store: store, part: .header) { EmptyView() }
						.padding(.horizontal, MaskinSpace.s9)
						.padding(.top, MaskinSpace.s5)
						.padding(.bottom, MaskinSpace.s5)
					pageBar
					pager
				}
			} else {
				ScrollView {
					ObjectDetailContent(store: store, onEdit: { editing = true }) { EmptyView() }
						.padding(.horizontal, MaskinSpace.s9)
						.padding(.top, MaskinSpace.s5)
				}
				.refreshable { await store.refresh() }
			}
		}
		.background(MaskinSurface.grouped)
		.safeAreaInset(edge: .bottom) {
			// Commenting lives on the Activity page, where the thread is.
			if store.object != nil, page == .activity {
				GlassComposer(text: $comment, placeholder: "Comment") {
					let text = comment
					comment = ""
					followNextItem = true
					Task { await store.postComment(text) }
				}
				.padding(.horizontal, MaskinSpace.s7)
				.padding(.bottom, MaskinSpace.s3)
			}
		}
		.navigationTitle(store.object.map { store.directory.typeName($0.type) } ?? "Object")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			// The tab bar would sit on top of the composer, as in a chat. iPad keeps it.
			.toolbar(sizeClass == .compact ? .hidden : .automatic, for: .tabBar)
		#endif
		.toolbar {
			ToolbarItemGroup(placement: .primaryAction) {
				if let object = store.object {
					Button {
						MaskinHaptics.play(.selection)
						Task { await store.toggleStar() }
					} label: {
						Label(object.isStarred ? "Unstar" : "Star", systemImage: object.isStarred ? "star.fill" : "star")
					}
					Menu {
						ShareLink(item: shareText(object)) { Label("Share", systemImage: "square.and.arrow.up") }
						Button {
							editing = true
						} label: {
							Label("Edit", systemImage: "pencil")
						}
						Button(role: .destructive) {
							confirmingDelete = true
						} label: {
							Label("Delete", systemImage: "trash")
						}
					} label: {
						Label("More", systemImage: "ellipsis.circle")
					}
				}
			}
		}
		.sheet(isPresented: $editing) {
			if let object = store.object {
				EditObjectSheet(object: object) { patch in await store.edit(patch) }
			}
		}
		.confirmationDialog("Delete this object?", isPresented: $confirmingDelete, titleVisibility: .visible) {
			Button("Delete", role: .destructive) { Task { await store.delete() } }
		} message: {
			Text("This can't be undone.")
		}
		.onChange(of: store.didDelete) { _, deleted in if deleted { close() } }
		.task { await store.load() }
		.task { await store.observe(environment.events.subscribe()) }
	}

	// MARK: Pages

	@State private var page: ObjectDetailPart? = .overview

	private var hasDecision: Bool { Decision.self != EmptyView.self }

	private var pageBar: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s2) {
				ForEach(pages, id: \.part) { item in
					let selected = (page ?? .overview) == item.part
					Button {
						withAnimation(MaskinMotion.spring) { page = item.part }
					} label: {
						HStack(spacing: MaskinSpace.s3) {
							Text(item.title)
							if let count = item.count, count > 0 {
								Text("\(count)").foregroundStyle(MaskinColor.ink5)
							}
							if item.needsYou {
								Circle().fill(MaskinColor.accent)
									.frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
									.accessibilityLabel("Needs you")
							}
						}
						.maskinText(.subhead)
						.fontWeight(selected ? .semibold : .regular)
						.foregroundStyle(selected ? MaskinColor.ink : MaskinColor.ink4)
						.padding(.horizontal, MaskinSpace.s6)
						.frame(minHeight: MaskinSpace.s14)
						.background(selected ? MaskinSurface.fill : Color.clear, in: Capsule())
						.contentShape(Capsule())
					}
					.buttonStyle(.plain)
					.accessibilityAddTraits(selected ? .isSelected : [])
				}
			}
			.padding(.horizontal, MaskinSpace.s9)
		}
	}

	private var pages: [(part: ObjectDetailPart, title: String, count: Int?, needsYou: Bool)] {
		[
			(.overview, "Overview", nil, hasDecision),
			(.related, "Related", store.links.count, false),
			(.activity, "Activity", store.timeline.count, false),
		]
	}

	/// Horizontal paging with a plain scroll view rather than a page-style `TabView`, which fights
	/// the navigation stack's edge swipe back. Each page keeps its own vertical scroll position.
	private var pager: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			LazyHStack(spacing: 0) {
				ForEach(pages, id: \.part) { item in
					pageBody(item.part)
						.containerRelativeFrame(.horizontal)
						.id(item.part)
				}
			}
			.scrollTargetLayout()
		}
		.scrollTargetBehavior(.paging)
		.scrollPosition(id: $page)
		.scrollBounceBehavior(.basedOnSize, axes: .horizontal)
	}

	@ViewBuilder private func pageBody(_ part: ObjectDetailPart) -> some View {
		ScrollViewReader { proxy in
			ScrollView {
				ObjectDetailContent(
					store: store, part: part, onOpenObject: onOpenObject, onEdit: { editing = true }
				) { decision }
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.top, MaskinSpace.s3)
				.padding(.bottom, MaskinSpace.s12)
			}
			.scrollDismissesKeyboard(.interactively)
			.refreshable { await store.refresh() }
			.trackingTop(part == .activity ? $atTop : .constant(true))
			// The newest item is first. Only jump to it after the reader posts, or when a live item
			// arrives while they are already at the top.
			.onChange(of: store.timeline.last?.id) { old, id in
				guard part == .activity, let id, followNextItem || (old != nil && atTop) else { return }
				followNextItem = false
				withAnimation(.easeOut(duration: MaskinDuration.slide)) { proxy.scrollTo(id, anchor: .top) }
			}
		}
	}

	private func shareText(_ object: WorkObject) -> String {
		[object.displayTitle, object.content].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
	}

	private func close() {
		if let onClose { onClose() } else { dismiss() }
	}
}

extension ObjectDetailScreen where Decision == EmptyView {
	public init(
		environment: AppEnvironment, objectId: String, onOpenObject: ((String) -> Void)? = nil
	) {
		self.init(
			environment: environment, objectId: objectId, onOpenObject: onOpenObject
		) { EmptyView() }
	}
}

/// Edit title and description.
struct EditObjectSheet: View {
	let object: WorkObject
	let save: (ObjectPatch) async -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var title: String
	@State private var content: String

	init(object: WorkObject, save: @escaping (ObjectPatch) async -> Void) {
		self.object = object
		self.save = save
		_title = State(initialValue: object.title ?? "")
		_content = State(initialValue: object.content ?? "")
	}

	var body: some View {
		NavigationStack {
			Form {
				Section("Title") {
					TextField("Title", text: $title, axis: .vertical).lineLimit(1...3)
				}
				Section("Description") {
					TextField("Description (markdown supported)", text: $content, axis: .vertical)
						.lineLimit(5...16)
				}
			}
			.navigationTitle("Edit")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Save") {
						let patch = ObjectPatch(
							title: title.trimmingCharacters(in: .whitespacesAndNewlines) == (object.title ?? "")
								? nil : title.trimmingCharacters(in: .whitespacesAndNewlines),
							content: content == (object.content ?? "") ? nil : content)
						dismiss()
						Task { await save(patch) }
					}
					.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
				}
			}
		}
		.presentationDetents([.large])
	}
}

extension View {
	/// Reports whether a scroll view sits within a screenful of its start (iOS 18+; always true before).
	fileprivate func trackingTop(_ atTop: Binding<Bool>) -> some View {
		if #available(iOS 18, macOS 15, *) {
			return AnyView(
				onScrollGeometryChange(for: Bool.self) { geometry in
					geometry.contentOffset.y <= 80
				} action: { _, new in
					atTop.wrappedValue = new
				})
		}
		return AnyView(self)
	}
}
