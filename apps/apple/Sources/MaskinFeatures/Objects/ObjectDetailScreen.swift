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
	/// Objects linked with `/` in the comment being written, and what the picker is showing.
	@State private var linked: [CommentReference] = []
	@State private var referenceResults: [CommentReference] = []
	@State private var searchingReferences = false
	/// The comment being written: text, `@` mentions, attachments and the reply quote all live in
	/// the shared composer model (spec 7 §1).
	@State private var composer: ChatComposerModel
	@State private var editing = false
	@State private var confirmingDelete = false
	/// Set when the reader sends a comment, so the timeline follows it to the bottom.
	@State private var followNextItem = false
	@State private var atTop = true
	/// The event a held-down Reply picked; the next comment threads under it.
	@State private var replyingTo: TimelineItem?
	@Environment(AppRuntime.self) private var appRuntime: AppRuntime?
	/// The session whose log is open, the one awaiting a Stop confirm, and what Retry would run.
	@State private var logSession: AgentSession?
	@State private var stopTarget: ObjectSession?
	@State private var retryPrompt: String?
	@State private var retrying = false
	@State private var sessionError: String?
	@State private var composerMode: ObjectComposerMode = .comment

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
		_composer = State(
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
		guard let query = ReferenceTrigger.find(in: composer.text)?.query else {
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

	// MARK: Session

	private var agentsSource: APIAgentsSource? {
		environment.workspaceId.map { APIAgentsSource(client: environment.client, workspaceID: $0) }
	}

	private var sessionActions: ObjectSessionActions {
		var actions = ObjectSessionActions()
		actions.isRetrying = retrying
		let hasSource = agentsSource != nil
		if hasSource {
			actions.onWatch = { openLog($0) }
			actions.onSeeLog = { openLog($0) }
			actions.onStop = { stopTarget = $0 }
			if retryPrompt != nil { actions.onRetry = { retry($0) } }
		}
		if let appRuntime {
			actions.onOpenChat = { id in
				appRuntime.openChat(id)
			}
		}
		return actions
	}

	private func openLog(_ session: ObjectSession) {
		logSession = AgentSession(
			id: session.id, actorID: session.agentID, status: session.status, startedAt: session.startedAt)
	}

	private func stop(_ session: ObjectSession) async {
		guard let source = agentsSource else { return }
		do {
			try await source.stop(sessionID: session.id, idempotencyKey: UUID().uuidString)
			await store.refresh()
		} catch {
			sessionError = "Couldn't stop it. Try again."
		}
	}

	private func retry(_ session: ObjectSession) {
		guard let source = agentsSource, let prompt = retryPrompt, !retrying else { return }
		retrying = true
		Task {
			defer { retrying = false }
			do {
				_ = try await source.run(agentID: session.agentID, prompt: prompt, idempotencyKey: UUID().uuidString)
				await store.refresh()
			} catch {
				sessionError = "Couldn't start it again. Try again."
			}
		}
	}

	/// What Retry would run: the failed session's own prompt, read from the agent's sessions.
	/// Without it Retry stays hidden rather than guess one.
	private func loadRetryPrompt() async {
		retryPrompt = nil
		guard let source = agentsSource, let session = store.object?.lastSession, session.isFailed,
			let found = try? await source.sessions(agentID: session.agentID, limit: 20).first(where: { $0.id == session.id }),
			!found.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		else { return }
		retryPrompt = found.prompt
	}

	// MARK: Comments

	private var composerConfig: MaskinComposerConfig {
		MaskinComposerConfig(
			variant: .floating,
			placeholder: composerMode.placeholder(
				commentPlaceholder: replyingTo.map { "Reply to \(store.authorName(for: $0))…" } ?? "Comment — @ to tag, / to link",
				agentName: messageTarget?.name),
			suggestions: { query in
				CommentMentions.candidates(
					query: query, actors: Array(store.directory.actors.values), selfID: store.currentActorId,
					excluding: Set(composer.mentions.map(\.id))
				).map { ChatParticipant(id: $0.id, name: $0.name, kind: $0.isAgent ? .agent : .human) }
			},
			// The same workspace list, with roles, every other composer offers.
			roster: appRuntime?.mentionRoster()?.roster)
	}

	/// Hold → Reply: the composer quotes the event and the next comment threads under it.
	private func startReply(to item: TimelineItem) {
		MaskinHaptics.play(.light)
		withAnimation(reduceMotion ? nil : MaskinMotion.quick) { replyingTo = item }
		composer.reply(to: store.authorName(for: item), text: ActivityGrouping.summary(of: item))
	}

	/// The thread already shows the parent, so the body carries the text alone, not a quote.
	/// Sending jumps to Activity, where the thread is.
	private var messageTarget: ActorRef? {
		ObjectComposerMode.target(object: store.object, actor: { store.directory.actor(for: $0) })
	}

	private func sendComment() {
		if composerMode == .message, let agent = messageTarget, let appRuntime {
			let text = composer.trimmedText
			guard !text.isEmpty else { return }
			composer.clear()
			composerMode = .comment
			appRuntime.startChat(with: ChatParticipant(id: agent.id, name: agent.name, kind: .agent), draft: text)
			return
		}
		let text = composer.trimmedText
		guard !text.isEmpty, !composer.isUploading, !composer.hasFailedAttachment else { return }
		let mentions = composer.mentions.map(\.id).filter { $0 != store.currentActorId }
		let files = composer.attachments.compactMap(\.ref)
		let refs = linked
		let parent = replyingTo?.eventId
		composer.clear()
		linked = []
		replyingTo = nil
		followNextItem = parent == nil
		withAnimation(reduceMotion ? nil : MaskinMotion.quick) { page = .activity }
		Task { await store.postComment(text, mentions: mentions, refs: refs, attachments: files, parentEventId: parent) }
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
			// The composer stays on every page; sending jumps to Activity, where the thread is.
			if store.object != nil {
				VStack(spacing: MaskinSpace.s4) {
					if ReferenceTrigger.find(in: composer.text) != nil {
						ReferenceSuggestions(
							results: referenceResults.filter { ref in !linked.contains { $0.id == ref.id } },
							isSearching: searchingReferences,
							onPick: { ref in
								composer.text = ReferenceTrigger.removingTrigger(from: composer.text)
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
					if let agent = messageTarget, appRuntime != nil {
						ObjectComposerModeToggle(mode: $composerMode, agentName: agent.name)
					}
					MaskinComposer(model: composer, config: composerConfig, onSend: sendComment)
				}
				.frame(maxWidth: ReadingColumn.maxWidth)
				.frame(maxWidth: .infinity)
				.animation(MaskinMotion.quick, value: ReferenceTrigger.find(in: composer.text) != nil)
				.task(id: ReferenceTrigger.find(in: composer.text)?.query) { await searchReferences() }
				// Clearing the quote strip in the composer also drops the thread target.
				.onChange(of: composer.replyTo == nil) { _, cleared in if cleared { replyingTo = nil } }
				.padding(.horizontal, MaskinSpace.s7)
				.padding(.bottom, MaskinSpace.s4)
			}
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
		.task(id: store.object?.lastSession?.id) { await loadRetryPrompt() }
		.confirmationDialog("Stop this session?", isPresented: Binding(get: { stopTarget != nil }, set: { if !$0 { stopTarget = nil } }), titleVisibility: .visible) {
			Button("Stop session", role: .destructive) {
				if let target = stopTarget { Task { await stop(target) } }
				stopTarget = nil
			}
		} message: {
			Text("The agent stops where it is. Nothing already done is undone.")
		}
		.alert("Something went wrong", isPresented: Binding(get: { sessionError != nil }, set: { if !$0 { sessionError = nil } })) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(sessionError ?? "")
		}
		.sheet(item: $logSession) { session in
			if let workspaceID = environment.workspaceId {
				NavigationStack {
					SessionLogsView(
						sessionID: session.id,
						api: APISessionLogsSource(client: environment.client, workspaceID: workspaceID),
						session: session)
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
		// Once per object opened, when it first resolves (a refresh or a live update is not a view).
		.task(id: store.object?.id) {
			guard let object = store.object else { return }
			Analytics.shared.track(
				"object_viewed",
				["entity_id": .string(object.id), "entity_type": "object", "object_type": .string(object.type)])
		}
		.task { await appRuntime?.mentionRoster()?.load() }
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
		return ScrollViewReader { proxy in
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
					ObjectDetailContent(
							store: store, part: .header, onEdit: { editing = true },
							onMessage: { withAnimation(reduceMotion ? nil : MaskinMotion.quick) { page = .activity } },
							sessionActions: sessionActions
						) { EmptyView() }
						.padding(.horizontal, MaskinSpace.s11)
						.padding(.top, MaskinSpace.s2)
						.padding(.bottom, MaskinSpace.s7)
					Section {
						ObjectDetailContent(
							store: store, part: part, onOpenObject: onOpenObject, onEdit: { editing = true },
							onReply: startReply,
							onShowActivity: { withAnimation(reduceMotion ? nil : MaskinMotion.quick) { page = .activity } },
							sessionActions: sessionActions
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
				// A 720 pt reading column, centred, in regular width; full width on iPhone.
				.frame(maxWidth: ReadingColumn.maxWidth)
				.frame(maxWidth: .infinity)
			}
			.scrollDismissesKeyboard(.interactively)
			.refreshable { await store.refresh() }
			.trackingTop($atTop)
			// The newest item is first. Only jump to it after the reader posts, or when a live item
			// arrives while they are already at the top.
			.onChange(of: store.latest?.id) { old, id in
				guard part == .activity, let id, followNextItem || (old != nil && atTop) else { return }
				followNextItem = false
				withAnimation(reduceMotion ? nil : .easeOut(duration: MaskinDuration.slide)) { proxy.scrollTo(id, anchor: .top) }
			}
		}
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
	/// Reads the text from the rich editor when it is the one on screen.
	@State private var descriptionField = DescriptionEditorHandle()
	@State private var saving = false
	@State private var readFailed = false

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
				DescriptionEditor(text: $content, handle: descriptionField)
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
					Button("Save") { Task { await commit() } }
						.disabled(saving || descriptionField.isOpening || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
				}
			}
		}
		.presentationDetents([.large])
		.alert("Couldn't read the text", isPresented: $readFailed) {
			Button("OK", role: .cancel) {}
		} message: {
			Text("Nothing was saved. Try again.")
		}
	}

	/// Sends the edit. With the rich editor the text is read from its page first, and nothing is
	/// sent if the page cannot answer, so a failed read never saves the wrong text.
	private func commit() async {
		saving = true
		var text = content
		if let read = descriptionField.readMarkdown {
			guard let markdown = await read() else {
				saving = false
				readFailed = true
				return
			}
			text = markdown
		}
		let patch = ObjectPatch(
			title: title.trimmingCharacters(in: .whitespacesAndNewlines) == (object.title ?? "")
				? nil : title.trimmingCharacters(in: .whitespacesAndNewlines),
			content: text == (object.content ?? "") ? nil : text)
		dismiss()
		await save(patch)
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
