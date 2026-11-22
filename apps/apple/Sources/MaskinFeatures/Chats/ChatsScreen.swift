import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Team tab. A `NavigationSplitView`: list + thread side by side on iPad and Mac, a
/// push stack on iPhone. Owns its navigation and applies the shell toolbar.
///
/// `requestedConversationId` is the entry point for deep links: when it becomes non-nil the
/// screen selects that conversation (list and thread on iPad/Mac, a pushed thread on iPhone)
/// and resets the binding to nil, so the same link can be requested again later.
public struct ChatsScreen: View {
	private let environment: AppEnvironment
	@Binding private var requestedConversationId: String?

	public init(
		environment: AppEnvironment, requestedConversationId: Binding<String?> = .constant(nil)
	) {
		self.environment = environment
		_requestedConversationId = requestedConversationId
	}

	/// Moves a pending request into the selection. Returns whether one was applied.
	@discardableResult
	static func consume(request: inout String?, into selection: inout String?) -> Bool {
		guard let id = request else { return false }
		selection = id
		request = nil
		return true
	}

	public var body: some View {
		if let workspaceID = environment.workspaceId {
			// Rebuilt per workspace so no conversation from the previous one lingers.
			ChatsContainer(
				environment: environment, workspaceID: workspaceID,
				requestedConversationId: $requestedConversationId
			)
			.id(workspaceID)
		} else {
			NavigationStack {
				EmptyState(symbol: "bubble.left.and.bubble.right", title: "Choose a workspace")
					.shellToolbar(environment: environment, title: "Chats")
			}
		}
	}
}

private struct ChatsContainer: View {
	let environment: AppEnvironment
	@State private var store: ConversationsStore
	@State private var chatSearch: ChatListSearchModel
	@State private var showDisplay = false
	/// The new chat list (flag chat-list-v2). Starts at the last answer and is read again on appear.
	@State private var chatListV2 = ChatListFlagCache.lastKnown
	@State private var selection: String?
	@State private var search = ""
	@State private var searchPresented = false
	@State private var newChat: NewChatRequest?
	@State private var showThreads = false
	/// iPad: which columns show. Portrait hides the list while a chat is open; the panel button in the thread header toggles it.
	@State private var columnVisibility: NavigationSplitViewVisibility = .automatic
	@State private var isPortrait = false
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Environment(\.liveMeeting) private var liveMeeting
	@Environment(\.horizontalSizeClass) private var horizontalSizeClass
	@Environment(\.verticalSizeClass) private var verticalSizeClass
	@Binding var requestedConversationId: String?

	private struct NewChatRequest: Identifiable {
		let id = UUID()
		var prefill = ""
		var recipient: ChatParticipant?
		var entryPoint = "agent_one_shot"
	}

	init(
		environment: AppEnvironment, workspaceID: String, requestedConversationId: Binding<String?>
	) {
		self.environment = environment
		_requestedConversationId = requestedConversationId
		_chatSearch = State(
			initialValue: ChatListSearchModel(
				source: APIChatSearch(
					baseURL: environment.baseURL, clientSource: environment.clientSource,
					credentials: environment.auth.credentialsProvider,
					operators: { ChatListFlagCache.lastKnown })))
		let store = ConversationsStore(
			api: APIChatsSource(
				client: environment.client, workspaceID: workspaceID,
				attention: APIChatAttention(
					baseURL: environment.baseURL, clientSource: environment.clientSource,
					credentials: environment.auth.credentialsProvider)),
			events: environment.events, cache: environment.snapshotCache,
			preferences: TeamPreferences(actorID: environment.auth.session?.actorId, workspaceID: workspaceID))
		// The new list reads the attention fields from the first page when the flag was on last time.
		store.readsAttention = ChatListFlagCache.lastKnown
		_store = State(initialValue: store)
	}

	private var session: StoredSession? { environment.auth.session }

	var body: some View {
		NavigationSplitView(columnVisibility: $columnVisibility) {
			listChrome(ConversationListView(
				store: store, selection: $selection, search: $search,
				currentActorID: session?.actorId,
				isLive: environment.events.connection != .failed,
				sendTick: sendTick,
				onNewChat: { recipient in newChat = NewChatRequest(recipient: recipient) },
				onSearchEverywhere: { _ in runtime?.selectedTab = .search },
				onSuggestion: { text in Task { await startWithChiefOfStaff(text: text) } },
				onThreads: { showThreads = true },
				chatSearch: chatSearch,
				pillPlacement: TeamPillPlacement.resolve(
					compactWidth: horizontalSizeClass == .compact, regularHeight: verticalSizeClass == .regular),
				pill: runtime?.teamPill,
				chatListV2: chatListV2
			))
		} detail: {
			Group {
				if let selection, let flowID = Self.flowID(from: selection) {
					FlowRoomHost(environment: environment, store: store, flowID: flowID)
						.id(selection)
				} else if let selection {
					ChatThreadHost(
						environment: environment, conversations: store, conversationID: selection,
						onLeft: { self.selection = nil }
					)
					.id(selection)
				} else {
					EmptyState(
						symbol: "bubble.left.and.bubble.right", title: "Select a conversation",
						message: "Chat with your team and your agents.")
				}
			}
			.modifier(ChatsListToggle(showsButton: showsListToggle, onToggle: toggleList))
		}
		.background {
			GeometryReader { proxy in
				Color.clear.onChange(of: proxy.size, initial: true) { _, size in
					isPortrait = ChatsPadLayout.isPortrait(size)
				}
			}
		}
		.onChange(of: isPortrait, initial: true) {
			guard ShellIdiom.isPad else { return }
			columnVisibility = ChatsPadLayout.visibility(portrait: isPortrait, hasSelection: selection != nil)
		}
		.onChange(of: selection) {
			// Landscape keeps whatever the person chose; portrait gives a chat the whole width.
			guard ShellIdiom.isPad, isPortrait else { return }
			columnVisibility = ChatsPadLayout.visibility(portrait: true, hasSelection: selection != nil)
		}
		.onChange(of: requestedConversationId, initial: true) {
			ChatsScreen.consume(request: &requestedConversationId, into: &selection)
		}
		.onChange(of: runtime?.newConversationRequested, initial: true) {
			guard runtime?.newConversationRequested == true else { return }
			runtime?.newConversationRequested = false
			newChat = NewChatRequest()
		}
		.onChange(of: runtime?.chiefChatRequested, initial: true) {
			guard runtime?.chiefChatRequested == true else { return }
			runtime?.chiefChatRequested = false
			Task { await newChatWithChiefOfStaff() }
		}
		.onChange(of: runtime?.agentChatRequest, initial: true) {
			guard let request = runtime?.agentChatRequest else { return }
			runtime?.agentChatRequest = nil
			if request.live {
				Task { await startLive(with: request.agent) }
			} else {
				newChat = NewChatRequest(
					prefill: request.draft, recipient: request.agent, entryPoint: request.entryPoint)
			}
		}
		.onChange(of: runtime?.chatDraft, initial: true) {
			// A build request from Agents or Loops: agents and loops are set up by the Chief of Staff.
			guard let draft = runtime?.chatDraft else { return }
			runtime?.chatDraft = nil
			Task { await startWithChiefOfStaff(text: draft.text) }
		}
		.task { await store.start() }
		.task {
			let on = await ChatListFlag.isOn(APIFeatureFlags(client: environment.client))
			ChatListFlagCache.lastKnown = on
			chatListV2 = on
			guard store.readsAttention != on else { return }
			store.readsAttention = on
			await store.refresh()
			await store.refreshLater()
		}
		.onChange(of: selection != nil || showThreads, initial: true) { _, covered in
			runtime?.teamPill.isCovered = covered
		}
		.onAppear { runtime?.teamPill.attach(store: store, onThreads: { showThreads = true }) }
		.onDisappear {
			store.stop()
			runtime?.teamPill.detach(store)
		}
		.sheet(isPresented: $showThreads) {
			ThreadsSheet(environment: environment, conversations: store)
		}
		.sheet(item: $newChat) { request in
			NewChatSheet(
				store: store, currentActorID: session?.actorId, prefill: request.prefill,
				initialRecipient: request.recipient, entryPoint: request.entryPoint,
				uploader: APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? "", largeUploads: environment.largeUploads)
			) { created, live in
				selection = created.id
				if live, let lead = created.participants.first(where: { $0.kind == .agent }) {
					// The cover opens once the sheet has finished dismissing.
					Task {
						try? await Task.sleep(for: .milliseconds(450))
						liveMeeting.present(.conversation(id: created.id, lead: lead))
					}
				}
			}
			.presentationDetents([.large])
		}
	}

	/// The list column's top. The iPad has one row (search field with Display inside, and the "+")
	/// and no title; iPhone and Mac keep the title, the pill of actions and the page search.
	@ViewBuilder
	private func listChrome(_ list: some View) -> some View {
		if ShellIdiom.hasRail {
			list
				.safeAreaInset(edge: .top, spacing: 0) {
					ChatsListHeader(
						search: $search, displayActive: displayActive,
						onDisplay: { showDisplay = true }, onNew: { newChat = NewChatRequest() },
						onAccount: showsAccountAvatar ? { runtime?.showProfile = true } : nil,
						accountName: session?.name ?? "", accountActorID: session?.actorId)
				}
				#if os(iOS)
					.toolbar(.hidden, for: .navigationBar)
				#endif
				.sheet(isPresented: $showDisplay) { ChatsDisplaySheet(store: store, chatListV2: chatListV2) }
				.navigationSplitViewColumnWidth(
					min: ChatsPadLayout.portraitListWidth, ideal: ChatsPadLayout.listWidth(portrait: isPortrait),
					max: 520)
		} else {
			list
				.shellToolbar(
					environment: environment, title: "Chats",
					actions: ShellActions(
						new: { newChat = NewChatRequest() }, newLabel: "New conversation",
						displaySymbol: ShellActions.slidersSymbol, displayActive: displayActive,
						displayToggle: { showDisplay = true },
						hidesAvatar: true, newAlwaysVisible: true, newIsPrimary: true,
						search: { searchPresented = true }))
				.pageSearch(text: $search, isPresented: $searchPresented, prompt: "Search chats")
				.sheet(isPresented: $showDisplay) { ChatsDisplaySheet(store: store, chatListV2: chatListV2) }
				// iPad spec: the Team column is 430 wide.
				.navigationSplitViewColumnWidth(min: 360, ideal: 430, max: 520)
		}
	}

	/// Portrait has no sidebar to hold the account, so the list header carries the avatar.
	private var showsAccountAvatar: Bool {
		runtime != nil && session != nil && ShellIdiom.barShowsAvatar(hasRail: ShellIdiom.hasRail, portrait: isPortrait)
	}

	/// The Display options differ from the defaults.
	private var displayActive: Bool {
		chatListV2 ? store.listGroupBy != .date : !store.displayOptions.isDefault
	}

	/// The panel button shows on an iPad with room for both columns; a collapsed split view keeps
	/// its own back button.
	private var showsListToggle: Bool { ShellIdiom.isPad && horizontalSizeClass == .regular }

	private func toggleList() {
		columnVisibility = ChatsPadLayout.toggled(columnVisibility)
	}

	/// A flow row's selection key is `flow:<id>`; everything else is a conversation id.
	static func flowID(from selection: String) -> String? {
		let prefix = TeamLayout.flowPinKey("")
		guard selection.hasPrefix(prefix) else { return nil }
		return String(selection.dropFirst(prefix.count))
	}

	/// What your latest message in a conversation is doing, from the send queue and the snippet.
	private func sendTick(_ conversation: ConversationSummary) -> ConversationRowStatus.Tick? {
		let pending = ChatsRuntime.shared(environment: environment).queue.pending(in: conversation.id)
		if pending.contains(where: { if case .failed = $0.state { return true } else { return false } }) { return .failed }
		if !pending.isEmpty { return .sending }
		guard let me = session?.actorId, conversation.snippetActorID == me else { return nil }
		// Read receipts are not in the API yet, so a delivered message stops at one tick.
		return .sent
	}
}

extension ChatsContainer {
	/// A live call with `agent` from its page: the person's one direct message with the agent, which
	/// the call runs in. Falls back to the new-chat sheet addressed to the agent if it can't be opened.
	fileprivate func startLive(with agent: ChatParticipant) async {
		do {
			let created = try await store.openDirect(
				with: agent.id, title: ThreadLayout.defaultTitle(for: [agent.name]))
			selection = created.id
			liveMeeting.present(.conversation(id: created.id, lead: agent))
		} catch {
			newChat = NewChatRequest(recipient: agent)
		}
	}

	/// The tab bar's "+": the new-chat sheet addressed to the workspace's Chief of Staff. Without one
	/// the sheet opens with nobody picked; it never claims a recipient it did not find.
	fileprivate func newChatWithChiefOfStaff() async {
		await store.loadActors()
		let chief = store.actors.first {
			$0.isSystem && $0.participant.kind == .agent && $0.participant.name == "Chief of Staff"
		}
		newChat = NewChatRequest(recipient: chief?.participant)
	}

	/// Agents and loops are never built through a form: the Chief of Staff scopes them with the
	/// person and creates them. Opens a chat with it, or the new-chat sheet with the text filled in
	/// when the workspace has no Chief of Staff (or the chat can't be created).
	fileprivate func startWithChiefOfStaff(text: String) async {
		await store.loadActors()
		guard
			let chief = store.actors.first(where: {
				$0.isSystem && $0.participant.kind == .agent && $0.participant.name == "Chief of Staff"
			})
		else {
			newChat = NewChatRequest(prefill: text)
			return
		}
		do {
			let created = try await store.create(
				title: ThreadLayout.defaultTitle(for: [chief.participant.name]),
				participantIDs: [chief.id], firstMessage: text)
			Analytics.shared.chatSessionStarted(conversationId: created.id, participants: [chief.participant])
			MaskinHaptics.play(.success)
			selection = created.id
		} catch {
			newChat = NewChatRequest(prefill: text)
		}
	}
}

/// The panel button at the left of the thread's header (also with no chat selected) that hides or
/// shows the list. It replaces the system sidebar toggle, so the two never show together.
private struct ChatsListToggle: ViewModifier {
	let showsButton: Bool
	let onToggle: () -> Void

	func body(content: Content) -> some View {
		content
			.toolbar(removing: showsButton ? ToolbarDefaultItemKind.sidebarToggle : nil)
			.toolbar {
				if showsButton {
					ToolbarItem(placement: .shellLeading) {
						Button(action: onToggle) {
							Image(systemName: "sidebar.leading")
						}
						.accessibilityLabel("Show or hide chat list")
					}
				}
			}
	}
}

/// Flow rooms for the Team list, from the flows API: the flow, its latest post and who wrote it.
/// Conversations carry no flow link yet, so this is the only source of FLOWS rows.
struct LoopFlowRoomsSource: FlowRoomsSource {
	let api: any LoopsAPI
	/// The latest post is fetched per flow, so only this many of the most recent flows get one.
	var previewLimit = 8

	func flowRooms() async throws -> [TeamFlowRoom] {
		let loops = try await api.loops().filter { $0.status != .draft }
			.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
		let directory = ActorDirectory((try? await api.actors()) ?? [])
		let previewed = Set(loops.prefix(previewLimit).map(\.id))
		return await withTaskGroup(of: TeamFlowRoom.self, returning: [TeamFlowRoom].self) { group in
			for loop in loops {
				group.addTask {
					var room = TeamFlowRoom(
						id: loop.id, name: loop.displayName, lastActivity: loop.updatedAt, loop: loop)
					if previewed.contains(loop.id), let last = try? await api.latestPost(loopID: loop.id) {
						room.lastPostAuthor = directory.name(last.actorID)
						room.lastPostText = last.text
						room.lastActivity = last.date ?? loop.updatedAt
					}
					return room
				}
			}
			var rooms: [TeamFlowRoom] = []
			for await room in group { rooms.append(room) }
			return rooms.sorted { ($0.lastActivity ?? .distantPast) > ($1.lastActivity ?? .distantPast) }
		}
	}
}

/// A flow opened from the Team list: its channel, which is the flow's timeline.
private struct FlowRoomHost: View {
	let environment: AppEnvironment
	let store: ConversationsStore
	let flowID: String

	var body: some View {
		if let room = store.flowRooms.first(where: { $0.id == flowID }) {
			FlowChannelScreen(environment: environment, store: store, room: room)
		} else {
			EmptyState(symbol: "arrow.triangle.2.circlepath", title: "This flow isn't here any more")
		}
	}
}

/// Builds the `ChatStore` for one conversation and hosts the thread plus its participants sheet.
/// The Threads screen over the Team list: a row opens its thread, which lives in a chat of its
/// own (loaded here for that one conversation, with the same stores the chat itself uses).
private struct ThreadsSheet: View {
	let environment: AppEnvironment
	let conversations: ConversationsStore
	@Environment(\.dismiss) private var dismiss
	@State private var route: ThreadsRoute?

	struct ThreadsRoute: Hashable {
		let conversationID: String
		let rootID: Int
	}

	var body: some View {
		NavigationStack {
			ThreadsListScreen(store: conversations) { item in
				guard let rootID = item.root.serverID else { return }
				route = ThreadsRoute(conversationID: item.conversationID, rootID: rootID)
			}
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
			.navigationDestination(item: $route) { route in
				if let item = conversations.threads.first(where: {
					$0.conversationID == route.conversationID && $0.root.serverID == route.rootID
				}) {
					ThreadHost(environment: environment, conversations: conversations, item: item)
				}
			}
		}
		.presentationDetents([.large])
	}
}

/// One thread opened from the Threads list. Builds the chat store for the thread's conversation
/// once and stops it when the thread closes.
private struct ThreadHost: View {
	let environment: AppEnvironment
	let conversations: ConversationsStore
	let item: ThreadListItem
	@State private var holder = Holder()

	@MainActor
	private final class Holder { var chat: ChatStore? }

	private func make() -> ChatStore {
		let session = environment.auth.session
		let source = APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? "")
		let chat = ChatStore(
			conversationID: item.conversationID, currentActorID: session?.actorId ?? "",
			currentActorName: session?.name ?? "You", api: source,
			queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
			cache: environment.snapshotCache,
			knownLastMessageAt: conversations.conversation(id: item.conversationID)?.lastMessageAt)
		// A thread open on screen has nothing to say about the chat's own read marker.
		chat.isActive = false
		return chat
	}

	var body: some View {
		let chat = holder.chat ?? make()
		let _ = { holder.chat = chat }()
		ThreadScreen(
			store: chat, root: item.root,
			uploader: APIChatsSource(
				client: environment.client, workspaceID: environment.workspaceId ?? "", largeUploads: environment.largeUploads))
			.onDisappear {
				chat.stop()
				Task { await conversations.refreshThreads() }
			}
	}
}

private struct ChatThreadHost: View {
	let environment: AppEnvironment
	let conversations: ConversationsStore
	let conversationID: String
	var onLeft: () -> Void = {}
	/// The store and composer are built once, on first render. They were `@State(initialValue:)`
	/// built in `init`, which runs on every parent re-render (each list update) and paid for a
	/// disk-cache decode and a store each time before SwiftUI discarded the result.
	@State private var holder = ThreadHolder()
	@State private var showParticipants = false
	/// Opens the People sheet straight on its picker ("Invite people").
	@State private var inviting = false
	/// The archived bar's Unarchive worked: the bar goes even if the chat is in neither list.
	@State private var unarchived = false

	init(
		environment: AppEnvironment, conversations: ConversationsStore, conversationID: String,
		onLeft: @escaping () -> Void = {}
	) {
		self.onLeft = onLeft
		self.environment = environment
		self.conversations = conversations
		self.conversationID = conversationID
	}

	@MainActor
	private final class ThreadHolder {
		var built: (chat: ChatStore, composer: ChatComposerModel)?
	}

	private func make() -> (chat: ChatStore, composer: ChatComposerModel) {
		let conversationID = conversationID
		let session = environment.auth.session
		let source = APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? "", largeUploads: environment.largeUploads)
		let chat = ChatStore(
			conversationID: conversationID, currentActorID: session?.actorId ?? "",
			currentActorName: session?.name ?? "You", api: source,
			queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
			cache: environment.snapshotCache,
			knownLastMessageAt: conversations.conversation(id: conversationID)?.lastMessageAt)
		chat.trace = ActivityStore(
			source: HTTPSessionActivitySource(environment: environment), cache: environment.snapshotCache)
		chat.onMarkedRead = { [conversations] id, _ in
			Task { await conversations.markRead(id, serverAlreadyKnows: true) }
		}
		chat.onSessionsRefreshed = { [weak chat, weak environment, conversations] sessions in
			// Foreground fallback for the Live Activity; background updates come from APNs.
			guard let coordinator = TurnActivityCoordinator.shared, let chat,
				let workspaceId = environment?.workspaceId
			else { return }
			let turns = LiveTurn.turns(
				from: sessions.filter { !chat.isIdle($0) }, workspaceId: workspaceId, conversationId: conversationID,
				agentName: { id in chat.workspaceActors.first { $0.id == id }?.participant.name },
				topic: conversations.conversation(id: conversationID)?.title, now: Date())
			Task {
				await coordinator.reconcile(turns, conversationId: conversationID)
				await coordinator.sweep()
			}
		}
		let composer = ChatComposerModel(uploader: source, selfActorID: session?.actorId ?? "")
		composer.bind(conversationID: conversationID)
		return (chat, composer)
	}

	var body: some View {
		let built = holder.built ?? make()
		let _ = { holder.built = built }()
		let chat = built.chat
		let composer = built.composer
		return ChatThreadView(store: chat, composer: composer, conversations: conversations,
			onShowParticipants: { showParticipants = true },
			onInvite: {
				inviting = true
				showParticipants = true
			})
			// A chat opened from search can be archived: say so, and offer the way back.
			.safeAreaInset(edge: .top, spacing: 0) {
				if !unarchived, (conversations.conversation(id: conversationID)?.archived ?? chat.detail?.archived) == true {
					ArchivedChatBar {
						Task {
							if await conversations.setArchived(conversationID, false) {
								unarchived = true
								await conversations.refresh()
							}
						}
					}
				}
			}
			.sheet(isPresented: $showParticipants, onDismiss: { inviting = false }) {
				PeopleSheet(chat: chat, conversations: conversations, startAdding: inviting, onLeft: onLeft)
				.presentationDetents([.medium, .large])
			}
	}
}
