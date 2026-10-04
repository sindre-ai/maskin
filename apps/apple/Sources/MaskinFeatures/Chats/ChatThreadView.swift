import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The thread for one conversation: history, live messages, a composer pinned above the keyboard.
/// Takes a ready `ChatStore` and `ChatComposerModel` so it previews and snapshots without a server.
struct ChatThreadView: View {
	let store: ChatStore
	let composer: ChatComposerModel
	var conversations: ConversationsStore?
	var onShowParticipants: () -> Void = {}

	@Environment(\.scenePhase) private var scenePhase
	@Environment(\.horizontalSizeClass) private var sizeClass
	@State private var isAtBottom = true
	@State private var hasUnseen = false
	@State private var stopTarget: ChatAgentSession?
	@State private var renaming = false
	@State private var newTitle = ""
	@State private var searching = false
	@State private var searchText = ""
	@State private var matchIndex: Int?
	@AppStorage("chat.handsFree") private var handsFree = false

	/// Recomputed only when the query or the message list changes (see `refreshMatches`), never
	/// per render: a search is a scan over every loaded message.
	@State private var matchIDs: [String] = []
	@State private var matchSet: Set<String> = []
	@State private var handsFreeTracker = HandsFreeTracker()
	private var currentMatchID: String? {
		guard searching, let matchIndex, matchIDs.indices.contains(matchIndex) else { return nil }
		return matchIDs[matchIndex]
	}

	private static let bottomID = "thread-bottom"
	private static let maxReadableWidth: CGFloat = 760

	var body: some View {
		observedContent
			.background(MaskinSurface.grouped)
			.safeAreaInset(edge: .bottom, spacing: 0) { composerBar }
			.navigationTitle(store.title)
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			// The tab bar would sit on top of the composer. iPad keeps it: the split view has room.
			.toolbar(sizeClass == .compact ? .hidden : .automatic, for: .tabBar)
			#endif
			.toolbar {
				ToolbarItem(placement: .principal) { header }
				// One trailing button with a flat menu: a second toolbar item makes iOS fold both into
				// a "More" overflow.
				ToolbarItem(placement: .primaryAction) {
					Menu {
						Button {
							searching.toggle()
							if !searching { searchText = "" }
						} label: {
							Label("Search this chat", systemImage: "magnifyingglass")
						}
						Button(action: onShowParticipants) { Label("People", systemImage: "person.2") }
						if let conversations, let row = conversations.conversation(id: store.conversationID) {
							Button {
								Task { await conversations.setPinned(row.id, !row.pinned) }
							} label: {
								Label(row.pinned ? "Unpin" : "Pin", systemImage: row.pinned ? "pin.slash" : "pin")
							}
						}
						Button {
							newTitle = store.title
							renaming = true
						} label: {
							Label("Rename", systemImage: "pencil")
						}
						Toggle(isOn: $handsFree) {
							Label("Read replies aloud", systemImage: "speaker.wave.2")
						}
						if let conversations, let row = conversations.conversation(id: store.conversationID) {
							Button {
								Task { await conversations.setArchived(row.id, !row.archived) }
							} label: {
								Label(row.archived ? "Unarchive" : "Archive", systemImage: "archivebox")
							}
						}
					} label: {
						Label("Chat options", systemImage: "ellipsis")
					}
				}
			}
			.task {
				store.isActive = scenePhase == .active
				await store.start()
				primeHandsFree()
			}
			.onDisappear {
				store.isActive = false
				SpeechReader.shared.stop()
				store.stop()
			}
			.onChange(of: scenePhase) { _, phase in store.isActive = phase == .active }
			.alert(
				"Something went wrong",
				isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })
			) {
				Button("OK", role: .cancel) {}
			} message: {
				Text(store.notice ?? "")
			}
			.alert("Rename conversation", isPresented: $renaming) {
				TextField("Title", text: $newTitle)
				Button("Cancel", role: .cancel) {}
				Button("Save") { Task { await store.rename(to: newTitle) } }
			}
			.confirmationDialog(
				"Stop this agent?", isPresented: Binding(get: { stopTarget != nil }, set: { if !$0 { stopTarget = nil } }),
				titleVisibility: .visible, presenting: stopTarget
			) { session in
				Button("Stop", role: .destructive) { Task { await store.stopSession(session.id) } }
			} message: { _ in
				Text("It will stop what it's doing. You can ask it to continue afterwards.")
			}
	}

	/// The navigation bar's centre: the agent's icon, its name, and the conversation title under
	/// it. Not a menu: People, Pin and the rest live in the ellipsis menu.
	private var header: some View {
		let others = store.participants.filter { $0.id != store.currentActorID }
		let shown = others.isEmpty ? store.participants : others
		let agents = shown.filter { $0.kind == .agent }
		let names = (agents.isEmpty ? shown : agents).map(\.name).joined(separator: ", ")
		return HStack(spacing: MaskinSpace.s5) {
			ConversationAvatar(
				participants: shown, size: MaskinSpace.s14, working: !store.workingAgents().isEmpty)
			VStack(alignment: .leading, spacing: 0) {
				Text(names.isEmpty ? store.title : names)
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink).lineLimit(1)
				if !names.isEmpty {
					Text(store.title)
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
				}
			}
		}
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}

	/// The thread plus the observers for search and hands-free speech (kept apart so `body`
	/// type-checks quickly).
	private var observedContent: some View {
		content
			.onChange(of: searchText) { _, _ in
				refreshMatches()
				matchIndex = matchIDs.isEmpty ? nil : matchIDs.count - 1
			}
			.onChange(of: store.messages.count) { _, _ in
				if searching { refreshMatches() }
				speakNewReplies()
			}
			.onChange(of: store.messages.last?.id) { _, _ in speakNewReplies() }
			.onChange(of: store.phase) { _, _ in primeHandsFree() }
			.onChange(of: handsFree) { _, on in if !on { SpeechReader.shared.stop() } }
			// Typing means the reader is done listening.
			.onChange(of: composer.text) { _, text in if !text.isEmpty { SpeechReader.shared.stop() } }
	}

	@ViewBuilder
	private var content: some View {
		switch store.phase {
		case .idle, .loading:
			ScrollView { LoadingSkeleton(rows: 3).padding(MaskinSpace.s9) }
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't open this chat", message: message) {
				Button("Try again") { Task { await store.load() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			if store.messages.isEmpty {
				EmptyState(
					symbol: "bubble.left.and.text.bubble.right", title: "Say hello",
					message: "Messages here reach everyone in the conversation, including agents.")
			} else {
				thread
			}
		}
	}

	private var thread: some View {
		ScrollViewReader { proxy in
			ScrollView {
				LazyVStack(alignment: .leading, spacing: MaskinSpace.s5) {
					if store.hasEarlier {
						ProgressView()
							.frame(maxWidth: .infinity)
							.onAppear { loadEarlier(proxy) }
					}
					ThreadTranscript(
						store: store, onStop: { stopTarget = $0 }, matchIDs: matchSet,
						currentMatchID: currentMatchID)
					Color.clear.frame(height: 1).id(Self.bottomID)
						.onAppear { if !usesGeometryTracking { reachedBottom() } }
						.onDisappear { if !usesGeometryTracking { isAtBottom = false } }
				}
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.top, MaskinSpace.s5)
				.padding(.bottom, MaskinSpace.s7)
				// Readable measure on iPad and Mac; full width on iPhone.
				.frame(maxWidth: Self.maxReadableWidth)
				.frame(maxWidth: .infinity)
			}
			.defaultScrollAnchor(.bottom)
			.trackingBottom { atBottom in
				if atBottom { reachedBottom() } else { isAtBottom = false }
			}
			.refreshable { await store.refresh() }
			.scrollDismissesKeyboard(.interactively)
			.onChange(of: store.messages.last?.id) { _, _ in
				// Follow new messages only while the reader is at the bottom (or just sent one);
				// otherwise leave them where they are and offer a jump.
				if isAtBottom || store.messages.last?.actorID == store.currentActorID {
					scrollToBottom(proxy)
				} else {
					hasUnseen = true
				}
			}
			.overlay(alignment: .bottom) {
				if !isAtBottom {
					Button {
						scrollToBottom(proxy)
					} label: {
						Label(hasUnseen ? "New messages" : "Latest", systemImage: "arrow.down")
							.maskinText(.subhead)
							.padding(.horizontal, MaskinSpace.s8)
							.padding(.vertical, MaskinSpace.s4)
							.foregroundStyle(MaskinColor.ink)
							.maskinGlassCapsule(interactive: true)
					}
					.buttonStyle(.plain)
					.padding(.bottom, MaskinSpace.s5)
					.transition(.opacity.combined(with: .scale(scale: 0.9)))
				}
			}
			.animation(MaskinMotion.standard, value: isAtBottom)
			.onChange(of: currentMatchID) { _, id in
				guard let id else { return }
				withAnimation(MaskinMotion.standard) { proxy.scrollTo(id, anchor: .center) }
			}
		}
	}

	private var composerBar: some View {
		VStack(spacing: MaskinSpace.s2) {
			if searching {
				ThreadSearchBar(
					text: $searchText, matchCount: matchIDs.count, index: matchIndex,
					onStep: { matchIndex = ThreadSearch.step(from: matchIndex, by: $0, count: matchIDs.count) },
					onClose: {
						searching = false
						searchText = ""
					})
			}
			composerField
		}
		.frame(maxWidth: Self.maxReadableWidth)
		.padding(.horizontal, MaskinSpace.s7)
		.padding(.bottom, MaskinSpace.s3)
		.frame(maxWidth: .infinity)
	}

	private func refreshMatches() {
		matchIDs = ThreadSearch.matches(in: store.messages, query: searchText)
		matchSet = Set(matchIDs)
		if let matchIndex, !matchIDs.indices.contains(matchIndex) {
			self.matchIndex = matchIDs.isEmpty ? nil : matchIDs.count - 1
		}
	}

	/// History present when the thread opens is never read; only what arrives afterwards.
	private func primeHandsFree() {
		guard !handsFreeTracker.isPrimed, store.phase == .loaded else { return }
		handsFreeTracker.prime(with: store.messages)
	}

	/// Reads every new agent reply, in order. Runs with hands-free off too, so the replies that
	/// arrive meanwhile are marked seen and not read the moment it is switched on.
	private func speakNewReplies() {
		let fresh = handsFreeTracker.newReplies(in: store.messages, currentActorID: store.currentActorID)
		// A quiet tap when an agent's reply lands while you're looking at the thread.
		if !fresh.isEmpty, scenePhase == .active { MaskinHaptics.play(.light) }
		guard handsFree else { return }
		for message in fresh { SpeechReader.shared.enqueue(markdown: message.content, id: message.id) }
	}

	private var composerField: some View {
		ChatComposer(
			model: composer, placeholder: "Message \(store.title)",
			suggestions: { query in
				MentionTrigger.candidates(
					query: query, participants: store.participants, workspace: store.workspaceActors,
					selfID: store.currentActorID, excluding: Set(composer.mentions.map(\.id)))
			},
			inConversation: Set(store.participants.map(\.id)), onSend: send
		)
	}

	private func send() {
		guard let (text, metadata) = composer.take() else { return }
		if store.send(text, metadata: metadata) == nil {
			// Nothing was queued: give the words back rather than lose them.
			composer.text = text
		}
	}

	private var usesGeometryTracking: Bool {
		if #available(iOS 18, macOS 15, *) { return true }
		return false
	}

	private func reachedBottom() {
		isAtBottom = true
		hasUnseen = false
	}

	private func scrollToBottom(_ proxy: ScrollViewProxy) {
		hasUnseen = false
		withAnimation(MaskinMotion.standard) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
	}

	/// Paging into the past keeps the reader's place: re-anchor to what was the oldest row.
	private func loadEarlier(_ proxy: ScrollViewProxy) {
		guard !store.isLoadingEarlier, let oldest = store.messages.first?.id else { return }
		Task {
			await store.loadEarlier()
			proxy.scrollTo(oldest, anchor: .top)
		}
	}
}

/// The messages, day separators and "working" rows, without scrolling. Split out so it renders
/// in snapshot tests (`ImageRenderer` doesn't draw scroll views). `lazy: false` swaps the lazy
/// stack for a plain one there.
struct ThreadTranscript: View {
	let store: ChatStore
	var lazy = true
	var now = Date()
	var onStop: (ChatAgentSession) -> Void = { _ in }
	var matchIDs: Set<String> = []
	var currentMatchID: String?

	var body: some View {
		if lazy {
			// Flattened into the thread's own LazyVStack: a second lazy stack nested inside it
			// mis-measures under `defaultScrollAnchor(.bottom)` (blank gaps, jumping content).
			rows
		} else {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) { rows }
		}
	}

	@ViewBuilder
	private var rows: some View {
		let answers = store.questionAnswerIndex
		let messages = store.messages
		let anchors =
			store.trace?.anchors(messages: messages, sessions: store.agentSessions) ?? ActivityAnchors()
		ForEach(ThreadLayout.items(for: messages)) { item in
			row(item, answers: answers, anchors: anchors)
		}
		TimelineView(.periodic(from: now, by: 15)) { context in
			activity(at: context.date)
		}
	}

	@ViewBuilder
	private func activity(at date: Date) -> some View {
		let live = store.liveSessions(at: date)
		if live.isEmpty {
			ForEach(store.workingAgents(at: date)) { agent in
				WorkingIndicator(agent: agent).transition(.opacity)
			}
			if let stalled = store.stalledSession() {
				ResumeBanner(agent: store.participant(for: stalled.actorID)) {
					Task { await store.resumeSession(stalled.id) }
				}
			}
		} else {
			ForEach(live) { session in
				LiveActivityView(
					agent: store.participant(for: session.actorID), fallbackActivity: session.currentActivity,
					turn: store.trace?.liveTurn(sessionID: session.id), startedAt: session.startedAt,
					// A run that has not started its container yet can't be stopped (the server 400s).
					onStop: session.status == .running ? { onStop(session) } : nil
				)
				.transition(.opacity)
			}
		}
	}

	@ViewBuilder
	private func row(
		_ item: ThreadItem, answers: [Int: [ChatQuestionAnswer.Answer]], anchors: ActivityAnchors
	) -> some View {
		switch item {
		case .daySeparator(let day):
			ThreadDivider(label: ThreadLayout.dayLabel(day, now: now))
		case .system(let message):
			ThreadDivider(label: message.content)
		case .message(let message, let showsAuthor):
			if let id = message.serverID, let turn = anchors.aboveReply[id] {
				FinishedTraceView(turn: turn)
			}
			MessageRow(
				message: message, isOwn: message.actorID == store.currentActorID, showsAuthor: showsAuthor,
				mentionNames: message.mentionIDs.compactMap { store.displayName(for: $0) },
				questionAnswers: message.serverID.flatMap { answers[$0] },
				onRetrySend: { store.retrySend(message.id) },
				onDiscard: { store.discard(message.id) },
				onRetryAgent: { Task { await store.retryAgent(for: message) } },
				onAnswer: { picks in _ = store.answer(question: message, picks: picks) }
			)
			.padding(.top, showsAuthor ? MaskinSpace.s4 : 0)
			.background(
				matchIDs.contains(message.id)
					? (message.id == currentMatchID ? MaskinColor.accentTint : MaskinColor.accentTint2) : Color.clear,
				in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous))
			if let id = message.serverID, let turn = anchors.afterTrigger[id] {
				FinishedTraceView(turn: turn)
			}
		}
	}
}

extension View {
	/// Reports whether a scroll view sits within a few points of its end. Lazy-stack sentinels
	/// fire `onAppear`/`onDisappear` unreliably, so iOS 18+ reads the real geometry; iOS 17 keeps
	/// the sentinel.
	fileprivate func trackingBottom(_ action: @escaping (Bool) -> Void) -> some View {
		if #available(iOS 18, macOS 15, *) {
			return AnyView(
				onScrollGeometryChange(for: Bool.self) { geometry in
					// The visible rect is in content coordinates, so insets (the composer bar)
					// can't skew it. Short threads show everything, which counts as the bottom.
					geometry.visibleRect.maxY >= geometry.contentSize.height - 48
				} action: { _, atBottom in
					action(atBottom)
				})
		}
		return AnyView(self)
	}
}
