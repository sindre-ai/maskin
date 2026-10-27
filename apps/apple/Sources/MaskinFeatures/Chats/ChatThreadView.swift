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
/// Which thread is open over a chat: the id of its root message.
struct ThreadRoute: Hashable {
	let rootID: Int
}

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
	/// Quick replies step aside while the reader scrolls up through the thread (they would sit over
	/// the text being read). Tapping the field, reaching the bottom or a new message brings them back.
	@State private var quickRepliesHidden = false
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
	/// True once the reader has scrolled the thread themselves; until then a late read cursor may
	/// still move the opening position to the NEW divider.
	@State private var userScrolled = false
	/// The opening position has been chosen (once; see `settleOpen`).
	@State private var settled = false
	/// The thread opened on its NEW divider, so new arrivals leave the reader where they are.
	@State private var openedOnUnread = false
	@State private var renaming = false
	/// A secret caught in the message box before sending; the sheet offers the Keychain.
	@State private var caughtSecret: CaughtSecret?
	@State private var secretStore: KeychainStore?
	@State private var newTitle = ""
	/// The thread open on top of this chat (a pushed screen).
	@State private var threadRoute: ThreadRoute?
	@State private var showingLinked = false
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
	/// How long a thread stays hidden after it appears, while its rows measure and the scroll pins.
	/// Held back too long it reads as a blank screen on open (it was 320ms).
	private static let revealDelay = 120
	/// Pauses before each re-anchor of a thread opened on its NEW divider; it stays hidden until the last.
	private static let reanchorDelays = [200, 300]
	/// How long the thread waits for its read cursor before opening at the bottom (offline).
	private static let openTimeout: Duration = .milliseconds(1500)

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

	/// A one-to-one chat with its own topic is titled by the topic, with the person under it.
	private var topic: String? {
		ThreadNav.topic(
			chatTitle: store.title, participants: store.participants, currentActorID: store.currentActorID, flow: flow)
	}

	private var navTitle: String {
		if call?.origin == .ownThread { return LiveMeetingChrome.ownThreadTitle }
		return topic ?? ThreadNav.title(
			participants: store.participants, currentActorID: store.currentActorID, fallback: store.title, flow: flow)
	}

	/// The live state if any; otherwise the person's name under a topic title.
	private var navStatus: ThreadNavStatus? {
		if let call, let startedAt = call.startedAt {
			return .quiet(
				LiveMeetingChrome.subline(
					origin: call.origin, threadTitle: topic ?? store.title, leadName: call.lead.name, startedAt: startedAt))
		}
		if let live = ThreadNav.status(presences: presences, flow: flow) { return live }
		guard topic != nil, let name = counterpart?.name else { return nil }
		return .quiet(name)
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
		// Never while a reply is owed: you have already answered, and a chip for the old question
		// would send a stale answer to a question the conversation has moved past.
		guard !searching, store.awaitingReplySince == nil else { return [] }
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
					// Nothing counts as read until the opening position is chosen (`settleOpen`).
					if !settled { store.isAtBottom = false }
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
				// An agent's reply is on screen: the moment to explain notifications.
				.onChange(of: store.messages.contains { $0.author == .agent && $0.status == .sent }, initial: true) { _, seen in
					if seen { runtime?.valueMomentSeen() }
				}
				.alert(
					"Something went wrong",
					isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })
				) {
					Button("OK", role: .cancel) {}
				} message: {
					Text(store.notice ?? "")
				}
				.navigationDestination(item: $threadRoute) { route in
					if let root = store.allMessages.first(where: { $0.serverID == route.rootID }) {
						ThreadScreen(store: store, root: root)
					}
				}
				.linkedItems(runtime)
				.sheet(item: $caughtSecret) { caught in
					if let secretStore {
						SecretCaughtSheet(
							caught: caught, store: secretStore,
							chatAgentIDs: Set(store.participants.filter { $0.kind == .agent }.map(\.id)),
							onRemove: { composer.text = $0 }, onVaulted: { composer.text = $0 })
					}
				}
				.sheet(isPresented: $showingLinked) {
					LinkedSheet(
						entries: linkedEntries,
						onJump: { entry in jump(to: entry, proxy: proxy) },
						onApproved: { entry, title, body in
							store.tellAgentOfApproval(title: title, body: body, linkedBy: entry.actorID, author: entry.author)
						})
						.linkedItems(runtime)
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
				title: navTitle, status: navStatus, onTap: titleAction)
		}
		// One group so iOS keeps everything in the bar instead of folding into a "More" overflow.
		ToolbarItemGroup(placement: .primaryAction) {
			if let call { LiveCallHeaderControls(session: call) { liveCalls?.end() } }
			if !linkedEntries.isEmpty {
				Button { showingLinked = true } label: {
					HStack(spacing: MaskinSpace.s1) {
						Image(systemName: "link")
						Text("\(linkedEntries.count)").maskinText(.caption).fontWeight(.semibold)
					}
					.foregroundStyle(MaskinColor.ink)
				}
				.accessibilityLabel("Linked")
				.accessibilityValue("\(linkedEntries.count)")
				.accessibilityHint("Shows the drafts, pages and objects this chat links to")
			}
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

	// MARK: Linked

	/// Everything the conversation's messages link to, newest first.
	private var linkedEntries: [LinkedEntry] { LinkedConversationItems.derive(from: store.allMessages) }

	/// Brings the message that linked something into view: in the timeline, or in its thread.
	private func jump(to entry: LinkedEntry, proxy: ScrollViewProxy) {
		guard let message = store.allMessages.first(where: { $0.id == entry.messageID }) else { return }
		if let rootID = message.threadRootID, !message.alsoInChannel {
			threadRoute = ThreadRoute(rootID: rootID)
		} else {
			scroll(to: message.id, proxy: proxy)
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
		if (call == nil || !store.messages.isEmpty) && !repeatsNavTitle { topicHeading }
		if let pinned = store.pinnedMessage {
			PinnedMessageStrip(message: pinned, onOpen: { scroll(to: pinned.id, proxy: proxy) }, onUnpin: { store.unpin() })
				.padding(.bottom, MaskinSpace.s9)
		}
		if store.messages.isEmpty, call?.lines.isEmpty ?? true {
			if let call { LiveCallEmptyState(session: call) } else { emptyHint }
		}
		ThreadTranscript(
			store: store, lazy: lazy, onEdit: beginEdit(_:), onReply: reply(to:), onFillStep: { composer.fill($0) },
			onOpenThread: { message in
				guard let id = message.serverID else { return }
				threadRoute = ThreadRoute(rootID: id)
			},
			matchIDs: matchSet,
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
				userScrolled = true
				if followingOpen { followingOpen = false }
				if !revealed { revealed = true }
			}
			// The opening position waits for the server's newest page (see `settleOpen`); this runs it
			// the moment that arrives, and a timer opens at the bottom if it never does.
			.onChange(of: store.serverConfirmed) { _, _ in settleOpen(proxy) }
			.task {
				try? await Task.sleep(for: Self.openTimeout)
				if !settled { settleOpen(proxy, force: true) }
			}
			.trackingDistanceFromBottom { distance in
				distanceFromBottom = distance
				let atBottom = distance < MaskinSpace.touchMin
				// Before the opening position is chosen the thread sits at the bottom by default:
				// that is not the reader reaching the end of it.
				if revealed, atBottom != store.isAtBottom {
					store.isAtBottom = atBottom
					// Reaching the end of the unread messages is what reads them.
					if atBottom { Task { await store.markReadIfNeeded() } }
				}
				if atBottom {
					unseenCount = 0
					quickRepliesHidden = false
				}
			}
			.onUserScrollUp { quickRepliesHidden = true }
			.onChange(of: store.messages.last?.id) { _, _ in quickRepliesHidden = false }
			.refreshable { await store.refresh() }
			.scrollDismissesKeyboard(.interactively)
			.onChange(of: store.messages.last?.id) { _, _ in
				// Follow new messages only while the reader is near the bottom (or just sent one);
				// otherwise leave them where they are and count them on the jump button.
				switch newestAction() {
				case .jump: jumpToBottom(proxy)
				case .follow:
					let last = store.messages.last
					// Next turn, once the lazy stack has measured the new row: scrolling in the same
					// pass animates toward an estimated bottom that then moves, which reads as a jerk.
					Task { @MainActor in
						await Task.yield()
						if let last, last.actorID != store.currentActorID, last.author == .agent {
							// A reply is read from its first line: bring its top into view. A short one still
							// ends at the bottom (the scroll view clamps), a long one doesn't start mid-way.
							unseenCount = 0
							withAnimation(MaskinMotion.standard) {
								proxy.scrollTo(last.id, anchor: topAnchor(Self.matchOffset))
							}
						} else {
							scrollToBottom(proxy)
						}
					}
				case .countUnseen: unseenCount += 1
				}
			}
			// The live activity card grows a line per step: keep it in view while the reader is at the bottom.
			.onChange(of: liveStepCount) { _, _ in
				guard isNearBottom, !followingOpen else { return }
				Task { @MainActor in
					await Task.yield()
					// Not animated: the card's own height is animating, and a second animation on top
					// of it makes the thread bounce.
					unseenCount = 0
					proxy.scrollTo(Self.bottomID, anchor: .bottom)
				}
			}
			// The working card appears under your message a moment after the send (once the agent has
			// the message). The send already scrolled to the bubble; without this the card lands below
			// the composer, out of sight, until the first step arrives.
			.onChange(of: store.presences().count) { _, _ in
				guard !followingOpen, isNearBottom || store.awaitingReplySince != nil else { return }
				Task { @MainActor in
					await Task.yield()
					scrollToBottom(proxy)
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

	/// A direct chat's heading is the nav bar's title again (and the "WITH …" link opens what the
	/// tappable nav title already opens), so it is left out; a topic or flow title still shows.
	private var repeatsNavTitle: Bool { (flow?.name ?? store.title) == navTitle }

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
			let replies = call == nil && !quickRepliesHidden ? quickReplies : []
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
		.animation(MaskinMotion.quick, value: quickRepliesHidden ? [] : quickReplies)
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
		.onAppear { liveCalls?.panelAppeared(for: call.chat.conversationID) }
		.onDisappear { liveCalls?.panelDisappeared(for: call.chat.conversationID) }
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
				roster: runtime?.mentionRoster()?.roster,
				onFocusChange: { focused in if focused { quickRepliesHidden = false } }),
			busy: busy,
			onStop: { Task { await store.stopLiveSessions() } },
			onSend: send
		)
	}

	/// Send, or — while the composer holds an edit — save the new text over the original message.
	private func send() {
		// The server refuses a message that holds a secret, so catch it here and offer the Keychain.
		if let match = SecretScanner.firstSecret(in: composer.text), let runtime {
			secretStore = SettingsServices(environment: runtime.environment).keychainStore()
			caughtSecret = CaughtSecret(text: composer.text, match: match)
			MaskinHaptics.play(.warning)
			return
		}
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

	/// What the thread does when its newest row changes. Opened on the NEW divider and not scrolled
	/// yet, a reply arriving must not pull the reader off the first unread message.
	private func newestAction() -> ThreadScrollAction {
		let mine = store.messages.last?.actorID == store.currentActorID
		if openedOnUnread && !userScrolled && !mine { return .countUnseen }
		return ThreadScrollPolicy.onNewestChanged(
			followingOpen: followingOpen, isAtBottom: isNearBottom, newestIsMine: mine)
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

	/// Choose the opening position, once, when the read cursor is known: the NEW divider 150pt below
	/// the top if there is one, else the newest message. The thread stays hidden until then, so the
	/// reader never sees it land somewhere and then move. `force` opens at the bottom when the cursor
	/// never arrived (offline).
	private func settleOpen(_ proxy: ScrollViewProxy, force: Bool = false) {
		// A saved thread knows the cursor but not the messages that arrived since: wait for the
		// server's newest page, or the divider would be missing when the position is chosen.
		guard !settled, store.serverConfirmed || force else { return }
		settled = true
		if opensOnUnread {
			openedOnUnread = true
			followingOpen = false
			store.isAtBottom = false
			proxy.scrollTo(Self.unreadDividerID, anchor: topAnchor(Self.unreadOpenOffset))
			// From here on, rows scrolling into view are the reader reading.
			store.countsSeen = true
			Task {
				try? await Task.sleep(for: .milliseconds(Self.revealDelay))
				if !userScrolled { proxy.scrollTo(Self.unreadDividerID, anchor: topAnchor(Self.unreadOpenOffset)) }
				// The rows above the divider are estimates until the lazy stack has drawn them, so
				// the first scrolls land short. Re-anchor as they measure, until the reader moves,
				// and only then show the thread: revealed first, each correction was a visible jump.
				for delay in Self.reanchorDelays {
					try? await Task.sleep(for: .milliseconds(delay))
					if userScrolled { break }
					proxy.scrollTo(Self.unreadDividerID, anchor: topAnchor(Self.unreadOpenOffset))
				}
				revealed = true
				// A thread short enough to be fully on screen never scrolls, so the bottom-reached
				// callback never fires and it would stay unread however far it is read. Checked at
				// the final position, not the one before the rows measured.
				if usesGeometryTracking, !userScrolled, distanceFromBottom < MaskinSpace.touchMin {
					store.isAtBottom = true
					await store.markReadIfNeeded()
				}
			}
			return
		}
		store.isAtBottom = true
		store.countsSeen = true
		Task { await store.markReadIfNeeded() }
		jumpToBottom(proxy)
		Task {
			try? await Task.sleep(for: .milliseconds(Self.revealDelay))
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

	/// Live steps across running sessions: changes whenever the activity card gains a line.
	private var liveStepCount: Int {
		store.liveSessions().reduce(0) { $0 + (store.trace?.liveTurn(sessionID: $1.id)?.steps.count ?? 0) }
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
	/// An intro's fill step: put its prompt in the composer.
	var onFillStep: (String) -> Void = { _ in }
	/// Opens the thread under a message (the pill, or Reply in thread).
	var onOpenThread: (ChatMessage) -> Void = { _ in }
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

	/// What you are saying now, for the card's "speaking…" line. A voice call only has your words once
	/// they are final, and by then they are a line of the card: showing them again would repeat them.
	static func partialWords(_ call: LiveMeetingSession) -> String {
		call.voice.capturesOwnTranscript ? "" : call.voice.transcript
	}

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
		// A voice call keeps its lines in the call log, which is not observable: reading the running
		// call's lines here is what redraws the card as each one is transcribed.
		let _ = call?.lines.count
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

	/// The agents' live state under the newest message: the live activity card (the one indicator,
	/// whether the agent is thinking or running tools) or the streaming reply, `Stopped` for one the
	/// user cut short, and a Resume banner for one that paused.
	@ViewBuilder
	private func activity(at date: Date) -> some View {
		let live = store.presences(at: date).map { PresenceRow(agent: $0.agent, presence: $0.presence) }
		let sessions = store.liveSessions(at: date)
		ForEach(live) { row in
			Group {
				let session = sessions.first { $0.actorID == row.agent.id }
				if let draft = store.liveReplyDraft(for: row.agent.id) {
					StreamingReplyBubble(agent: row.agent, text: draft)
				} else {
					LiveActivityView(
						agent: row.agent, fallbackActivity: session?.currentActivity,
						turn: session.flatMap { store.trace?.liveTurn(sessionID: $0.id) },
						sentAt: store.awaitingReplySince, startedAt: session?.startedAt)
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
		if message.serverID != nil, message.kind == "message", !message.isFailed {
			actions.reacted = Set(message.reactions.filter(\.reactedByMe).map(\.emoji))
			actions.onReact = { emoji in Task { await store.toggleReaction(emoji, on: message) } }
		}
		if message.serverID != nil, message.kind == "message", !message.isThreadReply, !message.isFailed {
			actions.onThread = { onOpenThread(message) }
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
			SystemLine(message: message)
		case .unreadDivider(let count):
			ThreadDivider.unread(count: count)
		case .callDivider(let divider):
			ThreadDivider(label: divider.label)
		case .liveCall(let card):
			LiveCallCardView(card: card, partial: call.map(Self.partialWords) ?? "")
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
				threadSummary: store.threadSummary(for: message),
				onOpenThread: { onOpenThread(message) },
				onToggleReaction: { emoji in Task { await store.toggleReaction(emoji, on: message) } },
				onAnswer: { picks in _ = store.answer(question: message, picks: picks) },
				onKeychainReply: { text, metadata in _ = store.send(text, metadata: metadata) },
				onSendStep: { prompt, introID, index in
					_ = store.send(
						prompt,
						metadata: ChatSendMetadata(fromSuggestedStep: ChatSuggestedStepRef(introMessageID: introID, index: index)))
				},
				onFillStep: onFillStep,
				introStepsOpen: AgentIntroView.stepsOpen(for: message, in: store.messages),
				cardOutcome: message.asksForAnswer
					? message.serverID.flatMap { store.cardAnswerIndex[$0] } : nil,
				chatAgents: store.participants.filter { $0.kind == .agent },
				onSelectVersion: { store.selectVersion($0, of: message.id) },
				onApprovedDraft: { title, body in
					store.tellAgentOfApproval(title: title, body: body, linkedBy: message.actorID, author: message.author)
				}
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
			// A hairline at the message's foot: once it scrolls into view the message has been read
			// to its end, however many screens long it is.
			.seenAtFoot(of: message, in: store)
			if let id = message.serverID, let turn = anchors.afterTrigger[id] {
				FinishedTraceView(turn: turn).padding(.top, MaskinSpace.s3)
			}
		}
	}
}

extension View {
	/// Tells the store the reader has scrolled past this message (iOS 18+; earlier systems mark
	/// read at the bottom only).
	@ViewBuilder
	fileprivate func seenAtFoot(of message: ChatMessage, in store: ChatStore) -> some View {
		if #available(iOS 18, macOS 15, *), let id = message.serverID, message.actorID != store.currentActorID {
			overlay(alignment: .bottom) {
				Color.clear.frame(height: 1)
					.onScrollVisibilityChange(threshold: 0.5) { visible in
						if visible { store.noteSeen(id) }
					}
			}
		} else {
			self
		}
	}

	/// Reports how far the reader is from the end of a scroll view, in points. Lazy-stack
	/// sentinels fire `onAppear`/`onDisappear` unreliably, so iOS 18+ reads the real geometry;
	/// iOS 17 keeps the sentinel (which reports 0 or "far").
	fileprivate func trackingDistanceFromBottom(_ action: @escaping (CGFloat) -> Void) -> some View {
		if #available(iOS 18, macOS 15, *) {
			return AnyView(
				onScrollGeometryChange(for: CGFloat.self) { geometry in
					// The visible rect is in content coordinates, so insets (the composer bar) can't skew it.
					// Bucketed: the action only fires when the bucket changes, not on every scroll frame.
					// Writing the raw offset into @State re-rendered the whole thread each frame.
					let distance = max(geometry.contentSize.height - geometry.visibleRect.maxY, 0)
					if distance < MaskinSpace.touchMin { return 0 }
					if distance <= JumpToLatest.showAfterDistance { return MaskinSpace.touchMin }
					return JumpToLatest.showAfterDistance + 1
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

/// Fires when the reader drags or flings the thread towards older messages. Programmatic scrolls
/// and keyboard inset changes move the offset too, so only motion during a user scroll phase counts.
/// iOS 17 has no scroll phase and never fires.
private struct UserScrollUpModifier: ViewModifier {
	let action: () -> Void
	@State private var userScrolling = false

	func body(content: Content) -> some View {
		if #available(iOS 18, macOS 15, *) {
			content
				.onScrollPhaseChange { _, phase in userScrolling = phase == .interacting || phase == .decelerating }
				.onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { old, new in
					if userScrolling, new < old - 1 { action() }
				}
		} else {
			content
		}
	}
}

extension View {
	fileprivate func onUserScrollUp(_ action: @escaping () -> Void) -> some View {
		modifier(UserScrollUpModifier(action: action))
	}

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
