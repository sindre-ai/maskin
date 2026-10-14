import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
#if canImport(UIKit)
	import UIKit
#elseif canImport(AppKit)
	import AppKit
#endif

/// The thread for one conversation (spec 7 §2–§5b): the topic heading and pinned message at the top
/// of the scrolling content, spec 7 bubbles grouped by sender, day and NEW dividers, handoff cards,
/// the agents' live state at the bottom, and a composer stack (quick replies, jump-to-latest,
/// composer or search bar) pinned above the keyboard. The nav bar carries the chat's lead name with
/// a live status line under it. Takes a ready `ChatStore` and `ChatComposerModel` so it previews
/// and snapshots without a server.
struct ChatThreadView: View {
	let store: ChatStore
	let composer: ChatComposerModel
	var conversations: ConversationsStore?
	var onShowParticipants: () -> Void = {}
	var onInvite: () -> Void = {}
	/// Opens the flow detail when the nav-bar title of a flow channel is tapped.
	var onOpenFlow: ((ChatFlowContext) -> Void)?

	@Environment(\.scenePhase) private var scenePhase
	@Environment(\.horizontalSizeClass) private var sizeClass
	@Environment(\.liveMeeting) private var liveMeeting
	/// Present in the app; absent in previews and snapshots, where `@` falls back to the thread's people.
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	/// The shell's live call; nil in previews and snapshots.
	@Environment(LiveCallCenter.self) private var liveCalls: LiveCallCenter?
	/// How far the reader is from the newest message, in points (0 at the bottom).
	@State private var distanceFromBottom: CGFloat = 0
	@State private var viewportHeight: CGFloat = 0
	/// Messages that arrived while the reader was scrolled up; the jump button says how many.
	@State private var unseenCount = 0
	/// False from opening the thread until it has settled at its opening position. The thread is
	/// drawn but hidden meanwhile, so the reader never watches it hunt for its place.
	@State private var revealed = false
	/// Loading has taken longer than the 300ms budget: show the skeleton.
	@State private var slowOpen = false
	/// True from opening the chat until the reader first scrolls it. While true the thread pins to
	/// its opening position (the newest message, or the NEW divider).
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
	private static let unreadDividerID = "unread-divider"
	private static let maxReadableWidth: CGFloat = 760
	/// Where the NEW divider and the current search match land, measured from the top.
	private static let unreadOpenOffset: CGFloat = 150
	private static let matchOffset: CGFloat = 170
	private static let skeletonAfter: Duration = .milliseconds(300)

	private var isNearBottom: Bool { distanceFromBottom <= JumpToLatest.showAfterDistance }
	private var flow: ChatFlowContext? { store.flowContext }
	private var presences: [(agent: ChatParticipant, presence: ChatAgentPresence)] { store.presences() }
	/// An agent is typing, streaming or working: the composer shows Stop.
	private var busy: Bool { !presences.isEmpty }

	/// The other party of a direct chat; nil for a group.
	private var counterpart: ChatParticipant? {
		let others = store.participants.filter { $0.id != store.currentActorID }
		return others.count == 1 ? others.first : nil
	}

	/// The agent in the chat, else the other person, else the title: who the composer addresses.
	private var leadName: String {
		let others = store.participants.filter { $0.id != store.currentActorID }
		return others.first { $0.kind == .agent }?.name ?? others.first?.name ?? store.title
	}

	private var navTitle: String {
		ThreadNav.title(
			participants: store.participants, currentActorID: store.currentActorID, fallback: store.title, flow: flow)
	}

	/// "Type your answer…" while a flow ask waits on the user; "Message {name}" otherwise.
	private var placeholder: String {
		if let last = store.messages.last, last.author == .agent, !last.questions.isEmpty,
			last.serverID.map({ !store.answeredQuestionIDs.contains($0) }) ?? false
		{
			return "Type your answer…"
		}
		return "Message \(leadName)"
	}

	private var quickReplies: [String] {
		guard !searching else { return [] }
		return QuickReplyRules.suggestions(
			latest: store.messages.last, currentActorID: store.currentActorID,
			composerEmpty: composer.text.isEmpty && composer.attachments.isEmpty, somebodyTyping: busy)
	}

	/// A flow's conversation: the Team room. Its composer has Go live in place of the mic. Groups use
	/// the ordinary composer (mic, no Go live).
	private var isRoom: Bool { flow != nil }

	/// Who a live call from this thread is with: its first agent. Nil (no Live button) without one.
	private var liveLead: ChatParticipant? { store.participants.first { $0.kind == .agent } }

	var body: some View {
		ScrollViewReader { proxy in
			observedContent(proxy)
				.ambientBackground()
				.safeAreaInset(edge: .bottom, spacing: 0) { composerStack(proxy) }
				.navigationTitle(navTitle)
				#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
				// The tab bar would sit on top of the composer. iPad keeps it: the split view has room.
				.toolbar(sizeClass == .compact ? .hidden : .automatic, for: .tabBar)
				#endif
				.toolbar { toolbarContent }
				// Arrow-only back button (user decision). The thread pushes the flow and the agent page.
				.backChevronOnly()
				.task { await runtime?.mentionRoster()?.load() }
				.onAppear { liveCalls?.visibleConversationID = store.conversationID }
				.task {
					// Drafts are per conversation: restored here, saved on every keystroke.
					if composer.boundConversationID == nil { composer.bind(conversationID: store.conversationID) }
					store.isActive = scenePhase == .active
					await store.start()
					primeHandsFree()
				}
				.onDisappear {
					store.isActive = false
					// A call keeps speaking when you leave the thread.
					if liveCalls?.current == nil { SpeechReader.shared.stop() }
					store.stop()
					if liveCalls?.visibleConversationID == store.conversationID { liveCalls?.visibleConversationID = nil }
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
	}

	// MARK: Nav bar

	/// Tapping the title of a flow channel opens the flow; of a direct agent chat, the agent's page.
	private var titleAction: (() -> Void)? {
		if let flow, let onOpenFlow { return { onOpenFlow(flow) } }
		if let counterpart, counterpart.kind == .agent, let runtime { return { runtime.openAgent(counterpart.id) } }
		return nil
	}

	@ToolbarContentBuilder
	private var toolbarContent: some ToolbarContent {
		ToolbarItem(placement: .principal) {
			ThreadNavTitle(
				title: navTitle, status: ThreadNav.status(presences: presences, flow: flow), onTap: titleAction)
		}
		// One group so iOS keeps everything in the bar instead of folding into a "More" overflow.
		ToolbarItemGroup(placement: .primaryAction) {
			if ThreadNav.showsMemberStack(participants: store.participants, flow: flow) {
				Button(action: onShowParticipants) {
					ThreadNavAvatars(participants: memberStack, leadID: flow?.leadID, limit: flow == nil ? 4 : 3)
				}
				.buttonStyle(.maskinPressed)
				.accessibilityHint("Opens People")
			}
			if flow != nil, let conversations, let row = conversations.conversation(id: store.conversationID) {
				Button {
					Task { await conversations.setPinned(row.id, !row.pinned) }
				} label: {
					Label(row.pinned ? "Unpin" : "Pin", systemImage: row.pinned ? "pin.fill" : "pin")
				}
			}
			Menu {
				Button {
					searching.toggle()
					if !searching { searchText = "" }
				} label: {
					Label("Search this chat", systemImage: "magnifyingglass")
				}
				Button(action: onShowParticipants) { Label("People", systemImage: "person.2") }
				Button(action: onInvite) { Label("Invite people", systemImage: "person.badge.plus") }
				if flow == nil, let conversations, let row = conversations.conversation(id: store.conversationID) {
					Button {
						Task { await conversations.setPinned(row.id, !row.pinned) }
					} label: {
						Label(row.pinned ? "Unpin" : "Pin to top", systemImage: row.pinned ? "pin.slash" : "pin")
					}
				}
				if let link = chatLink {
					Button {
						Clipboard.copy(link.absoluteString)
						MaskinHaptics.play(.success)
					} label: {
						Label("Copy link", systemImage: "link")
					}
				}
				Button {
					newTitle = store.title
					renaming = true
				} label: {
					Label("Rename", systemImage: "pencil")
				}
				if !store.idleSessions().isEmpty {
					Button(role: .destructive) {
						let ids = store.idleSessions().map(\.id)
						Task { for id in ids { await store.stopSession(id) } }
					} label: {
						Label("End background session", systemImage: "stop.circle")
					}
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
			if let lead = liveLead, !isRoom, call == nil {
				Button {
					liveMeeting.present(.thread(chat: store, lead: lead))
				} label: {
					ShellInkCircle(symbol: "waveform", label: "Live")
				}
				.buttonStyle(.maskinPressed)
			}
		}
	}

	/// The web link to this conversation, for Copy link.
	private var chatLink: URL? {
		guard let workspaceID = runtime?.environment.workspaceId else { return nil }
		return DeepLink.chat(workspaceId: workspaceID, id: store.conversationID).universalURL()
	}

	/// Members for the nav stack: in a flow the lead first, then the rest; in a group, everyone else.
	private var memberStack: [ChatParticipant] {
		let others = store.participants.filter { $0.id != store.currentActorID }
		guard let leadID = flow?.leadID, let lead = others.first(where: { $0.id == leadID }) else { return others }
		return [lead] + others.filter { $0.id != leadID }
	}

	// MARK: Content

	/// The thread plus the observers for search and hands-free speech (kept apart so `body`
	/// type-checks quickly).
	private func observedContent(_ proxy: ScrollViewProxy) -> some View {
		content(proxy)
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
	private func content(_ proxy: ScrollViewProxy) -> some View {
		switch store.phase {
		case .idle, .loading:
			// The skeleton only after the 300ms budget; a fast open never flashes it.
			ThreadSkeleton().opacity(slowOpen ? 1 : 0)
				.task {
					try? await Task.sleep(for: Self.skeletonAfter)
					slowOpen = true
				}
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't open this chat", message: message) {
				Button("Try again") { Task { await store.load() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			VStack(spacing: 0) {
				if let problem = store.syncProblem {
					StaleThreadBanner(problem: problem) { Task { await store.refresh() } }
						.padding(.horizontal, MaskinSpace.s9)
						.padding(.top, MaskinSpace.s3)
				}
				// An overlay, not a sibling row: appearing and disappearing must not resize the
				// scroll view, which would re-run the bottom anchor each time.
				thread(proxy)
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

	/// The thread's rows. Short threads in a plain stack (see `ThreadRendering`), long ones lazily.
	@ViewBuilder
	private func threadRows(_ proxy: ScrollViewProxy) -> some View {
		if ThreadRendering.usesLazyStack(rowCount: store.messages.count) {
			LazyVStack(alignment: .leading, spacing: 0) { threadContent(proxy, lazy: true) }
		} else {
			VStack(alignment: .leading, spacing: 0) { threadContent(proxy, lazy: false) }
		}
	}

	@ViewBuilder
	private func threadContent(_ proxy: ScrollViewProxy, lazy: Bool) -> some View {
		if store.hasEarlier {
			ProgressView()
				.frame(maxWidth: .infinity)
				.padding(.vertical, MaskinSpace.s5)
				// Only once the reader has scrolled: while the thread is still settling this
				// spinner can flash into view, and loading history then ends with a jump.
				.onAppear { if !followingOpen { loadEarlier(proxy) } }
		}
		// The heading and the typing hint make way for the call's own empty state.
		if call == nil || !store.messages.isEmpty { topicHeading }
		if let pinned = store.pinnedMessage {
			PinnedMessageStrip(message: pinned, onOpen: { scroll(to: pinned.id, proxy: proxy) }, onUnpin: { store.unpin() })
				.padding(.bottom, MaskinSpace.s9)
		}
		if store.messages.isEmpty {
			if let call { LiveCallEmptyState(session: call) } else { emptyHint }
		}
		ThreadTranscript(
			store: store, lazy: lazy, onEdit: beginEdit(_:), onReply: reply(to:), matchIDs: matchSet,
			currentMatchID: currentMatchID, call: call)
		Color.clear.frame(height: 1).id(Self.bottomID)
			.onAppear { if !usesGeometryTracking { reachedBottom() } }
			.onDisappear { if !usesGeometryTracking { distanceFromBottom = JumpToLatest.showAfterDistance + 1 } }
	}

	private func thread(_ proxy: ScrollViewProxy) -> some View {
		GeometryReader { geometry in
			ScrollView {
				threadRows(proxy)
					.padding(.horizontal, MaskinSpace.s9)
					.padding(.top, MaskinSpace.s2)
					.padding(.bottom, MaskinSpace.s7)
					// Readable measure on iPad and Mac; full width on iPhone.
					.frame(maxWidth: Self.maxReadableWidth)
					.frame(maxWidth: .infinity)
			}
			.defaultScrollAnchor(.bottom)
			.opacity(revealed ? 1 : 0)
			.overlay {
				if !revealed && slowOpen { ThreadSkeleton().allowsHitTesting(false).transition(.opacity) }
			}
			.animation(.easeOut(duration: MaskinDuration.d180), value: revealed)
			.onAppear {
				viewportHeight = geometry.size.height
				settleOpen(proxy)
			}
			.onChange(of: geometry.size.height) { _, height in viewportHeight = height }
			.onUserScroll {
				followingOpen = false
				revealed = true
			}
			.trackingDistanceFromBottom { distance in
				distanceFromBottom = distance
				if distance < MaskinSpace.touchMin { unseenCount = 0 }
			}
			.refreshable { await store.refresh() }
			.scrollDismissesKeyboard(.interactively)
			.onChange(of: store.messages.last?.id) { _, _ in
				// Follow new messages only while the reader is near the bottom (or just sent one);
				// otherwise leave them where they are and count them on the jump button.
				switch ThreadScrollPolicy.onNewestChanged(
					followingOpen: followingOpen, isAtBottom: isNearBottom,
					newestIsMine: store.messages.last?.actorID == store.currentActorID)
				{
				case .jump: jumpToBottom(proxy)
				case .follow: scrollToBottom(proxy)
				case .countUnseen: unseenCount += 1
				}
			}
			// The "speaking…" bubble appears at the bottom: keep it in view while you are following.
			.onChange(of: call?.voice.transcript.isEmpty) { _, _ in
				if isNearBottom { scrollToBottom(proxy) }
			}
			.onChange(of: currentMatchID) { _, id in
				guard let id else { return }
				withAnimation(MaskinMotion.standard) { proxy.scrollTo(id, anchor: topAnchor(Self.matchOffset)) }
			}
		}
	}

	/// The conversation's title as the 24pt heading at the top of the scrolling content.
	private var topicHeading: some View {
		VStack(alignment: .leading, spacing: 0) {
			contextLink
			topicTitle
		}
	}

	/// The mono line above the title (spec 7 §4): `THREAD IN {FLOW}` or `WITH {NAME}`. It opens the
	/// room, so it appears only when there is a room to open.
	@ViewBuilder
	private var contextLink: some View {
		if let titleAction, let label = contextLabel {
			Button(action: titleAction) {
				HStack(spacing: MaskinSpace.s2) {
					Text(label).font(ChatType.mono11).tracking(ChatType.mono11Tracking)
					Image(systemName: "chevron.right").maskinSymbol(MaskinFontSize.t11, weight: .semibold)
				}
				.foregroundStyle(MaskinColor.ink5)
				.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.padding(.horizontal, MaskinSpace.s2)
			.accessibilityLabel(label.capitalized)
		}
	}

	private var contextLabel: String? {
		if let flow { return "THREAD IN \(flow.name.uppercased())" }
		if let counterpart { return "WITH \(counterpart.name.uppercased())" }
		return nil
	}

	private var topicTitle: some View {
		Text(flow?.name ?? store.title)
			.maskinText(.sheetTitle)
			.foregroundStyle(MaskinColor.ink)
			.fixedSize(horizontal: false, vertical: true)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, MaskinSpace.s2)
			.padding(.top, MaskinSpace.s2)
			.padding(.bottom, MaskinSpace.s10)
			.accessibilityAddTraits(.isHeader)
	}

	private var emptyHint: some View {
		Text("Ask \(leadName) anything. Type @ to bring someone else in, or + to attach a file.")
			.font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
			.foregroundStyle(MaskinColor.ink4)
			.multilineTextAlignment(.center)
			.frame(maxWidth: .infinity)
			.padding(.vertical, MaskinSpace.s14 + MaskinSpace.s2)
			.padding(.horizontal, MaskinSpace.s10)
	}

	// MARK: Composer stack

	/// Quick replies, jump-to-latest, then the composer (or the search bar), stacked so the button
	/// and chips ride up as the composer grows.
	private func composerStack(_ proxy: ScrollViewProxy) -> some View {
		VStack(alignment: .trailing, spacing: MaskinSpace.s4) {
			if !isNearBottom && store.phase == .loaded {
				JumpToLatest(unseen: unseenCount) { scrollToBottom(proxy) }
					.padding(.bottom, MaskinSpace.s1)
					.transition(.opacity.combined(with: .scale(scale: 0.9)))
			}
			let replies = call == nil ? quickReplies : []
			if !replies.isEmpty {
				QuickReplyChips(replies: replies) { reply in
					if store.send(reply) == nil { composer.text = reply }
				}
				.transition(.opacity.combined(with: .move(edge: .bottom)))
			}
			if let call {
				callPanel(call)
			} else if searching {
				ThreadSearchBar(
					text: $searchText, matchCount: matchIDs.count, index: matchIndex,
					onStep: { matchIndex = ThreadSearch.step(from: matchIndex, by: $0, count: matchIDs.count) },
					onClose: {
						searching = false
						searchText = ""
					})
			} else {
				composerField
			}
		}
		.frame(maxWidth: Self.maxReadableWidth)
		.padding(.horizontal, MaskinSpace.s7)
		.padding(.bottom, MaskinSpace.s3)
		.frame(maxWidth: .infinity)
		.animation(MaskinMotion.standard, value: isNearBottom)
		.animation(MaskinMotion.quick, value: quickReplies)
	}

	/// The call running in this thread, if any.
	private var call: LiveMeetingSession? { liveCalls?.session(for: store.conversationID) }

	private func callPanel(_ call: LiveMeetingSession) -> some View {
		LiveCallPanel(
			session: call,
			mentioned: CallMentions.objects(
				in: store.messages.filter { ($0.createdAt ?? .distantFuture) >= call.startedAt ?? .distantPast }),
			onInvite: onInvite,
			onOpenObject: { runtime?.openObject($0.id) },
			onEnd: { liveCalls?.end() })
	}

	/// The shared composer (spec 7 §1): Stop in the last slot while an agent is typing, streaming
	/// or working; the reply / edit quote strip inside the bar.
	private var composerField: some View {
		MaskinComposer(
			model: composer,
			config: MaskinComposerConfig(
				variant: .floating, placeholder: placeholder, showsMic: !isRoom,
				goLive: isRoom ? liveLead.map { lead in { liveMeeting.present(.thread(chat: store, lead: lead)) } } : nil,
				suggestions: { query in
					MentionTrigger.candidates(
						query: query, participants: store.participants, workspace: store.workspaceActors,
						selfID: store.currentActorID, excluding: Set(composer.mentions.map(\.id)))
				},
				inConversation: Set(store.participants.map(\.id)),
				roster: runtime?.mentionRoster()?.roster),
			busy: busy,
			onStop: { Task { await store.stopLiveSessions() } },
			onSend: send
		)
	}

	/// Send, or — while the composer holds an edit — save the new text over the original message.
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

	private func reply(to message: ChatMessage) {
		composer.reply(to: message.actorName, text: message.content)
	}

	/// Edit loads the text into the composer under the "Editing message" quote; sending replaces it.
	private func beginEdit(_ message: ChatMessage) {
		composer.beginEdit(messageID: message.id, text: message.content)
	}

	// MARK: Search, speech

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
		// A call reads its own replies.
		guard handsFree, call == nil else { return }
		for message in fresh { SpeechReader.shared.enqueue(markdown: message.content, id: message.id) }
	}

	// MARK: Scrolling

	private var usesGeometryTracking: Bool {
		if #available(iOS 18, macOS 15, *) { return true }
		return false
	}

	private func reachedBottom() {
		distanceFromBottom = 0
		unseenCount = 0
	}

	/// An anchor that puts the target `offset` points below the top of the viewport.
	private func topAnchor(_ offset: CGFloat) -> UnitPoint {
		UnitPoint(x: 0.5, y: viewportHeight > 0 ? min(offset / viewportHeight, 1) : 0)
	}

	/// Whether the thread has a NEW divider to open on.
	private var opensOnUnread: Bool {
		ThreadLayout.items(for: store.messages, unreadAfter: store.openedReadCursor, currentActorID: store.currentActorID)
			.contains { if case .unreadDivider = $0 { true } else { false } }
	}

	/// Pin to the opening position (the NEW divider 150pt below the top, else the newest message),
	/// again after the rows have measured, then show the thread.
	private func settleOpen(_ proxy: ScrollViewProxy) {
		if opensOnUnread {
			followingOpen = false
			proxy.scrollTo(Self.unreadDividerID, anchor: topAnchor(Self.unreadOpenOffset))
			Task {
				try? await Task.sleep(for: .milliseconds(320))
				proxy.scrollTo(Self.unreadDividerID, anchor: topAnchor(Self.unreadOpenOffset))
				revealed = true
			}
			return
		}
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

	private func scroll(to id: String, proxy: ScrollViewProxy) {
		followingOpen = false
		withAnimation(MaskinMotion.standard) { proxy.scrollTo(id, anchor: topAnchor(Self.matchOffset)) }
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

/// The messages, dividers, handoff cards and the agents' live state, without scrolling. Split out
/// so it renders in snapshot tests (`ImageRenderer` doesn't draw scroll views). `lazy: false`
/// swaps the lazy stack for a plain one there.
struct ThreadTranscript: View {
	let store: ChatStore
	var lazy = true
	var now = Date()
	var onEdit: (ChatMessage) -> Void = { _ in }
	var onReply: (ChatMessage) -> Void = { _ in }
	var matchIDs: Set<String> = []
	var currentMatchID: String?
	/// The call running in this thread: its card shows what you are saying as you say it.
	var call: LiveMeetingSession?

	/// Each tagged person under your message with where they stand (Working, Replied, Waiting for X).
	private func mentionChips(for message: ChatMessage) -> [MentionStateChip] {
		message.mentionIDs.compactMap { id -> MentionStateChip? in
			guard let name = store.displayName(for: id) else { return nil }
			let kind = store.participants.first { $0.id == id }?.kind
				?? store.workspaceActors.first { $0.id == id }?.participant.kind
			let state = MentionChipState.resolve(
				mentionedID: id, kind: kind, after: message, in: store.messages,
				working: store.presence(of: id) != nil)
			return MentionStateChip(id: id, name: name, state: state)
		}
	}

	/// Spacing between rows: 16 between senders, 5 within a run (16 minus the 11 bubble padding).
	static let listGap: CGFloat = MaskinSpace.s9
	static let groupedGap: CGFloat = MaskinSpace.s9 - MaskinSpace.s6

	var body: some View {
		if lazy {
			// Flattened into the thread's own LazyVStack: a second lazy stack nested inside it
			// mis-measures under `defaultScrollAnchor(.bottom)` (blank gaps, jumping content).
			rows
		} else {
			VStack(alignment: .leading, spacing: 0) { rows }
		}
	}

	@ViewBuilder
	private var rows: some View {
		let answers = store.questionAnswerIndex
		let messages = store.messages
		let anchors =
			store.trace?.anchors(messages: messages, sessions: store.agentSessions) ?? ActivityAnchors()
		let items = ThreadLayout.items(
			for: messages, unreadAfter: store.openedReadCursor, currentActorID: store.currentActorID,
			calls: LiveCallLog.shared.records(for: store.conversationID))
		let latestOwn = ThreadLayout.latestOwnMessageID(in: messages, currentActorID: store.currentActorID)
		ForEach(items) { item in
			row(item, answers: answers, anchors: anchors, latestOwnID: latestOwn)
				.padding(.top, ThreadLayout.gap(before: item) == .grouped ? Self.groupedGap : Self.listGap)
		}
		TimelineView(.periodic(from: now, by: 15)) { context in
			activity(at: context.date)
		}
	}

	private struct PresenceRow: Identifiable {
		let agent: ChatParticipant
		let presence: ChatAgentPresence
		var id: String { agent.id }
	}

	/// The agents' live state under the newest message: a typing bubble (or the streaming reply)
	/// for one composing an answer, the live activity card for one working, `Stopped` for one the
	/// user cut short, and a Resume banner for one that paused.
	@ViewBuilder
	private func activity(at date: Date) -> some View {
		let live = store.presences(at: date).map { PresenceRow(agent: $0.agent, presence: $0.presence) }
		let sessions = store.liveSessions(at: date)
		ForEach(live) { row in
			Group {
				switch row.presence {
				case .typing, .replying:
					if let draft = store.liveReplyDraft(for: row.agent.id) {
						StreamingReplyBubble(agent: row.agent, text: draft)
					} else {
						TypingIndicator(agent: row.agent)
					}
				case .working:
					let session = sessions.first { $0.actorID == row.agent.id }
					LiveActivityView(
						agent: row.agent, fallbackActivity: session?.currentActivity,
						turn: session.flatMap { store.trace?.liveTurn(sessionID: $0.id) }, startedAt: session?.startedAt)
				}
			}
			.padding(.top, Self.listGap)
			.transition(.opacity)
		}
		let liveIDs = Set(live.map(\.id))
		ForEach(store.stoppedAgentIDs.sorted().filter { !liveIDs.contains($0) }, id: \.self) { agentID in
			StreamingReplyBubble(agent: store.participant(for: agentID), text: store.liveReplyDraft(for: agentID), stopped: true)
				.padding(.top, Self.listGap)
		}
		if live.isEmpty, let stalled = store.stalledSession() {
			ResumeBanner(agent: store.participant(for: stalled.actorID)) {
				Task { await store.resumeSession(stalled.id) }
			}
			.padding(.top, Self.listGap)
		}
	}

	private func actions(for message: ChatMessage, isOwn: Bool, isLatestOwn: Bool) -> MessageMenuActions {
		var actions = MessageMenuActions()
		let hasText = !message.content.isEmpty
		if hasText {
			actions.onReply = { onReply(message) }
			actions.onCopy = {
				Clipboard.copy(message.content)
				MaskinHaptics.play(.selection)
			}
		}
		if message.serverID != nil {
			actions.isPinned = store.isPinned(message)
			actions.onPin = { if store.isPinned(message) { store.unpin() } else { store.pin(message) } }
		}
		if isLatestOwn, message.canEdit(by: store.currentActorID) {
			actions.onEdit = { onEdit(message) }
		}
		if message.author == .agent, message.serverID != nil {
			actions.onTryAgain = { Task { await store.retryAgent(for: message) } }
			if hasText {
				actions.onShorter = { _ = store.askForShorter(message) }
			}
			let feedback = store.override(for: message.id).feedback
			actions.feedback = feedback
			actions.onGoodAnswer = { store.setFeedback(feedback == .good ? nil : .good, on: message.id) }
			actions.onNotRight = {
				store.setFeedback(.notRight, on: message.id)
				onReply(message)
			}
		}
		if message.isFailed {
			actions.onRetrySend = { store.retrySend(message.id) }
			actions.onDiscard = { store.discard(message.id) }
		}
		if hasText, !message.isFailed {
			let reading = SpeechReader.shared.isSpeaking(message.id)
			actions.readAloudTitle = reading ? "Stop reading" : "Read aloud"
			actions.onReadAloud = {
				if reading { SpeechReader.shared.stop() } else { SpeechReader.shared.speak(markdown: message.content, id: message.id) }
			}
		}
		return actions
	}

	@ViewBuilder
	private func row(
		_ item: ThreadItem, answers: [Int: [ChatQuestionAnswer.Answer]], anchors: ActivityAnchors, latestOwnID: String?
	) -> some View {
		switch item {
		case .daySeparator(let day):
			ThreadDivider(label: ThreadLayout.dayLabel(day, now: now).uppercased())
		case .system(let message):
			ThreadDivider(label: message.content, ruled: false)
		case .unreadDivider(let count):
			ThreadDivider.unread(count: count)
		case .liveCall(let card):
			LiveCallCardView(card: card, partial: call?.voice.transcript ?? "")
		case .handoff(let session, let behind):
			HandoffRow(session: session, behind: behind)
		case .message(let message, let showsAuthor):
			let isOwn = message.actorID == store.currentActorID
			let isLatestOwn = message.id == latestOwnID
			if let id = message.serverID, let turn = anchors.aboveReply[id] {
				FinishedTraceView(turn: turn).padding(.bottom, MaskinSpace.s3)
			}
			MessageRow(
				message: message, isOwn: isOwn, showsAuthor: showsAuthor,
				mentionNames: message.mentionIDs.compactMap { store.displayName(for: $0) },
				mentionChips: isOwn ? mentionChips(for: message) : [],
				mentions: message.mentionIDs.compactMap { id in
					store.displayName(for: id).map { (id: id, name: $0) }
				},
				questionAnswers: message.serverID.flatMap { answers[$0] },
				sendStatus: isLatestOwn ? MessageSendStatus.of(message, readBy: store.readBy(message)) : nil,
				messageOverride: store.override(for: message.id), isPinned: store.isPinned(message),
				versionsLocked: store.replyInFlight,
				working: message.author == .agent && store.presence(of: message.actorID) != nil,
				actions: actions(for: message, isOwn: isOwn, isLatestOwn: isLatestOwn),
				onRetrySend: { store.retrySend(message.id) },
				onReply: message.content.isEmpty ? nil : { onReply(message) },
				onAnswer: { picks in _ = store.answer(question: message, picks: picks) },
				onSelectVersion: { store.selectVersion($0, of: message.id) }
			)
			.overlay {
				if matchIDs.contains(message.id) {
					let current = message.id == currentMatchID
					RoundedRectangle(cornerRadius: BubbleShape.big + MaskinSpace.s2, style: .continuous)
						.strokeBorder(current ? MaskinColor.sig : MaskinColor.sigHi, lineWidth: current ? 2.5 : 2)
						.padding(-MaskinSpace.s2)
						.allowsHitTesting(false)
				}
			}
			if let id = message.serverID, let turn = anchors.afterTrigger[id] {
				FinishedTraceView(turn: turn).padding(.top, MaskinSpace.s3)
			}
		}
	}
}

extension View {
	/// Reports how far the reader is from the end of a scroll view, in points. Lazy-stack
	/// sentinels fire `onAppear`/`onDisappear` unreliably, so iOS 18+ reads the real geometry;
	/// iOS 17 keeps the sentinel (which reports 0 or "far").
	fileprivate func trackingDistanceFromBottom(_ action: @escaping (CGFloat) -> Void) -> some View {
		if #available(iOS 18, macOS 15, *) {
			return AnyView(
				onScrollGeometryChange(for: CGFloat.self) { geometry in
					// The visible rect is in content coordinates, so insets (the composer bar) can't skew it.
					max(geometry.contentSize.height - geometry.visibleRect.maxY, 0)
				} action: { _, distance in
					action(distance)
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
		.background(MaskinColor.noticeBg, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
				.strokeBorder(MaskinColor.noticeBd, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
}

/// Stands in for the thread while it loads or settles: the shape of a conversation (their messages
/// as wide cards on the left, yours as short ones on the right), bottom-aligned because a thread
/// opens at its newest message.
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
		.background(MaskinSurface.grouped)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Loading messages")
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
		.padding(.vertical, BubbleShape.theirVertical)
		.padding(.horizontal, BubbleShape.horizontal)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: BubbleShape.agent)
	}

	private func mine(width: CGFloat) -> some View {
		SkeletonBlock(height: MaskinSpace.s7, cornerRadius: MaskinRadius.tag2)
			.frame(width: width)
			.padding(.vertical, BubbleShape.myVertical)
			.padding(.horizontal, BubbleShape.horizontal)
			.background(MaskinSurface.inverse.opacity(0.08), in: BubbleShape.mine)
			.frame(maxWidth: .infinity, alignment: .trailing)
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
