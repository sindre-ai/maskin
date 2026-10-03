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
	@State private var comment = ""
	@State private var editing = false
	@State private var confirmingDelete = false
	/// Set when the reader sends a comment, so the timeline follows it to the bottom.
	@State private var followNextItem = false
	@State private var atBottom = false

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
		ScrollViewReader { proxy in
			ScrollView {
				ObjectDetailContent(store: store, onOpenObject: onOpenObject, onEdit: { editing = true }) {
					decision
				}
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.top, MaskinSpace.s5)
				.padding(.bottom, MaskinSpace.s12)
			}
			.scrollDismissesKeyboard(.interactively)
			.trackingBottom($atBottom)
			// Opening an object lands at the top (header + decision). Only follow the timeline after
			// the reader posts, or when a live item arrives while they are already at the bottom.
			.onChange(of: store.timeline.last?.id) { old, id in
				guard let id, followNextItem || (old != nil && atBottom) else { return }
				followNextItem = false
				withAnimation(.easeOut(duration: MaskinDuration.slide)) { proxy.scrollTo(id, anchor: .bottom) }
			}
		}
		.background(MaskinSurface.grouped)
		.safeAreaInset(edge: .bottom) {
			if store.object != nil {
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
		#endif
		.toolbar {
			ToolbarItemGroup(placement: .primaryAction) {
				if let object = store.object {
					Button {
						Task { await store.toggleStar() }
					} label: {
						Label(object.isStarred ? "Unstar" : "Star", systemImage: object.isStarred ? "star.fill" : "star")
					}
					Menu {
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
	/// Reports whether a scroll view sits within a screenful of its end (iOS 18+; always false before).
	fileprivate func trackingBottom(_ atBottom: Binding<Bool>) -> some View {
		if #available(iOS 18, macOS 15, *) {
			return AnyView(
				onScrollGeometryChange(for: Bool.self) { geometry in
					geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 80
				} action: { _, new in
					atBottom.wrappedValue = new
				})
		}
		return AnyView(self)
	}
}
