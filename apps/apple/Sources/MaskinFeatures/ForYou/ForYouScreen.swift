import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The For you tab: what the agents need from you, most important first. Owns its
/// `NavigationStack` and the shell toolbar.
///
/// `openObject` is the hook for the Objects slice: called with an object id when the reader opens
/// the thing a card is about. Without it the object name is plain text.
public struct ForYouScreen: View {
	private let environment: AppEnvironment
	private let openObject: ((String) -> Void)?
	@Environment(AppRuntime.self) private var appRuntime
	@Environment(\.horizontalSizeClass) private var sizeClass

	public init(environment: AppEnvironment, openObject: ((String) -> Void)? = nil) {
		self.environment = environment
		self.openObject = openObject
	}

	/// Owned by `AppRuntime`; reading it is free and has no side effects.
	private var runtime: ForYouRuntime { appRuntime.forYou }

	/// Regular width (iPad, Mac, any wide window) is one wide feed: briefing row, two columns of
	/// decision cards. Never a third pane: an object pushes over the feed, Ask opens a form sheet.
	/// Compact width keeps one column and opens objects in a sheet.
	private var isWide: Bool { sizeClass == .regular }

	@State private var path: [String] = []
	/// The Undo toast: shared by the cards' gestures and the ⋯ menu's "Take every suggested".
	@State private var undoOffer: UndoOffer?
	@State private var showDisplay = false

	public var body: some View {
		NavigationStack(path: $path) {
			feed(openObject: isWide ? { path.append($0) } : openObject)
				.navigationDestination(for: String.self) { id in
					ForYouObjectDetail(environment: environment, objectId: id) { path.append($0) }
				}
		}
	}

	private func feed(openObject: ((String) -> Void)?) -> some View {
		ForYouFeedView(
			store: runtime.store, outbox: runtime.outbox,
			openObject: openObject, chief: runtime.chief, environment: environment,
			stories: appRuntime.storiesStore(), wide: isWide, undoOffer: $undoOffer,
			openAgent: { appRuntime.openAgent($0) },
			greetingName: environment.auth.session?.name
		)
		.shellToolbar(
			environment: environment,
			actions: ShellActions(
				live: true, displaySymbol: ShellActions.slidersSymbol,
				displayActive: !runtime.store.options.isDefaultDisplay,
				displayToggle: { showDisplay = true })
		)
		.sheet(isPresented: $showDisplay) { ForYouDisplaySheet(store: runtime.store) }
		.task(id: environment.workspaceId) {
			Perf.event("foryou.screen.task")
			async let feed: Void = runtime.store.load()
			async let stories: Void = appRuntime.storiesStore()?.loadCompletely() ?? ()
			async let names: Void = loadTypeNames()
			_ = await (feed, stories, names)
		}
	}

	/// The workspace schema's type names, so footers read "Flow" or a custom type's own name.
	private func loadTypeNames() async {
		guard environment.auth.session != nil else { return }
		let auth = environment.auth
		let directory = ObjectsDirectory(
			remote: APIObjectsRemote(client: environment.client, credentials: auth.credentialsProvider),
			workspaceId: { auth.session?.workspaceId })
		await directory.load()
		runtime.store.typeDisplayNames = directory.schema.displayNames
	}
}

/// Builds the story store for the current workspace and keeps it until the workspace changes.
@MainActor
final class StoriesProvider {
	private var current: (workspace: String, store: StoriesStore)?

	func store(for environment: AppEnvironment) -> StoriesStore? {
		guard let workspace = environment.workspaceId else { return nil }
		if let current, current.workspace == workspace { return current.store }
		let credentials = environment.auth.credentialsProvider
		let files = APIFilesRemote(client: environment.client, credentials: credentials)
		let store = StoriesStore(
			loops: APILoopsSource(
				client: environment.client, workspaceID: workspace,
				objects: APIObjectsRemote(client: environment.client, credentials: credentials),
				files: files),
			files: files, briefing: nil, cache: environment.snapshotCache)
		current = (workspace, store)
		return store
	}
}

/// Reloads the briefing row without a screen: the background refresh calls it so the saved row is
/// current when For you opens. Best effort, like the rest of the story load.
public enum BackgroundStories {
	@MainActor
	public static func refresh(environment: AppEnvironment) async {
		await StoriesProvider().store(for: environment)?.loadCompletely(attempts: 1)
	}
}

/// The feed itself, driven by plain stores so previews and snapshots can host it without an
/// `AppEnvironment`.
struct ForYouFeedView: View {
	@Bindable var store: ForYouStore
	let outbox: Outbox
	var openObject: ((String) -> Void)?
	/// Replies and quick questions go to the Chief of Staff through this, opening the pop-up
	/// sheet (which needs the environment to build its chat). Nil in snapshots.
	var chief: ChiefOfStaffDesk?
	var environment: AppEnvironment?
	/// The briefing cards above the feed; nil in snapshots.
	var stories: StoriesStore?
	/// Regular width: the wide feed (two columns of decision cards, wide briefing row, no swipe
	/// rows; ↩ takes the focused card's recommended option). Compact width is the one-column list.
	var wide = false
	/// The Undo toast, owned by the screen so its ⋯ menu can offer one too.
	var undoOffer: Binding<UndoOffer?> = .constant(nil)
	/// Opens the agent behind "with {agent}". Nil in snapshots.
	var openAgent: ((String) -> Void)?
	@State private var openStory: StoryCard?
	/// The draft a card's pointer line asked to scroll to; cleared once the list has moved.
	@State private var draftToShow: String?
	/// Which cards the reader opened with Discuss; the rest stay compact.
	/// Width of the feed, to pick the briefing card size with or without the sidebar open.
	@State private var feedWidth: CGFloat = 0
	@State private var expansion = CardExpansion()
	/// "Take every suggested option?" is asking for confirmation.
	@State private var confirmTakeSuggested = false
	/// Frozen "now" for snapshots; live screens pass nil.
	var fixedNow: Date?
	/// Whose greeting heads the feed; nil in snapshots.
	var greetingName: String?

	@Environment(\.scenePhase) private var scenePhase
	@State private var openedAt = Date()

	private let readableWidth: CGFloat = 680
	/// Compact width reads as a 680 pt column; the wide feed uses the full width (4-iPad.md).
	private var rowWidth: CGFloat { wide ? .infinity : readableWidth }
	/// Row side padding: 16 on iPhone, 36 in the wide feed (spec: 36 to 40).
	private var rowInset: CGFloat { wide ? MaskinSpace.s14 + MaskinSpace.s2 : MaskinSpace.s9 }
	/// Below this feed width the sidebar is taking room: briefing cards shrink to 150.
	private let sidebarFeedWidth: CGFloat = 780

	private static let topId = "forYou.top"
	/// The scroll id of a draft's row under Drafts to review.
	static func draftRowId(_ objectId: String) -> String { "forYou.draft.\(objectId)" }
	private static let intents: [ForYouIntent?] = [nil] + ForYouIntent.allCases

	var body: some View {
		let entries = store.entries
		let layoutKey: [String] = entries.map { "\($0.id)-\($0.bucket.rawValue)" }
		let cardIds: [String] = entries.map { $0.card.id }
		presentations(
			ScrollViewReader { proxy in
				List {
					Color.clear.frame(height: 0).id(Self.topId)
						.listRowSeparator(.hidden).listRowBackground(Color.clear)
						.listRowInsets(EdgeInsets())
					ForYouGreetingView(text: ForYouHeader.greeting(name: greetingName, at: fixedNow ?? Date()))
					.modifier(ReadableRow(width: rowWidth, inset: rowInset))
					if let stories, !stories.cards.isEmpty {
						StoryRow(stories: stories, open: { card in openStory = card }, metrics: storyMetrics)
						.listRowSeparator(.hidden)
						.listRowBackground(Color.clear)
						.listRowInsets(EdgeInsets(top: MaskinSpace.s3, leading: rowInset, bottom: MaskinSpace.s3, trailing: rowInset))
					}
					if store.options.filterBarOn { intentPills }
					headerRows(entries: entries)
					feedRows(entries: entries)
				}
				.listStyle(.plain)
				// The zero-height scroll anchor above is still a list row: without this it is padded to
				// the 44 pt default and pushes the sentence down, away from the title.
				.environment(\.defaultMinListRowHeight, 0)
				.scrollDismissesKeyboard(.interactively)
				.scrollContentBackground(.hidden)
				.ambientBackground()
				.background(
					GeometryReader { geometry in
						Color.clear.onChange(of: geometry.size.width, initial: true) { _, width in feedWidth = width }
					}
				)
				.refreshable {
					async let feed: Void = store.refresh()
					async let rail: Void = stories?.load() ?? ()
					_ = await (feed, rail)
				}
				.overlay(alignment: .top) { newAsksPill(proxy: proxy) }
				.onChange(of: draftToShow) { _, objectId in
					guard let objectId else { return }
					withAnimation(MaskinMotion.standard) {
						proxy.scrollTo(Self.draftRowId(objectId), anchor: .top)
					}
					draftToShow = nil
				}
			}
			.animation(store.isFetching ? nil : MaskinMotion.standard, value: layoutKey)
			.onChange(of: cardIds) { _, ids in expansion.prune(keeping: Set(ids)) }
			.onChange(of: store.options.opening, initial: true) { _, opening in
				expansion.setStartsOpen(opening == .expanded)
			}
			.onChange(of: scenePhase) { _, phase in
				switch phase {
				case .active:
					outbox.appDidBecomeActive()
					store.later.reload()
				case .background:
					store.decisions.commitHeld()
					store.reviews?.commitHeld()
				default: break
				}
			}
		)
	}

	/// The sheet, the briefing cover and the notice alert over the feed.
	private func presentations<Content: View>(_ content: Content) -> some View {
		content
		.sheet(item: presentedBinding) { presented in
			if let chief, let environment {
				ChiefOfStaffSheet(
					environment: environment, desk: chief, presented: presented,
					card: wide ? sheetCard(for: presented.card.id) : nil
				)
				.askSheetSizing(wide: wide)
			}
		}
		.storyCover(item: $openStory) { card in
			if let environment, let stories {
				BriefViewer(
					environment: environment, stories: stories,
					sequence: BriefSequence.make(cards: stories.rowCards, opening: card)
				) { openStory = nil }
			}
		}
		.alert(
			"Chief of Staff", isPresented: Binding(get: { chief?.notice != nil }, set: { if !$0 { chief?.notice = nil } })
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(chief?.notice ?? "")
		}
		.undoToast(undoOffer)
		.confirmationDialog(
			"Take every suggested option?", isPresented: $confirmTakeSuggested, titleVisibility: .visible
		) {
			Button("Take \(store.suggestedOptionCount) suggested") { takeSuggested() }
		} message: {
			Text("Each answer is posted as your reply. You can undo them one by one.")
		}
	}

	/// Briefing cards: 128 wide on compact, 204 on iPad, 150 when the sidebar takes room (4-iPad.md).
	private var storyMetrics: StoryCardMetrics {
		guard wide else { return .forYou }
		return feedWidth > 0 && feedWidth < sidebarFeedWidth ? .regularWithSidebar : .regular
	}

	private var presentedBinding: Binding<ChiefOfStaffDesk.Presented?> {
		Binding(get: { chief?.presented }, set: { if $0 == nil { chief?.dismiss() } })
	}

	// MARK: Header

	@ViewBuilder
	private func headerRows(entries: [FeedEntry]) -> some View {
		Group {
			ForEach(outbox.failures.filter { $0.at < openedAt }) { failure in
				FailureRow(summary: failure.summary, message: failure.message) {
					outbox.dismissFailure(failure.id)
				}
			}
		}
		.modifier(ReadableRow(width: rowWidth, inset: rowInset))
	}

	/// The intent filter under the briefs: All, Approvals, Questions, Blocking. A kind with
	/// nothing in it is left out.
	private var intentPills: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s3 + 1) {
				ForEach(Self.intents, id: \.self) { intent in
					let count = store.intentCount(intent)
					if intent == nil || count > 0 || store.options.intent == intent {
						let selected = store.options.intent == intent
						Button {
							withAnimation(MaskinMotion.standard) { store.options.intent = intent }
						} label: {
							HStack(spacing: MaskinSpace.s3) {
								Text(intent?.label ?? "All").font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
								Text("\(count)").font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .medium)).opacity(0.6)
							}
							.foregroundStyle(selected ? MaskinSurface.onInverse : MaskinColor.ink2)
							.padding(.horizontal, MaskinSpace.s8 - 1)
							.frame(height: 34)
							.background(selected ? MaskinSurface.inverse : MaskinSurface.card, in: Capsule())
							.frame(minHeight: MaskinSpace.touchMin)
							.contentShape(Rectangle())
						}
						.buttonStyle(.maskinPressed)
						.accessibilityAddTraits(selected ? .isSelected : [])
					}
				}
			}
		}
		.scrollClipDisabled()
		.listRowSeparator(.hidden)
		.listRowBackground(Color.clear)
		.listRowInsets(EdgeInsets(top: 0, leading: rowInset, bottom: 0, trailing: rowInset))
	}

	/// "N new asks": new asks wait here instead of landing above the card under the reader's thumb.
	@ViewBuilder private func newAsksPill(proxy: ScrollViewProxy) -> some View {
		let count = store.pendingNewCount
		if count > 0 {
			Button {
				MaskinHaptics.play(.selection)
				withAnimation(MaskinMotion.standard) {
					store.showNew()
					proxy.scrollTo(Self.topId, anchor: .top)
				}
			} label: {
				HStack(spacing: MaskinSpace.s3) {
					Image(systemName: "arrow.up").maskinSymbol(MaskinFontSize.t13, weight: .bold).accessibilityHidden(true)
					Text("\(count) new \(count == 1 ? "ask" : "asks") \u{00B7} Show")
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
				}
				.foregroundStyle(MaskinSurface.onInverse)
				.padding(.horizontal, MaskinSpace.s9)
				.frame(height: 38)
				.background(MaskinSurface.inverse, in: Capsule())
				.shadow(color: MaskinPatina.cardShadow, radius: 10, y: 6)
				.frame(minHeight: MaskinSpace.touchMin)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed(.shrink))
			.padding(.top, MaskinSpace.s2)
			.transition(.move(edge: .top).combined(with: .opacity))
			.accessibilityHint("Shows the new asks at the top of the list")
		}
	}

	// MARK: Rows

	@ViewBuilder
	private func feedRows(entries: [FeedEntry]) -> some View {
		switch store.phase {
		case .idle, .loading:
			// Cached cards draw in the first frame, so a skeleton only matters for a cold, empty
			// feed, and only once it has taken longer than 300ms.
			DelayedSkeleton(after: .milliseconds(300)).modifier(ReadableRow(width: rowWidth, inset: rowInset))
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load your feed", message: message) {
				Button("Try again") { Task { await store.load() } }.buttonStyle(.secondaryAction)
			}
			.modifier(ReadableRow(width: rowWidth, inset: rowInset))
		case .loaded:
			let open = entries.filter { $0.bucket != .done }
			// "Needs you N" with its ⋯ menu heads the primary group (v3). Related approvals are
			// folded into one card inside it.
			needsHeader
			needsRows(store.needsItems)
			if open.isEmpty {
				CaughtUp(
					filtered: store.options.intent != nil, detail: store.caughtUpDetail
				)
				.modifier(ReadableRow(width: rowWidth, inset: rowInset))
			} else {
				ForEach(groups(of: open).filter { $0.bucket != .needs }, id: \.bucket) { group in
					SectionHeader(
						title: title(for: group.bucket),
						action: group.bucket == .fyi ? ("Mark all read", { store.dismissAllFYIs() }) : nil
					)
					.modifier(ReadableRow(width: rowWidth, inset: rowInset))
					if wide {
						decisionGrid(group.entries)
					} else {
						ForEach(group.entries) { entry in feedRow(entry) }
					}
				}
			}
			draftsSection
			laterSection
			handledSection(entries.filter { $0.bucket == .done })
		}
	}

	/// "Needs you 5" with the ⋯ menu: take every suggested option, dismiss all updates.
	@ViewBuilder private var needsHeader: some View {
		let count = store.needsCount
		if count > 0 {
			SectionHeader(
				title: "Needs you",
				menu: [
					store.suggestedOptionCount > 0
						? ("Take every suggested option", { confirmTakeSuggested = true }) : nil,
					store.entries.contains { $0.bucket == .fyi }
						? ("Dismiss all updates", { store.dismissAllFYIs() }) : nil,
				].compactMap { $0 }
			)
			.modifier(ReadableRow(width: rowWidth, inset: rowInset))
		}
	}

	private func takeSuggested() {
		MaskinHaptics.play(.success)
		let batch = withAnimation(MaskinMotion.standard) { store.takeSuggestedOptions() }
		offerUndo(batch.summary) { withAnimation(MaskinMotion.standard) { store.undo(batch) } }
	}

	private func groups(of entries: [FeedEntry]) -> [(bucket: FeedBucket, entries: [FeedEntry])] {
		FeedBucket.allCases.compactMap { bucket in
			let inBucket = entries.filter { $0.section == bucket }
			return inBucket.isEmpty ? nil : (bucket, inBucket)
		}
	}

	/// The "Needs you" list: cards and groups of related approvals, in the order the feed ranked them.
	/// Wide: groups take the full width above the two columns of cards.
	@ViewBuilder
	private func needsRows(_ items: [FeedItem]) -> some View {
		if wide {
			ForEach(items.compactMap(\.groupValue)) { group in groupRow(group) }
			let cards = items.compactMap(\.cardEntry)
			if !cards.isEmpty { decisionGrid(cards) }
		} else {
			ForEach(items) { item in
				switch item {
				case .card(let entry): feedRow(entry)
				case .group(let group): groupRow(group)
				}
			}
		}
	}

	private func groupRow(_ group: ApprovalGroup) -> some View {
		let count = group.openCount
		return ApprovalGroupCard(
			group: group, typeLabel: store.typeLabel(for: group.objectType),
			undoableCount: store.undoableCount(group),
			approveOne: { card in
				MaskinHaptics.play(.success)
				_ = withAnimation(MaskinMotion.standard) { store.approveFromGroup(card) }
				AccessibilityNotification.Announcement("Approved. Undo is available for a few seconds.").post()
			},
			approveAll: {
				MaskinHaptics.play(.success)
				_ = withAnimation(MaskinMotion.standard) { store.approveAll(in: group) }
				AccessibilityNotification.Announcement("Approved all \(count). Undo is available for a few seconds.").post()
			},
			undo: {
				MaskinHaptics.play(.selection)
				withAnimation(MaskinMotion.standard) { store.undo(group) }
			}
		)
		.modifier(ReadableRow(width: rowWidth, inset: rowInset))
	}

	/// DRAFTS TO REVIEW: messages the agents wrote, to read, edit and approve here. Hidden when there
	/// are none. A draft that was approved turns into a receipt in the same place.
	@ViewBuilder private var draftsSection: some View {
		if let reviews = store.reviews {
			let drafts = store.reviewDrafts
			let receipts = reviews.receiptDrafts
			if !drafts.isEmpty {
				SectionHeader(title: "Drafts to review")
				.modifier(ReadableRow(width: rowWidth, inset: rowInset))
				ForEach(drafts) { draft in
					EditableDraftCard(draft: draft, store: reviews)
						.modifier(ReadableRow(width: rowWidth, inset: rowInset))
						.id(Self.draftRowId(draft.objectId))
				}
			}
			ForEach(receipts) { draft in
				DraftReceiptStrip(draft: draft, store: reviews)
					.modifier(ReadableRow(width: rowWidth, inset: rowInset))
			}
		}
	}

	private func title(for bucket: FeedBucket) -> String {
		switch bucket {
		case .needs: "Needs you"
		case .waiting: "Waiting on an agent"
		case .fyi: "Updates for you"
		case .done: "Handled today"
		}
	}

	/// LATER: asks the reader deferred, each with Bring back.
	@ViewBuilder private var laterSection: some View {
		let deferred = store.laterEntries
		if !deferred.isEmpty {
			SectionHeader(title: "Later")
				.modifier(ReadableRow(width: rowWidth, inset: rowInset))
			SummaryList {
				ForEach(deferred) { entry in
					SummaryRow(
						mark: .later, label: Self.objectName(of: entry.card),
						detail: "Later \u{00B7} \(store.later.entry(for: entry.id)?.label ?? "")",
						open: openObject.map { open in { open(entry.card.id) } },
						trailing: .button("Bring back") {
							MaskinHaptics.play(.selection)
							withAnimation(MaskinMotion.standard) { store.bringBack(entry.card) }
						})
				}
			}
			.modifier(ReadableRow(width: rowWidth, inset: rowInset))
		}
	}

	/// HANDLED TODAY: what the reader decided this sitting, one line each, with Undo while it can
	/// still be taken back.
	@ViewBuilder private func handledSection(_ handled: [FeedEntry]) -> some View {
		let rows = handled.compactMap { entry in
			HandledSummary.make(for: entry, sender: store.senderName(of: entry.card)).map { (entry, $0) }
		}
		if !rows.isEmpty {
			SectionHeader(title: "Handled today")
				.modifier(ReadableRow(width: rowWidth, inset: rowInset))
			SummaryList {
				ForEach(rows, id: \.0.id) { entry, summary in
					SummaryRow(
						mark: summary.mark == .done ? .done : (summary.mark == .held ? .held : .queued),
						label: summary.label, detail: summary.detail,
						open: openObject.map { open in { open(entry.card.id) } },
						trailing: summary.canUndo
							? .button("Undo") {
								MaskinHaptics.play(.selection)
								withAnimation(MaskinMotion.standard) { _ = store.undo(entry.card) }
							} : .none)
				}
			}
			.modifier(ReadableRow(width: rowWidth, inset: rowInset))
		}
	}

	private static func objectName(of card: ForYouCard) -> String {
		let title = card.objectTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return title.isEmpty ? card.headline : title
	}

	private func offerUndo(_ message: String, _ undo: @escaping @MainActor () async -> Void) {
		undoOffer.wrappedValue = UndoOffer(message: message, undo: undo)
	}

	private func feedRow(_ entry: FeedEntry) -> some View {
		card(entry)
			.modifier(ReadableRow(width: rowWidth, inset: rowInset, vertical: 0))
			.swipeActions(edge: .leading, allowsFullSwipe: true) {
				// Swipe right takes the agent's recommendation (the mockup says Done; the owner
				// kept "accept recommended"). Options that can't be undone are never one swipe
				// away: they keep their confirmation on the card. A plain mention has no options,
				// so there the swipe is Done (mark read).
				if entry.record == nil {
					if let option = entry.card.decision?.recommended, !option.destructive,
						!store.isSendHeldBack(option, on: entry.card)
					{
						Button {
							liveActions(entry).choose(option)
						} label: {
							Label(option.label, systemImage: "checkmark")
						}
						.tint(MaskinColor.doneFg)
					} else if entry.card.kind == .thread {
						Button {
							liveActions(entry).dismiss()
						} label: {
							Label("Done", systemImage: "checkmark")
						}
						.tint(MaskinColor.doneFg)
					}
				}
			}
	}

	private func liveActions(_ entry: FeedEntry) -> DecisionCardView.Actions {
		DecisionCardView.Actions.live(
			store: store, entry: entry, openObject: openObject, offerUndo: offerUndo)
	}

	/// Wide feed: two columns of cards, top aligned, one row per bucket. (width - gap) / 2 each.
	private func decisionGrid(_ entries: [FeedEntry]) -> some View {
		LazyVGrid(
			columns: Array(
				repeating: GridItem(.flexible(), spacing: MaskinSpace.s12, alignment: .top), count: 2),
			alignment: .center, spacing: MaskinSpace.s12
		) {
			ForEach(entries) { entry in
				card(entry).frame(maxWidth: .infinity, alignment: .top)
			}
		}
		.modifier(ReadableRow(width: rowWidth, inset: rowInset))
	}

	private func card(_ entry: FeedEntry) -> AnyView {
		var actions = liveActions(entry)
		let id = entry.card.id
		let agent = store.agent(of: entry.card)
		actions.showDraft = { draftToShow = $0 }
		if wide {
			// The Chief of Staff thread opens in a form sheet; the card stays compact behind it.
			actions.expand = { Task { await chief?.openThread(card: entry.card, agent: agent) } }
		} else {
			actions.expand = { withAnimation(MaskinMotion.standard) { expansion.expand(id) } }
			actions.collapse = { withAnimation(MaskinMotion.standard) { expansion.collapse(id) } }
		}
		if let agent, let openAgent { actions.openAgent = { openAgent(agent.id) } }
		let view = DecisionCardView(
			entry: entry, sender: store.senderName(of: entry.card),
			expanded: !wide && expansion.isManuallyExpanded(id), style: wide ? .card : .row,
			now: fixedNow ?? Date(),
			actions: actions, chief: chief, threadInDetail: wide, agent: agent,
			acceptsReturnKey: wide,
			typeLabel: store.typeLabel(for:), draftIsElsewhere: { entry.bucket == .needs && entry.record == nil && store.isInStrip($0) },
			unsentEditNote: entry.bucket == .needs && entry.record == nil ? store.unsentEditNote(for: entry.card) : nil)
		// Cards lift under a pointer; flat rows have nothing to lift.
		return wide ? AnyView(view.maskinHover(.lift, cornerRadius: MaskinRadius.brief)) : AnyView(view)
	}

	/// The compact card shown inside the iPad Discuss sheet, live from the same store entry.
	private func sheetCard(for id: String) -> AnyView? {
		guard let entry = store.entries.first(where: { $0.id == id }) else { return nil }
		var actions = liveActions(entry)
		actions.expand = nil
		actions.collapse = nil
		return AnyView(
			DecisionCardView(
				entry: entry, sender: store.senderName(of: entry.card), expanded: false,
				now: fixedNow ?? Date(), actions: actions, chief: nil, threadInDetail: true,
				agent: store.agent(of: entry.card), typeLabel: store.typeLabel(for:)))
	}
}

// MARK: - Pieces

/// The heading above each group of cards: 24 pt bold on one line, 40 pt above, with an optional
/// action link in the accent colour and a ⋯ menu at the trailing edge (Needs you: bulk actions).
private struct SectionHeader: View {
	let title: String
	var action: (title: String, run: () -> Void)?
	var menu: [(title: String, run: () -> Void)] = []

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			Text(title)
				.font(MaskinTypeface.sans(MaskinFontSize.t24, weight: .bold, relativeTo: .title2))
				.tracking(-0.035 * MaskinFontSize.t24)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
				.fixedSize(horizontal: true, vertical: false)
				.layoutPriority(1)
			Spacer(minLength: MaskinSpace.s3)
			if let action {
				Button(action.title, action: action.run)
					.maskinText(.body).fontWeight(.medium).foregroundStyle(MaskinColor.accent)
					.frame(minHeight: MaskinSpace.touchMin)
			}
			if !menu.isEmpty {
				Menu {
					ForEach(Array(menu.enumerated()), id: \.offset) { _, item in
						Button(item.title, action: item.run)
					}
				} label: {
					Image(systemName: "ellipsis")
						.maskinSymbol(MaskinFontSize.t18, weight: .bold)
						.foregroundStyle(MaskinColor.ink)
						.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin, alignment: .trailing)
						.contentShape(Rectangle())
				}
				.accessibilityLabel("More for \(title)")
			}
		}
		.padding(.top, MaskinSpace.s14 + MaskinSpace.s4)
		.accessibilityElement(children: .contain)
		.accessibilityAddTraits(.isHeader)
	}
}

private struct ReadableRow: ViewModifier {
	let width: CGFloat
	var inset: CGFloat = MaskinSpace.s9
	/// Space above and below the row; flat decision rows pass 0 and draw their own hairline.
	var vertical: CGFloat = MaskinSpace.s3

	func body(content: Content) -> some View {
		content
			.frame(maxWidth: width)
			.frame(maxWidth: .infinity)
			.listRowSeparator(.hidden)
			.listRowBackground(Color.clear)
			.listRowInsets(EdgeInsets(top: vertical, leading: inset, bottom: vertical, trailing: inset))
	}
}

/// "You're caught up": the feed is genuinely empty.
struct CaughtUp: View {
	var filtered = false
	/// Under "You're caught up": who is carrying on because of the reader's calls. Nil says nothing.
	var detail: String?

	var body: some View {
		VStack(spacing: MaskinSpace.s7) {
			Image(systemName: "checkmark")
				.maskinSymbol(MaskinSpace.s12, weight: .semibold)
				.foregroundStyle(ForYouPalette.receiptCheck)
				.frame(width: MaskinSpace.touchMin * 1.2, height: MaskinSpace.touchMin * 1.2)
				.background(ForYouPalette.receiptBackground, in: Circle())
				.overlay(Circle().strokeBorder(ForYouPalette.receiptBorder, lineWidth: 1))
				.accessibilityHidden(true)
			Text(filtered ? "Nothing of this kind" : "You're caught up")
				.maskinText(.title).foregroundStyle(MaskinColor.ink)
			if !filtered, let detail {
				Text(detail)
					.maskinText(.body).foregroundStyle(MaskinColor.ink4).multilineTextAlignment(.center)
			}
		}
		.frame(maxWidth: .infinity)
		.padding(MaskinSpace.s12 + MaskinSpace.s4)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s3, style: .continuous))
		.accessibilityElement(children: .combine)
	}
}

/// A write that was dropped while the app was closed.
private struct FailureRow: View {
	let summary: String
	let message: String
	let dismiss: () -> Void

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			Image(systemName: "exclamationmark.triangle.fill").accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text("Couldn't send: \(summary)").maskinText(.subhead).fontWeight(.semibold)
				Text(message).maskinText(.caption)
			}
			Spacer(minLength: 0)
			Button("Dismiss", action: dismiss).maskinText(.subhead).fontWeight(.semibold)
				.frame(minHeight: MaskinSpace.touchMin)
		}
		.foregroundStyle(ForYouPalette.failureForeground)
		.padding(MaskinSpace.s7)
		.background(ForYouPalette.failureBackground, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
				.strokeBorder(ForYouPalette.failureBorder, lineWidth: 1)
		)
		.accessibilityElement(children: .combine)
	}
}

extension View {
	/// Stories open full screen on iPhone/iPad; elsewhere a sheet.
	@ViewBuilder
	func storyCover<Item: Identifiable, Content: View>(
		item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Content
	) -> some View {
		#if os(iOS)
		fullScreenCover(item: item, content: content)
		#else
		sheet(item: item, content: content)
		#endif
	}
}

/// An object pushed over the wide feed (never a third column). Related objects push on the same stack.
struct ForYouObjectDetail: View {
	let environment: AppEnvironment
	let objectId: String
	let open: (String) -> Void

	var body: some View {
		ObjectDetailScreen(
			environment: environment, objectId: objectId, onOpenObject: open,
			decisionSection: { ObjectDecisionSection(environment: environment, objectId: objectId) }
		)
		.id(objectId)
	}
}

extension View {
	/// The Ask sheet: a centred form sheet (620 x 690, ambient wash) in regular width, detents on
	/// compact.
	@ViewBuilder
	func askSheetSizing(wide: Bool) -> some View {
		if wide {
			if #available(iOS 18, macOS 15, *) {
				self.frame(minWidth: 620, maxWidth: 620, minHeight: 690, maxHeight: 690)
					.presentationSizing(.fitted)
					.presentationCornerRadius(32)
			} else {
				self.presentationDetents([.large])
			}
		} else {
			// The Chief of Staff sheet opens at the large detent only (spec 7).
			self.presentationDetents([.large]).presentationDragIndicator(.visible)
		}
	}
}

private extension FeedItem {
	var cardEntry: FeedEntry? {
		if case .card(let entry) = self { return entry }
		return nil
	}

	var groupValue: ApprovalGroup? {
		if case .group(let group) = self { return group }
		return nil
	}
}
