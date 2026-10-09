import MaskinCore
import MaskinDesign
import MaskinUI
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

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
	/// Actors tagged with `@` in the comment being written (kept only while their `@Name` is in it).
	@State private var tagged: [ActorRef] = []
	/// Objects linked with `/` in the comment being written, and what the picker is showing.
	@State private var linked: [CommentReference] = []
	@State private var referenceResults: [CommentReference] = []
	@State private var searchingReferences = false
	/// Files being attached to the comment: uploads, retries and limits live in the chat model.
	@State private var attachments: ChatComposerModel
	@State private var askingAttachment = false
	@State private var showPhotos = false
	@State private var showFiles = false
	@State private var photoItems: [PhotosPickerItem] = []
	@State private var dictating = false
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
		let env = services.environment
		_attachments = State(
			initialValue: ChatComposerModel(
				uploader: APIChatsSource(client: env.client, workspaceID: env.workspaceId ?? ""),
				selfActorID: env.auth.session?.actorId ?? ""))
		environment = services.environment
		self.onOpenObject = onOpenObject
		self.onClose = onClose
		self.decision = decision
	}

	/// Fills the `/` picker for what is typed after the slash, waiting a beat so a fast typist
	/// doesn't fire a request per letter.
	private func searchReferences() async {
		guard let query = ReferenceTrigger.find(in: comment)?.query else {
			referenceResults = []
			return
		}
		searchingReferences = true
		try? await Task.sleep(for: .milliseconds(200))
		guard !Task.isCancelled else { return }
		let found = await store.searchObjects(query)
		guard !Task.isCancelled else { return }
		referenceResults = found
		searchingReferences = false
	}

	/// "Post to Build's timeline…" from the object's first word.
	private var timelinePlaceholder: String {
		let first = store.object?.displayTitle.split(separator: " ").first.map(String.init) ?? ""
		return first.isEmpty ? "Post to the timeline — @ to tag, / to link" : "Post to \(first)'s timeline…"
	}

	public var body: some View {
		Group {
			if store.object != nil {
				VStack(spacing: 0) {
					pageBar.padding(.vertical, MaskinSpace.s3)
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
		.ambientBackground()
		.safeAreaInset(edge: .bottom) {
			// The composer stays on every page; sending jumps to Activity, where the thread is.
			if store.object != nil {
				VStack(spacing: MaskinSpace.s4) {
					if let match = MentionTrigger.find(in: comment) {
						MentionSuggestions(
							candidates: CommentMentions.candidates(
								query: match.query, actors: Array(store.directory.actors.values),
								selfID: store.currentActorId, excluding: Set(tagged.map(\.id))
							).map { ChatParticipant(id: $0.id, name: $0.name, kind: $0.isAgent ? .agent : .human) },
							inConversation: [],
							onPick: { person in
								guard let actor = store.directory.actor(for: person.id) else { return }
								comment = CommentMentions.inserting(actor, into: comment)
								tagged.append(actor)
							})
							.transition(.opacity.combined(with: .move(edge: .bottom)))
					}
					if ReferenceTrigger.find(in: comment) != nil {
						ReferenceSuggestions(
							results: referenceResults.filter { ref in !linked.contains { $0.id == ref.id } },
							isSearching: searchingReferences,
							onPick: { ref in
								comment = ReferenceTrigger.removingTrigger(from: comment)
								if linked.count < ReferenceTrigger.maxReferences { linked.append(ref) }
							})
							.transition(.opacity.combined(with: .move(edge: .bottom)))
					}
					if !linked.isEmpty {
						ChipFlow {
							ForEach(linked) { ref in
								ReferenceChip(ref: ref, onRemove: { linked.removeAll { $0.id == ref.id } })
							}
						}
						.frame(maxWidth: .infinity, alignment: .leading)
						.padding(.horizontal, MaskinSpace.s5)
					}
					ComposerChips(model: attachments)
					if let notice = attachments.notice {
						Text(notice).maskinText(.caption).foregroundStyle(MaskinColor.danger)
							.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, MaskinSpace.s5)
							.onTapGesture { attachments.notice = nil }
					}
					GlassComposer(
						text: $comment, placeholder: timelinePlaceholder,
						canSend: !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
							&& !attachments.isUploading && !attachments.hasFailedAttachment,
						onAttach: { askingAttachment = true },
						onSend: {
							let text = comment
							let mentions = CommentMentions.active(tagged, in: text)
							let refs = linked
							let files = attachments.attachments.compactMap(\.ref)
							comment = ""
							tagged = []
							linked = []
							attachments.clear()
							followNextItem = true
							withAnimation(MaskinMotion.spring) { page = .activity }
							Task { await store.postComment(text, mentions: mentions, refs: refs, attachments: files) }
						},
						listening: $dictating, mic: { DictationButton(text: $comment, listening: $dictating) })
				}
				.animation(MaskinMotion.quick, value: MentionTrigger.find(in: comment) != nil)
				.animation(MaskinMotion.quick, value: ReferenceTrigger.find(in: comment) != nil)
				.task(id: ReferenceTrigger.find(in: comment)?.query) { await searchReferences() }
				.confirmationDialog("Attach", isPresented: $askingAttachment) {
					Button("Photo") { showPhotos = true }
					Button("File") { showFiles = true }
				}
				.photosPicker(
					isPresented: $showPhotos, selection: $photoItems,
					maxSelectionCount: max(1, ChatLimits.maxAttachments - attachments.attachments.count),
					matching: .images)
				.fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) {
					result in
					guard case .success(let urls) = result else { return }
					for url in urls {
						attachments.attach(
							name: url.lastPathComponent, mimeType: AttachmentLoading.mimeType(for: url),
							prepare: AttachmentLoading.file(at: url))
					}
				}
				.onChange(of: photoItems) { _, items in
					guard !items.isEmpty else { return }
					for (index, item) in items.enumerated() {
						let name = AttachmentLoading.photoName(index: index)
						attachments.attach(
							name: name, mimeType: "image/jpeg", prepare: AttachmentLoading.photo(item, name: name))
					}
					photoItems = []
				}
				.padding(.horizontal, MaskinSpace.s7)
				.padding(.bottom, MaskinSpace.s3)
			}
		}
		// The title scrolls away with the overview's header, so it lives in the bar for every page.
		.navigationTitle(page == .overview || page == nil ? "" : (store.object?.displayTitle ?? ""))
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
						withAnimation(MaskinMotion.spring) { page = .activity }
					} label: {
						Label("Activity", systemImage: "bubble.left.and.text.bubble.right")
					}
					Menu {
						Button {
							MaskinHaptics.play(.selection)
							Task { await store.toggleStar() }
						} label: {
							Label(object.isStarred ? "Unstar" : "Star", systemImage: object.isStarred ? "star.fill" : "star")
						}
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

	@State private var page: ObjectDetailPart? = .overview

	private var hasDecision: Bool { Decision.self != EmptyView.self }

	/// Segmented control: a rounded track with the selected page on a raised card.
	private var pageBar: some View {
		HStack(spacing: 0) {
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
							Circle().fill(MaskinColor.sig)
								.frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
								.accessibilityLabel("Needs you")
						}
					}
					.maskinText(.subhead)
					.fontWeight(selected ? .semibold : .medium)
					.foregroundStyle(selected ? MaskinColor.ink : MaskinColor.ink4)
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin - MaskinSpace.s2)
					.background {
						if selected {
							Capsule().fill(MaskinSurface.card)
						}
					}
					.contentShape(Capsule())
				}
				.buttonStyle(.maskinPressed(.shrink))
				.accessibilityAddTraits(selected ? .isSelected : [])
			}
		}
		.padding(MaskinSpace.s2)
		.background(MaskinSurface.fill, in: Capsule())
		.padding(.horizontal, MaskinSpace.s9)
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
		.onChange(of: page) { _, _ in MaskinHaptics.play(.selection) }
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
