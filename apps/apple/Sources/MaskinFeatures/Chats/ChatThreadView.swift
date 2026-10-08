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
	@State private var editing: ChatMessage?
	/// False from opening the thread until it has settled at the newest message. The thread is
	/// drawn but hidden behind a skeleton meanwhile, so the reader never watches it hunt for its
	/// position (the first layout estimates row heights and corrects them as rows render).
	@State private var revealed = false
/// True from opening the chat until the reader first scrolls it. While true the thread pins to
	/// the newest message: a cached page that is topped up by a fresh one, or rows that settle
	/// their height late, must not leave the reader somewhere above what the agent just said.
	@State private var followingOpen = true
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
	private var failedCount: Int { store.messages.filter(\.isFailed).count }
	private var currentMatchID: String? {
		guard searching, let matchIndex, matchIDs.indices.contains(matchIndex) else { return nil }
		return matchIDs[matchIndex]
	}

	private static let bottomID = "thread-bottom"
	private static let maxReadableWidth: CGFloat = 760

	var body: some View {
		observedContent
			.background(MaskinSurface.card)
			.safeAreaInset(edge: .bottom, spacing: 0) { composerBar }
			.navigationTitle(store.title)
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			// The tab bar would sit on top of the composer. iPad keeps it: the split view has room.
			.toolbar(sizeClass == .compact ? .hidden : .automatic, for: .tabBar)
			#endif
			.toolbar {
				ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1).accessibilityHidden(true) }
				// Live (when an agent is in the chat) and a flat menu, in one group so iOS keeps both in
				// the bar instead of folding them into a "More" overflow.
				ToolbarItemGroup(placement: .primaryAction) {
					if let lead = liveLead {
						Button {
							liveMeeting.present(.thread(chat: store, lead: lead))
						} label: {
							Label("Live", systemImage: "waveform")
						}
						.shellLiveButton()
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
			.confirmationDialog(
				"Stop this agent?", isPresented: Binding(get: { stopTarget != nil }, set: { if !$0 { stopTarget = nil } }),
				titleVisibility: .visible, presenting: stopTarget
			) { session in
				Button("Stop", role: .destructive) { Task { await store.stopSession(session.id) } }
			} message: { _ in
				Text("It will stop what it's doing. You can ask it to continue afterwards.")
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

	/// "WITH IDA" in mono above the title. An agent's opens its page; a person has no page to
	/// open yet. (A "THREAD IN {FLOW}" link needs a flow on the conversation, which the API lacks.)
	@ViewBuilder
	private var contextLink: some View {
		if let counterpart {
			if counterpart.kind == .agent, let runtime {
				Button {
					runtime.openAgent(counterpart.id)
				} label: {
					MonoLabel("With \(counterpart.name)", color: MaskinColor.sigInk)
				}
				.buttonStyle(.maskinPressed)
				.accessibilityLabel("With \(counterpart.name), open agent")
			} else {
				MonoLabel("With \(counterpart.name)")
			}
		}
	}

	/// The large title: a mono context link over the conversation's name. The back button and ···
	/// menu stay in the bar; the agent's page opens from the avatar or name on its messages.
	private var titleView: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			contextLink
			Text(store.title)
				.font(MaskinTypeface.threadTitle)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(2)
				.accessibilityAddTraits(.isHeader)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.top, MaskinSpace.s3)
	}

	/// The thread plus the observers for search and hands-free speech (kept apart so `body`
	/// type-checks quickly).
	private var observedContent: some View {
		VStack(spacing: 0) {
			titleView
			content
		}
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
			.sheet(item: $editing) { message in
				EditMessageSheet(original: message.content) { text in
					Task { await store.edit(message.id, to: text) }
				}
			}
	}

	@ViewBuilder
	private var content: some View {
		switch store.phase {
		case .idle, .loading:
			ThreadSkeleton()
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
				VStack(spacing: 0) {
					if store.participants.filter({ $0.id != store.currentActorID }).count > 1 {
						GroupHeaderPill(
							participants: store.participants, selfID: store.currentActorID, action: onShowParticipants
						)
						.padding(.top, MaskinSpace.s3)
						.padding(.horizontal, MaskinSpace.s9)
						.frame(maxWidth: .infinity, alignment: .leading)
					}
					if let problem = store.syncProblem {
						StaleThreadBanner(problem: problem) { Task { await store.refresh() } }
							.padding(.horizontal, MaskinSpace.s9)
							.padding(.top, MaskinSpace.s3)
					}
					thread
				}
				.animation(MaskinMotion.standard, value: store.syncProblem)
			}
		}
	}

	private var thread: some View {
		ScrollViewReader { proxy in
			ScrollView {
				LazyVStack(alignment: .leading, spacing: MaskinSpace.s5, pinnedViews: [.sectionHeaders]) {
					if store.hasEarlier {
						ProgressView()
							.frame(maxWidth: .infinity)
							// Only once the reader has scrolled: while the thread is still settling at the
							// bottom this spinner can flash into view, and loading history then ends with
							// a jump to the old boundary, leaving the newest messages below the fold.
							.onAppear { if !followingOpen { loadEarlier(proxy) } }
					}
					ThreadTranscript(
						store: store, onStop: { stopTarget = $0 }, onEdit: { editing = $0 },
						onQuote: { composer.quote(author: $0.actorName, content: $0.content) }, matchIDs: matchSet,
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
			.opacity(revealed ? 1 : 0)
			.overlay {
				if !revealed { ThreadSkeleton().allowsHitTesting(false).transition(.opacity) }
			}
			.animation(.easeOut(duration: 0.18), value: revealed)
			.onAppear { settleOpen(proxy) }
			.simultaneousGesture(
				DragGesture(minimumDistance: MaskinSpace.s4).onChanged { _ in
					followingOpen = false
					revealed = true
				})
			.trackingBottom { atBottom in
				if atBottom { reachedBottom() } else { isAtBottom = false }
			}
			.refreshable { await store.refresh() }
			.scrollDismissesKeyboard(.interactively)
			.onChange(of: store.messages.last?.id) { _, _ in
				// Follow new messages only while the reader is at the bottom (or just sent one);
				// otherwise leave them where they are and offer a jump.
				if followingOpen {
					jumpToBottom(proxy)
				} else if isAtBottom || store.messages.last?.actorID == store.currentActorID {
					scrollToBottom(proxy)
				} else {
					unseenCount += 1
				}
			}
			.overlay(alignment: .bottom) {
				if !isAtBottom {
					Button {
						scrollToBottom(proxy)
					} label: {
						Label(Self.pillTitle(unseen: unseenCount), systemImage: "arrow.down")
							.maskinText(.subhead)
							.padding(.horizontal, MaskinSpace.s8)
							.padding(.vertical, MaskinSpace.s4)
							.foregroundStyle(MaskinColor.ink)
							.maskinGlassCapsule(interactive: true)
					}
					.buttonStyle(.maskinPressed(.shrink))
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

	/// Who a live call from this thread is with: its first agent. Nil (no Live button) without one.
	private var liveLead: ChatParticipant? { store.participants.first { $0.kind == .agent } }

	private var composerField: some View {
		ChatComposer(
			model: composer, placeholder: "Message \(store.title)",
			suggestions: { query in
				MentionTrigger.candidates(
					query: query, participants: store.participants, workspace: store.workspaceActors,
					selfID: store.currentActorID, excluding: Set(composer.mentions.map(\.id)))
			},
			inConversation: Set(store.participants.map(\.id)), onSend: send,
			agentName: store.participants.first { $0.kind == .agent }?.name ?? "Agent",
			replies: Array(store.messages.suffix(12)),
			roster: runtime?.mentionRoster()?.roster
		)
	}

	private func send() {
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

	static func pillTitle(unseen: Int) -> String {
		switch unseen {
		case 0: "Latest"
		case 1: "1 new message"
		default: "\(unseen) new messages"
		}
	}

	/// Pin to the newest message, again after the rows have measured, then show the thread.
	private func settleOpen(_ proxy: ScrollViewProxy) {
		jumpToBottom(proxy)
		Task {
			try? await Task.sleep(for: .milliseconds(320))
			if followingOpen { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
			revealed = true
		}
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
	var onStop: (ChatAgentSession) -> Void = { _ in }
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
			VStack(alignment: .leading, spacing: MaskinSpace.s5) { rows }
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
		let byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
		// One section per day: its header stays pinned at the top while that day scrolls by (the thread's
		// LazyVStack asks for pinned section headers).
		ForEach(sections) { section in
			Section {
				ForEach(section.items) { item in
					row(item, answers: answers, anchors: anchors, runs: runs, byID: byID)
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
		if showsAuthor { return MaskinSpace.s4 }
		guard let previous = run.previousID.flatMap({ byID[$0] }) else { return 0 }
		let traceAbove = message.serverID.flatMap { anchors.aboveReply[$0] } != nil
		let traceBetween = previous.serverID.flatMap { anchors.afterTrigger[$0] } != nil
		return traceAbove || traceBetween ? 0 : -(MaskinSpace.s5 - MaskinSpace.s2)
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
		_ item: ThreadItem, answers: [Int: [ChatQuestionAnswer.Answer]], anchors: ActivityAnchors,
		runs: [String: ThreadLayout.Run], byID: [String: ChatMessage]
	) -> some View {
		switch item {
		case .daySeparator(let day):
			ThreadDivider(label: ThreadLayout.dayLabel(day, now: now))
		case .system(let message):
			ThreadDivider(label: message.content, ruled: false)
		case .unreadDivider(let count):
			ThreadDivider(
				label: count == 1 ? "1 new message" : "\(count) new messages", tint: MaskinColor.sigInk)
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
				onRetrySend: { store.retrySend(message.id) },
				onDiscard: { store.discard(message.id) },
				onRetryAgent: { Task { await store.retryAgent(for: message) } },
				onEdit: message.canEdit(by: store.currentActorID) ? { onEdit(message) } : nil,
				onQuote: message.content.isEmpty ? nil : { onQuote(message) },
				onAnswer: { picks in _ = store.answer(question: message, picks: picks) }
			)
			.padding(.top, Self.topPadding(for: message, showsAuthor: showsAuthor, run: run, anchors: anchors, byID: byID))
			.background(
				matchIDs.contains(message.id)
					? (message.id == currentMatchID ? MaskinSurface.fillStrong : MaskinSurface.fill) : Color.clear,
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

/// A day's header: a small pill, centred, that stays at the top while the day's messages scroll.
struct DayHeader: View {
	let label: String

	var body: some View {
		Text(label)
			.maskinText(.caption).fontWeight(.semibold)
			.foregroundStyle(MaskinColor.ink3)
			.padding(.horizontal, MaskinSpace.s7)
			.padding(.vertical, MaskinSpace.s3)
			.background(MaskinSurface.card, in: Capsule())
			.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
			.frame(maxWidth: .infinity)
			.padding(.vertical, MaskinSpace.s2)
			.accessibilityAddTraits(.isHeader)
	}
}
