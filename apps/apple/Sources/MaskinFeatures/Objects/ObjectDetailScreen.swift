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
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var store: ObjectDetailStore
	private let environment: AppEnvironment
	private let onOpenObject: ((String) -> Void)?
	private let onClose: (() -> Void)?
	private let decision: Decision

	@Environment(\.dismiss) private var dismiss
	@Environment(\.horizontalSizeClass) private var sizeClass
	@State private var editing = false
	@State private var confirmingDelete = false
	@State private var atTop = true
	/// Comments live in the object's group chat, pushed from the bar at the bottom or from the
	/// latest-activity card.
	@State private var showingChat = false
	@Environment(AppRuntime.self) private var appRuntime: AppRuntime?

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
				pageScroll
			} else {
				ScrollView {
					ObjectDetailContent(store: store, onEdit: { editing = true }) { EmptyView() }
						.padding(.horizontal, MaskinSpace.s9)
						.padding(.top, MaskinSpace.s5)
				}
				.refreshable { await store.refresh() }
			}
		}
		.ambientBackground()
		.safeAreaInset(edge: .bottom) {
			if store.object != nil {
				ChatEntryBar { openChat() }
					.padding(.horizontal, MaskinSpace.s7)
					.padding(.bottom, MaskinSpace.s4)
			}
		}
		.navigationDestination(isPresented: $showingChat) {
			ObjectChatScreen(
				environment: environment, objectID: store.objectId, title: store.object?.displayTitle ?? "Chat")
		}
		// The header carries the title; the bar takes it over once the header has scrolled away.
		.navigationTitle(atTop ? "" : (store.object?.displayTitle ?? ""))
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
						if let link = objectLink(object) {
							Button {
								ActivityClipboard.copy(link.absoluteString)
								MaskinHaptics.play(.selection)
							} label: {
								Label("Copy link", systemImage: "link")
							}
						}
						Button {
							ActivityClipboard.copy(object.id)
							MaskinHaptics.play(.selection)
						} label: {
							Label("Copy ID", systemImage: "number")
						}
						Button {
							editing = true
						} label: {
							Label("Edit", systemImage: "pencil")
						}
						if store.canArchive, object.status != ObjectDetailStore.archivedStatus {
							Button {
								MaskinHaptics.play(.light)
								Task { await store.archive() }
							} label: {
								Label("Archive", systemImage: "archivebox")
							}
						}
						Button(role: .destructive) {
							confirmingDelete = true
						} label: {
							Label("Delete", systemImage: "trash")
						}
					} label: {
						Label("More", systemImage: "ellipsis")
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

	/// The page on screen, remembered per object by the store.
	private var page: ObjectDetailPart? {
		get { ObjectDetailPart(store.selectedTab) }
		nonmutating set { if let tab = newValue?.tab, tab != store.selectedTab { store.selectedTab = tab } }
	}

	/// The Overview dot: a decision is waiting on the reader for this object.
	private var needsYou: Bool {
		guard Decision.self != EmptyView.self, let runtime = appRuntime else { return false }
		return ObjectDecisionSection.needsYou(objectId: store.objectId, in: runtime.forYou.store.entries)
	}

	/// Overview • · Related N · Activity N: the active page is an ink pill, the rest quiet text.
	private var pageBar: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s2) {
				ForEach(pages, id: \.part) { item in
					let selected = (page ?? .overview) == item.part
					Button {
						MaskinHaptics.play(.selection)
						withAnimation(reduceMotion ? nil : MaskinMotion.quick) { page = item.part }
					} label: {
						HStack(spacing: MaskinSpace.s3) {
							Text(item.title)
								.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .body))
							if item.needsYou {
								Circle().fill(MaskinColor.sig)
									.frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
									.accessibilityLabel("Needs you")
							}
							if let count = item.count, count > 0 {
								Text("\(count)")
									.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
									.monospacedDigit()
									.foregroundStyle(selected ? MaskinSurface.onInverse.opacity(0.7) : MaskinColor.ink5)
							}
						}
						.foregroundStyle(selected ? MaskinSurface.onInverse : MaskinColor.ink4)
						.padding(.horizontal, MaskinSpace.s8)
						.frame(height: MaskinSpace.s14 + MaskinSpace.s2)
						.background(
							selected ? MaskinSurface.inverse : Color.clear,
							in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed(.shrink))
					.accessibilityAddTraits(selected ? .isSelected : [])
				}
			}
			.padding(.horizontal, MaskinSpace.s8)
		}
	}

	private var pages: [(part: ObjectDetailPart, title: String, count: Int?, needsYou: Bool)] {
		[
			(.overview, "Overview", nil, needsYou),
			(.related, "Related", store.relatedGroups.reduce(0) { $0 + $1.links.count }, false),
			(.activity, "Activity", store.timeline.count, false),
		]
	}

	/// One scroll view: the header scrolls away, the tab bar pins under the nav (a pinned section
	/// header), and the chosen page follows. The header is read once, above the tabs, as decision 5
	/// asks; switching pages never loses it.
	private var pageScroll: some View {
		let part = page ?? .overview
		return ScrollView {
			LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
				ObjectDetailContent(store: store, part: .header, onEdit: { editing = true }) { EmptyView() }
					.padding(.horizontal, MaskinSpace.s11)
					.padding(.top, MaskinSpace.s2)
					.padding(.bottom, MaskinSpace.s7)
				Section {
					ObjectDetailContent(
						store: store, part: part, onOpenObject: onOpenObject, onEdit: { editing = true },
						onShowActivity: { openChat() }
					) { decision }
					.padding(.horizontal, MaskinSpace.s9)
					.padding(.top, MaskinSpace.s5)
					.padding(.bottom, MaskinSpace.s12 * 4)
					.id(part)
					.transition(.opacity)
				} header: {
					pageBar
						.padding(.top, MaskinSpace.s2)
						.padding(.bottom, MaskinSpace.s4)
						.background(MaskinSurface.grouped)
						.overlay(alignment: .bottom) { Rectangle().fill(MaskinSurface.separator).frame(height: 1) }
				}
			}
		}
		.scrollDismissesKeyboard(.interactively)
		.refreshable { await store.refresh() }
		.trackingTop($atTop)
	}

	private func openChat() {
		MaskinHaptics.play(.light)
		showingChat = true
	}

	private func shareText(_ object: WorkObject) -> String {
		var parts = [object.displayTitle, object.content ?? ""].filter { !$0.isEmpty }
		if let link = objectLink(object) { parts.append(link.absoluteString) }
		return parts.joined(separator: "\n\n")
	}

	/// The web URL for this object, when the workspace is known.
	private func objectLink(_ object: WorkObject) -> URL? {
		guard let workspace = environment.workspaceId, !workspace.isEmpty else { return nil }
		return DeepLink.object(workspaceId: workspace, id: object.id).universalURL()
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
			VStack(alignment: .leading, spacing: MaskinSpace.s6) {
				TextField("Title", text: $title, axis: .vertical)
					.lineLimit(1...3)
					.maskinText(.title)
				Divider()
				MarkdownEditor(text: $content, placeholder: "Description")
			}
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.top, MaskinSpace.s5)
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

/// The way into an object's chat, where comments are written. A glass pill at the bottom, in the
/// place the comment box used to be.
private struct ChatEntryBar: View {
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s4) {
				Image(systemName: "bubble.left.and.bubble.right")
				Text("Chat about this")
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .body))
				Spacer(minLength: 0)
				Image(systemName: "chevron.right")
					.font(.footnote.weight(.semibold))
					.foregroundStyle(MaskinColor.ink5)
			}
			.foregroundStyle(MaskinColor.ink)
			.padding(.horizontal, MaskinSpace.s8)
			.frame(minHeight: MaskinSpace.touchMin)
			.maskinGlass(in: Capsule(), interactive: true)
			.overlay(Capsule().strokeBorder(MaskinSurface.glassBorder, lineWidth: 0.5))
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel("Chat about this")
	}
}
