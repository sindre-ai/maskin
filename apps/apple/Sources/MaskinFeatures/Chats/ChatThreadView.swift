import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
#if canImport(UIKit)
	import UIKit
#elseif canImport(AppKit)
	import AppKit
#endif

/// The thread for one conversation: history, live messages, a composer pinned above the keyboard.
/// Takes a ready `ChatStore` and `ChatComposerModel` so it previews and snapshots without a server.
struct ChatThreadView: View {
	let store: ChatStore
	let composer: ChatComposerModel
	var conversations: ConversationsStore?
	var onShowParticipants: () -> Void = {}
	var onInvite: () -> Void = {}

	@Environment(\.scenePhase) private var scenePhase
	@Environment(\.horizontalSizeClass) private var sizeClass
	@Environment(\.liveMeeting) private var liveMeeting
	/// Present in the app; absent in previews and snapshots, where `@` falls back to the thread's people.
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var isAtBottom = true
	/// Messages that arrived while the reader was scrolled up; the jump pill says how many.
	@State private var unseenCount = 0
	/// Set when the reader taps the jump button; the thread scrolls to its newest message.
	@State private var jumpRequest = 0
	/// More than 420pt above the newest message (iOS 18+ measures it): shows the jump button and
	/// stops auto-scrolling for new messages.
	@State private var isFarFromBottom = false
	/// The message whose quick replies were already used; they come back on the next question.
	@State private var quickRepliesUsedFor: String?
	/// False from opening the thread until it has settled at the newest message. The thread is
	/// drawn but hidden behind a skeleton meanwhile, so the reader never watches it hunt for its
	/// position (the first layout estimates row heights and corrects them as rows render).
	@State private var revealed = false
/// True from opening the chat until the reader first scrolls it. While true the thread pins to
	/// the newest message: a cached page that is topped up by a fresh one, or rows that settle
	/// their height late, must not leave the reader somewhere above what the agent just said.
	@State private var followingOpen = true
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
	private var failedCount: Int { store.messages.filter(\.isFailed).count }
	private var currentMatchID: String? {
		guard searching, let matchIndex, matchIDs.indices.contains(matchIndex) else { return nil }
		return matchIDs[matchIndex]
	}

	private static let bottomID = "thread-bottom"
	/// Within this distance of the newest message the thread follows new ones; further, it offers a jump.
	private static let nearBottomDistance: CGFloat = 420
	/// A search match lands about 170pt below the top.
	private static let matchAnchor = UnitPoint(x: 0.5, y: 0.2)
	/// The NEW divider lands about 150pt below the top when a chat opens on unread messages.
	private static let unreadAnchor = UnitPoint(x: 0.5, y: 0.17)
	private static let maxReadableWidth: CGFloat = 760

	var body: some View {
		observedContent
			// The grouped canvas, so agent bubbles (a `card` fill) read against it.
			.background(MaskinSurface.grouped)
			.safeAreaInset(edge: .bottom, spacing: 0) { composerBar }
			.navigationTitle(store.title)
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			// The tab bar would sit on top of the composer. iPad keeps it: the split view has room.
			.toolbar(sizeClass == .compact ? .hidden : .automatic, for: .tabBar)
			#endif
			.toolbar {
				// A centred title (the lead's name, or up to three members) with a status line under it.
				ToolbarItem(placement: .principal) { navTitle }
				// The menu first, then Live (when an agent is in the chat) at the far right, in one
				// group so they share a capsule and iOS keeps both in the bar instead of a "More" overflow.
				ToolbarItemGroup(placement: .primaryAction) {
					if isGroup {
						Button(action: onShowParticipants) {
							NavAvatarStack(participants: store.participants, selfID: store.currentActorID)
						}
						.buttonStyle(.plain)
						.accessibilityLabel("People in this chat")
					}
					Menu {
						if let conversations, let row = conversations.conversation(id: store.conversationID) {
							Button {
								Task { await conversations.setPinned(row.id, !row.pinned) }
							} label: {
								Label(row.pinned ? "Unpin" : "Pin to top", systemImage: row.pinned ? "pin.slash" : "pin")
							}
						}
						Button(action: onInvite) { Label("Invite people", systemImage: "person.badge.plus") }
						if let link = chatLink {
							Button {
								Self.copy(link.absoluteString)
								MaskinHaptics.play(.success)
							} label: {
								Label("Copy link", systemImage: "link")
							}
						}
						Button(action: onShowParticipants) { Label("People", systemImage: "person.2") }
						Button {
							searching.toggle()
							if !searching { searchText = "" }
						} label: {
							Label("Search in chat", systemImage: "magnifyingglass")
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
								Label(row.archived ? "Unarchive chat" : "Archive chat", systemImage: "archivebox")
							}
						}
					} label: {
						Label("Chat options", systemImage: "ellipsis")
							.foregroundStyle(MaskinColor.ink)
					}
					if let lead = liveLead {
						Button {
							liveMeeting.present(.thread(chat: store, lead: lead))
						} label: {
							ShellInkCircle(symbol: "waveform", label: "Live")
						}
						.buttonStyle(.plain)
					}
				}
			}
			.task { await runtime?.mentionRoster()?.load() }
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
	}

	/// The web link to this conversation, for Copy link.
	private var chatLink: URL? {
		guard let workspaceID = runtime?.environment.workspaceId else { return nil }
		return DeepLink.chat(workspaceId: workspaceID, id: store.conversationID).universalURL()
	}

	private static func copy(_ text: String) {
		#if canImport(UIKit) && !os(tvOS) && !os(watchOS)
			UIPasteboard.general.string = text
		#elseif canImport(AppKit) && os(macOS)
			NSPasteboard.general.clearContents()
			NSPasteboard.general.setString(text, forType: .string)
		#endif
	}

	/// The other party of a direct chat; nil for a group, which has its own header pill.
	private var counterpart: ChatParticipant? {
		let others = store.participants.filter { $0.id != store.currentActorID }
		return others.count == 1 ? others.first : nil
	}

	private var isGroup: Bool { store.participants.filter { $0.id != store.currentActorID }.count > 1 }

	/// The nav bar's name: the people you are talking to, up to three; the topic when it is just you.
	private var navName: String {
		let others = store.participants.filter { $0.id != store.currentActorID }
		guard !others.isEmpty else { return store.title }
		let names = others.prefix(3).map(\.name).joined(separator: ", ")
		return others.count > 3 ? names + " +\(others.count - 3)" : names
	}

	/// What the agents are doing: working on a task (equalizer bars), or composing a reply. Nothing
	/// otherwise: a direct chat has no label.
	private var navStatus: (text: String, working: Bool)? {
		if store.liveSessions().contains(where: { $0.status == .running }) { return ("working", true) }
		if !store.workingAgents().isEmpty { return (isGroup ? "replying…" : "typing…", false) }
		return nil
	}

	@ViewBuilder
	private var navTitle: some View {
		if let agent = counterpartAgent, let runtime {
			Button { runtime.openAgent(agent.id) } label: { navTitleLabel }
				.buttonStyle(.plain)
				.accessibilityHint("Opens \(agent.name)'s profile")
		} else {
			navTitleLabel
		}
	}

	/// The other side of a direct chat, when it is an agent: tapping the title opens its profile.
	private var counterpartAgent: ChatParticipant? {
		let others = store.participants.filter { $0.id != store.currentActorID }
		return others.count == 1 && others[0].kind == .agent ? others[0] : nil
	}

	private var navTitleLabel: some View {
		VStack(spacing: 0) {
			Text(navName)
				.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: MaskinFontWeight.bold))
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
			if let status = navStatus {
				HStack(spacing: MaskinSpace.s2) {
					if status.working { WorkingBars().scaleEffect(0.6).frame(width: MaskinSpace.s8, height: MaskinSpace.s7) }
					Text(status.text).maskinText(.caption).foregroundStyle(MaskinColor.sigInk)
				}
				.transition(.opacity)
			}
		}
		.animation(MaskinMotion.quick, value: navStatus?.text)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}

	/// The topic as a 24pt heading at the top of the scrolling content, so it scrolls away while the
	/// name stays in the nav bar.
	private var titleView: some View {
		Text(store.title)
			.font(MaskinTypeface.threadTitle)
			.foregroundStyle(MaskinColor.ink)
			.lineLimit(2)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.bottom, MaskinSpace.s3)
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
			// A message that could not be sent is worth a buzz: it is easy to miss otherwise.
			.onChange(of: failedCount) { old, new in
				if new > old { MaskinHaptics.play(.error) }
			}
	}

	@ViewBuilder
	private var content: some View {
		switch store.phase {
		case .idle, .loading:
			// A skeleton only if loading takes longer than 300ms; before that the card stays blank.
			ThreadDelayedSkeleton()
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't open this chat", message: message) {
				Button("Try again") { Task { await store.load() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			if store.messages.isEmpty {
				Text(emptyHint)
					.maskinText(.body).foregroundStyle(MaskinColor.ink4)
					.multilineTextAlignment(.center)
					.padding(.horizontal, MaskinSpace.s13 + MaskinSpace.s9)
					.frame(maxWidth: .infinity, maxHeight: .infinity)
			} else {
				VStack(spacing: 0) {
					if let problem = store.syncProblem {
						StaleThreadBanner(problem: problem) { Task { await store.refresh() } }
							.padding(.horizontal, MaskinSpace.s9)
							.padding(.top, MaskinSpace.s3)
					}
					// An overlay, not a sibling row: appearing and disappearing must not resize the
					// scroll view, which would re-run the bottom anchor each time.
					thread
						.overlay(alignment: .bottom) {
							if store.isCatchingUp {
								MonoLabel("Loading new messages…")
									.padding(.vertical, MaskinSpace.s3)
									.padding(.horizontal, MaskinSpace.s7)
									.background(MaskinSurface.card.opacity(0.92), in: Capsule())
									.padding(.bottom, MaskinSpace.s3)
									.allowsHitTesting(false)
									.transition(.opacity)
							}
						}
				}
				.animation(MaskinMotion.standard, value: store.syncProblem)
				.animation(MaskinMotion.standard, value: store.isCatchingUp)
			}
		}
	}

	/// "Ask Forge anything. Type @ to bring someone else in, or + to attach a file."
	private var emptyHint: String {
		let name = store.participants.first { $0.id != store.currentActorID }?.name ?? store.title
		return "Ask \(name) anything. Type @ to bring someone else in, or + to attach a file."
	}

	/// The thread's rows. Short threads in a plain stack (see `ThreadRendering`; its day headers
	/// scroll with the text, only a lazy stack can pin them), long ones in a lazy stack that pins them.
	@ViewBuilder
	private func threadRows(_ proxy: ScrollViewProxy) -> some View {
		if ThreadRendering.usesLazyStack(rowCount: store.messages.count) {
			LazyVStack(alignment: .leading, spacing: MaskinSpace.s9, pinnedViews: [.sectionHeaders]) {
				threadContent(proxy, lazy: true)
			}
		} else {
			VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				threadContent(proxy, lazy: false)
			}
		}
	}

	@ViewBuilder
	private func threadContent(_ proxy: ScrollViewProxy, lazy: Bool) -> some View {
		if store.hasEarlier {
			ProgressView()
				.frame(maxWidth: .infinity)
				// Only once the reader has scrolled: while the thread is still settling at the
				// bottom this spinner can flash into view, and loading history then ends with
				// a jump to the old boundary, leaving the newest messages below the fold.
				.onAppear { if !followingOpen { loadEarlier(proxy) } }
		}
		if !store.hasEarlier { titleView }
		ThreadTranscript(
			store: store, lazy: lazy,
			onEdit: { message in
				composer.beginEdit(messageID: message.id, text: message.content)
			},
			onQuote: { composer.beginReply(author: $0.actorName, content: $0.content) }, matchIDs: matchSet,
			currentMatchID: currentMatchID)
		Color.clear.frame(height: 1).id(Self.bottomID)
			.onAppear { if !usesGeometryTracking { reachedBottom() } }
			.onDisappear { if !usesGeometryTracking { isAtBottom = false } }
	}

	private var thread: some View {
		ScrollViewReader { proxy in
			ScrollView {
				threadRows(proxy)
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.top, MaskinSpace.s5)
				.padding(.bottom, MaskinSpace.s7)
				// Readable measure on iPad and Mac; full width on iPhone.
				.frame(maxWidth: Self.maxReadableWidth)
				.frame(maxWidth: .infinity)
			}
			.defaultScrollAnchor(.bottom)
			.opacity(revealed ? 1 : 0)
			.overlay {
				if !revealed { ThreadSkeleton().allowsHitTesting(false).transition(.opacity) }
			}
			.animation(.easeOut(duration: 0.18), value: revealed)
			.onAppear { settleOpen(proxy) }
			.onUserScroll {
				followingOpen = false
				revealed = true
			}
			.trackingBottom { atBottom in
				if atBottom { reachedBottom() } else { isAtBottom = false }
			}
			.trackingBottom(within: Self.nearBottomDistance) { near in isFarFromBottom = !near }
			.onChange(of: jumpRequest) { _, _ in scrollToBottom(proxy) }
			.refreshable { await store.refresh() }
			.scrollDismissesKeyboard(.interactively)
			.onChange(of: store.messages.last?.id) { _, _ in
				// Follow new messages only while the reader is at the bottom (or just sent one);
				// otherwise leave them where they are and offer a jump.
				switch ThreadScrollPolicy.onNewestChanged(
					followingOpen: followingOpen, isAtBottom: isNearBottom,
					newestIsMine: store.messages.last?.actorID == store.currentActorID)
				{
				case .jump: jumpToBottom(proxy)
				case .follow: scrollToBottom(proxy)
				case .countUnseen: unseenCount += 1
				}
			}
			.onChange(of: currentMatchID) { _, id in
				guard let id else { return }
				withAnimation(MaskinMotion.standard) { proxy.scrollTo(id, anchor: Self.matchAnchor) }
			}
		}
	}

	/// Newer messages are within reach: new ones are followed. Before iOS 18 only "at the bottom" is known.
	private var isNearBottom: Bool { usesGeometryTracking ? !isFarFromBottom : isAtBottom }

	private var quickReplies: [String] {
		let last = store.messages.last { !$0.isSystem }
		guard last?.id != quickRepliesUsedFor else { return [] }
		return QuickReplies.options(
			after: last, currentActorID: store.currentActorID,
			composerIsEmpty: !composer.hasContent, someoneIsTyping: !store.workingAgents().isEmpty)
	}

	/// The jump button, quick replies, search and composer, stacked so the first two ride up as the
	/// composer grows (7-Chat §4).
	private var composerBar: some View {
		VStack(alignment: .trailing, spacing: MaskinSpace.s4) {
			if !isNearBottom {
				JumpToLatestButton(unseen: unseenCount) { jumpRequest += 1 }
					.transition(.opacity.combined(with: .scale(scale: 0.9)))
			}
			if !searching, !quickReplies.isEmpty {
				QuickReplyChips(options: quickReplies) { reply in
					quickRepliesUsedFor = store.messages.last { !$0.isSystem }?.id
					if store.send(reply) != nil { MaskinHaptics.play(.light) }
				}
				.transition(.opacity)
			}
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
		.animation(MaskinMotion.quick, value: isNearBottom)
		.animation(MaskinMotion.quick, value: quickReplies)
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

	/// Who a live call from this thread is with: its first agent. Nil (no Live button) without one.
	private var liveLead: ChatParticipant? { store.participants.first { $0.kind == .agent } }

	private var composerField: some View {
		ChatComposer(
			model: composer, placeholder: placeholder,
			suggestions: { query in
				MentionTrigger.candidates(
					query: query, participants: store.participants, workspace: store.workspaceActors,
					selfID: store.currentActorID, excluding: Set(composer.mentions.map(\.id)))
			},
			inConversation: Set(store.participants.map(\.id)), onSend: send,
			agentName: store.participants.first { $0.kind == .agent }?.name ?? "Agent",
			replies: Array(store.messages.suffix(12)),
			roster: runtime?.mentionRoster()?.roster,
			isBusy: runningSessions.isEmpty == false, onStop: stopRunning
		)
	}

	/// "Message Forge": who is on the other side. "Type your answer…" while a flow waits on you.
	private var placeholder: String {
		if let ask = store.messages.last(where: { !$0.questions.isEmpty }), ask.actorID != store.currentActorID,
			let id = ask.serverID, !store.answeredQuestionIDs.contains(id)
		{
			return ComposerPlaceholder.answering
		}
		return ComposerPlaceholder.message(to: store.participants, selfID: store.currentActorID)
	}

	/// Sessions the composer's Stop can end: a run that has not started its container can't be
	/// stopped (the server 400s), so it keeps the mic.
	private var runningSessions: [ChatAgentSession] {
		store.liveSessions().filter { $0.status == .running }
	}

	private func stopRunning() {
		let ids = runningSessions.map(\.id)
		Task { for id in ids { await store.stopSession(id) } }
	}

	private func send() {
		if let edit = composer.takeEdit() {
			MaskinHaptics.play(.light)
			Task { await store.edit(edit.messageID, to: edit.text) }
			return
		}
		guard let (text, metadata) = composer.take() else { return }
		if store.send(text, metadata: metadata) == nil {
			// Nothing was queued: give the words back rather than lose them.
			composer.text = text
		} else {
			MaskinHaptics.play(.light)
		}
	}

	private var usesGeometryTracking: Bool {
		if #available(iOS 18, macOS 15, *) { return true }
		return false
	}

	private func reachedBottom() {
		isAtBottom = true
		unseenCount = 0
	}

	/// Pin to the newest message, again after the rows have measured, then show the thread.
	private func settleOpen(_ proxy: ScrollViewProxy) {
		jumpToBottom(proxy)
		Task {
			try? await Task.sleep(for: .milliseconds(320))
			if followingOpen {
				// Unread messages: open with the NEW divider about 150pt below the top instead.
				if hasUnreadDivider {
					followingOpen = false
					proxy.scrollTo("unread-divider", anchor: Self.unreadAnchor)
				} else {
					proxy.scrollTo(Self.bottomID, anchor: .bottom)
				}
			}
			revealed = true
		}
	}

	/// The thread opened with messages the reader had not seen (the divider is captured on open,
	/// before they are marked read).
	private var hasUnreadDivider: Bool {
		ThreadLayout.items(
			for: store.messages, unreadAfter: store.openedReadCursor, currentActorID: store.currentActorID
		).contains { if case .unreadDivider = $0 { return true } else { return false } }
	}

	/// Pin to the newest message without animating, then once more after the rows have measured.
	private func jumpToBottom(_ proxy: ScrollViewProxy) {
		unseenCount = 0
		proxy.scrollTo(Self.bottomID, anchor: .bottom)
		Task {
			try? await Task.sleep(for: .milliseconds(200))
			if followingOpen { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
		}
	}

	private func scrollToBottom(_ proxy: ScrollViewProxy) {
		unseenCount = 0
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
	var onEdit: (ChatMessage) -> Void = { _ in }
	var onQuote: (ChatMessage) -> Void = { _ in }
	var matchIDs: Set<String> = []
	var currentMatchID: String?

	var body: some View {
		if lazy {
			// Flattened into the thread's own LazyVStack: a second lazy stack nested inside it
			// mis-measures under `defaultScrollAnchor(.bottom)` (blank gaps, jumping content).
			rows
		} else {
			VStack(alignment: .leading, spacing: MaskinSpace.s9) { rows }
		}
	}

	@ViewBuilder
	private var rows: some View {
		let answers = store.questionAnswerIndex
		let messages = store.messages
		let anchors =
			store.trace?.anchors(messages: messages, sessions: store.agentSessions) ?? ActivityAnchors()
		let items = ThreadLayout.items(
			for: messages, unreadAfter: store.openedReadCursor, currentActorID: store.currentActorID)
		let sections = ThreadLayout.sections(for: items)
		let runs = ThreadLayout.runs(in: items)
		let latestOwnID = OutgoingStatus.latestOwnID(in: messages, currentActorID: store.currentActorID)
		let byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
		// One section per day: its header stays pinned at the top while that day scrolls by (the thread's
		// LazyVStack asks for pinned section headers).
		ForEach(sections) { section in
			Section {
				ForEach(section.items) { item in
					row(item, answers: answers, anchors: anchors, runs: runs, byID: byID, latestOwnID: latestOwnID)
				}
			} header: {
				if let day = section.day { DayHeader(label: ThreadLayout.dayLabel(day, now: now)) }
			}
		}
		TimelineView(.periodic(from: now, by: 15)) { context in
			activity(at: context.date)
		}
	}

	/// Extra space above a message. A new author's run gets a little air; a message that
	/// continues its run is pulled closer than the stack's normal gap, unless an activity trace
	/// sits between the two (then it keeps the stack's spacing around the trace).
	private static func topPadding(
		for message: ChatMessage, showsAuthor: Bool, run: ThreadLayout.Run, anchors: ActivityAnchors,
		byID: [String: ChatMessage]
	) -> CGFloat {
		if showsAuthor { return 0 }
		guard let previous = run.previousID.flatMap({ byID[$0] }) else { return 0 }
		let traceAbove = message.serverID.flatMap { anchors.aboveReply[$0] } != nil
		let traceBetween = previous.serverID.flatMap { anchors.afterTrigger[$0] } != nil
		return traceAbove || traceBetween ? 0 : -MaskinSpace.s6
	}

	@ViewBuilder
	private func activity(at date: Date) -> some View {
		let live = store.liveSessions(at: date)
		if live.isEmpty {
			ForEach(store.workingAgents(at: date)) { agent in
				TypingBubble(agent: agent).transition(.opacity)
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
					turn: store.trace?.liveTurn(sessionID: session.id), startedAt: session.startedAt
				)
				.transition(.opacity)
			}
		}
	}

	/// The status line sits under your latest message; an earlier one only speaks up if it never went
	/// through.
	private func outgoingStatus(of message: ChatMessage, latestOwnID: String?) -> OutgoingStatus? {
		guard message.actorID == store.currentActorID, message.kind == "message" else { return nil }
		let state = OutgoingStatus.state(of: message.id, in: store.messages, currentActorID: store.currentActorID)
		if message.id == latestOwnID { return state }
		switch state {
		case .sending?, .queued?, .failed?: return state
		default: return nil
		}
	}

	@ViewBuilder
	private func row(
		_ item: ThreadItem, answers: [Int: [ChatQuestionAnswer.Answer]], anchors: ActivityAnchors,
		runs: [String: ThreadLayout.Run], byID: [String: ChatMessage], latestOwnID: String?
	) -> some View {
		switch item {
		case .daySeparator(let day):
			ThreadDivider(label: ThreadLayout.dayLabel(day, now: now).uppercased(), mono: true)
		case .system(let message):
			ThreadDivider(label: message.content, ruled: false)
		case .unreadDivider(let count):
			ThreadDivider(label: "NEW", tint: MaskinColor.sigInk, ruleTint: MaskinColor.sigHi, mono: true)
				.accessibilityLabel(count == 1 ? "1 new message" : "\(count) new messages")
		case .handoff(let session, let behind):
			HandoffRow(session: session, behind: behind)
		case .message(let message, let showsAuthor):
			let run = runs[message.id] ?? ThreadLayout.Run()
			if let id = message.serverID, let turn = anchors.aboveReply[id] {
				FinishedTraceView(turn: turn)
			}
			MessageRow(
				message: message, isOwn: message.actorID == store.currentActorID, showsAuthor: showsAuthor,
				mentionNames: message.mentionIDs.compactMap { store.displayName(for: $0) },
				mentions: message.mentionIDs.compactMap { id in
					store.displayName(for: id).map { (id: id, name: $0) }
				},
				questionAnswers: message.serverID.flatMap { answers[$0] },
				outgoing: outgoingStatus(of: message, latestOwnID: latestOwnID),
				onRetrySend: { store.retrySend(message.id) },
				onDiscard: { store.discard(message.id) },
				onRetryAgent: { Task { await store.retryAgent(for: message) } },
				// Edit is for your latest message only; it re-opens in the composer.
				onEdit: message.id == latestOwnID && message.canEdit(by: store.currentActorID) ? { onEdit(message) } : nil,
				onQuote: message.content.isEmpty ? nil : { onQuote(message) },
				onAnswer: { picks in _ = store.answer(question: message, picks: picks) }
			)
			.swipeToReply(message.content.isEmpty || message.isFailed ? nil : { onQuote(message) })
			.padding(.top, Self.topPadding(for: message, showsAuthor: showsAuthor, run: run, anchors: anchors, byID: byID))
			// Search: every match gets a 2pt ring, the current one a 2.5pt signal ring.
			.overlay {
				if matchIDs.contains(message.id) {
					let current = message.id == currentMatchID
					RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous)
						.strokeBorder(current ? MaskinColor.sig : MaskinColor.sigHi, lineWidth: current ? 2.5 : 2)
						.padding(-MaskinSpace.s1)
						.allowsHitTesting(false)
				}
			}
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
	fileprivate func trackingBottom(within distance: CGFloat = 48, _ action: @escaping (Bool) -> Void) -> some View {
		if #available(iOS 18, macOS 15, *) {
			return AnyView(
				onScrollGeometryChange(for: Bool.self) { geometry in
					// The visible rect is in content coordinates, so insets (the composer bar)
					// can't skew it. Short threads show everything, which counts as the bottom.
					geometry.visibleRect.maxY >= geometry.contentSize.height - distance
				} action: { _, atBottom in
					action(atBottom)
				})
		}
		return AnyView(self)
	}
}

/// The newest messages could not be loaded, so the thread may be missing the latest ones. Says
/// why, and offers a retry, instead of leaving an older view looking complete.
struct StaleThreadBanner: View {
	let problem: String
	let onRetry: () -> Void

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s5) {
			Image(systemName: "arrow.triangle.2.circlepath").accessibilityHidden(true)
			VStack(alignment: .leading, spacing: 0) {
				Text("Latest messages didn't load").maskinText(.subhead).fontWeight(.semibold)
				Text(problem).maskinText(.caption).lineLimit(2)
			}
			Spacer(minLength: 0)
			Button(action: onRetry) {
				Text("Retry").maskinText(.subhead).fontWeight(.semibold)
					.padding(.horizontal, MaskinSpace.s5)
					.frame(minHeight: MaskinSpace.touchMin)
					.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
		}
		.foregroundStyle(MaskinColor.noticeFg)
		.padding(.leading, MaskinSpace.s8)
		.padding(.trailing, MaskinSpace.s3)
		.background(MaskinColor.noticeBg, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
				.strokeBorder(MaskinColor.noticeBd, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
}

/// Stands in for the thread while it loads or settles: the shape of a conversation (their messages
/// as wide cards on the left, yours as short ones on the right), bottom-aligned because a thread
/// opens at its newest message. Built on `SkeletonBlock`, whose faint fill only reads on a card.
struct ThreadSkeleton: View {
	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			theirs([1, 0.85, 0.5])
			mine(width: 150)
			theirs([1, 0.92, 0.78, 0.35])
			mine(width: 210)
			theirs([0.95, 0.6])
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.bottom, MaskinSpace.s9)
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
		.background(MaskinSurface.card)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Loading messages")
	}

	private var bubble: RoundedRectangle {
		RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
	}

	/// A card of text lines; each is the given fraction of the card's width.
	private func theirs(_ fractions: [CGFloat]) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			ForEach(Array(fractions.enumerated()), id: \.offset) { _, fraction in
				GeometryReader { geometry in
					SkeletonBlock(height: MaskinSpace.s7, cornerRadius: MaskinRadius.tag2)
						.frame(width: geometry.size.width * fraction)
				}
				.frame(height: MaskinSpace.s7)
			}
		}
		.padding(MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.cardInset2, in: bubble)
	}

	private func mine(width: CGFloat) -> some View {
		SkeletonBlock(height: MaskinSpace.s7, cornerRadius: MaskinRadius.tag2)
			.frame(width: width)
			.padding(MaskinSpace.s7)
			.background(MaskinSurface.cardInset2, in: bubble)
			.frame(maxWidth: .infinity, alignment: .trailing)
	}
}

/// A day's header, pinned while the day scrolls by: the day in mono between two rules.
struct DayHeader: View {
	let label: String

	var body: some View {
		ThreadDivider(label: label.uppercased(), mono: true)
			.background(MaskinSurface.card)
	}
}

/// The floating "jump to latest" button: a 44pt glass circle with a down arrow, and a badge with
/// the number of messages that arrived since the reader scrolled away.
struct JumpToLatestButton: View {
	let unseen: Int
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			Image(systemName: "arrow.down")
				.maskinSymbol(MaskinFontSize.t16, weight: .semibold)
				.foregroundStyle(MaskinColor.ink)
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
				.maskinGlass(in: Circle(), interactive: true)
				.overlay(alignment: .topTrailing) {
					if unseen > 0 {
						Text(unseen > 99 ? "99+" : "\(unseen)")
							.maskinText(.caption).fontWeight(.bold)
							.foregroundStyle(MaskinColor.badgeFg)
							.padding(.horizontal, MaskinSpace.s2)
							.frame(minWidth: MaskinSpace.s11, minHeight: MaskinSpace.s11)
							.background(MaskinGradient.badge, in: Capsule())
							.offset(x: MaskinSpace.s2, y: -MaskinSpace.s2)
					}
				}
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(unseen > 0 ? "Jump to latest, \(unseen) new" : "Jump to latest")
	}
}

/// Smart replies above the composer, right-aligned: 40pt pills that send on tap.
struct QuickReplyChips: View {
	let options: [String]
	let onPick: (String) -> Void

	var body: some View {
		ChipFlow(spacing: MaskinSpace.s4) {
			ForEach(options, id: \.self) { option in
				Button {
					onPick(option)
				} label: {
					Text(option)
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink)
						.padding(.horizontal, MaskinSpace.s9)
						.frame(minHeight: ComposerToolLabel.size)
						.background(MaskinSurface.card, in: Capsule())
						.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
						.contentShape(Capsule())
				}
				.buttonStyle(.maskinPressed(.shrink))
			}
		}
		.frame(maxWidth: .infinity, alignment: .trailing)
		.accessibilityElement(children: .contain)
	}
}

/// The thread skeleton, drawn only once loading has taken more than 300ms (7-Chat §2).
struct ThreadDelayedSkeleton: View {
	@State private var visible = false

	var body: some View {
		ZStack {
			MaskinSurface.grouped
			if visible { ThreadSkeleton().transition(.opacity) }
		}
		.task {
			try? await Task.sleep(for: .milliseconds(300))
			withAnimation(MaskinMotion.fade) { visible = true }
		}
	}
}

extension View {
	/// Runs `action` when the reader starts scrolling. Observes the scroll phase on iOS 18+ so no
	/// gesture competes with the scroll view's own pan; earlier systems fall back to a passive drag.
	@ViewBuilder
	fileprivate func onUserScroll(_ action: @escaping () -> Void) -> some View {
		if #available(iOS 18.0, macOS 15.0, *) {
			onScrollPhaseChange { _, phase in if phase == .interacting { action() } }
		} else {
			simultaneousGesture(DragGesture(minimumDistance: MaskinSpace.s4).onChanged { _ in action() })
		}
	}
}
