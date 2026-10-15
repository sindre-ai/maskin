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
			stories: appRuntime.storiesStore(), wide: isWide
		)
		.shellToolbar(
			environment: environment, title: "For you",
			actions: ShellActions(
				live: true, display: ShellDisplayMenu { displayMenu })
		)
		.task(id: environment.workspaceId) {
			async let feed: Void = runtime.store.load()
			async let stories: Void = appRuntime.storiesStore()?.load() ?? ()
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

	/// The Display menu: which kind of card to show, and taking every suggested option. That acts on
	/// the store's per-card path, so each card stays individually undoable.
	@ViewBuilder private var displayMenu: some View {
		let store = runtime.store
		if !store.typeCounts.isEmpty {
			Picker(
				"Show",
				selection: Binding(
					get: { store.options.typeFilter }, set: { store.options.typeFilter = $0 })
			) {
				Text("Everything").tag(String?.none)
				ForEach(store.typeCounts, id: \.type) { item in
					Text("\(ObjectTypeCatalog.pluralLabel(for: item.type, displayName: store.typeLabel(for: item.type))) \(item.count)").tag(String?.some(item.type))
				}
			}
		}
		Button("Take every suggested", systemImage: "checkmark.circle") { store.takeSuggestedOptions() }
			.disabled(store.suggestedOptionCount == 0)
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
			files: files, briefing: APISpokenBriefing(client: environment.client, workspaceID: workspace),
			readerName: { [weak environment] in environment?.auth.session?.name })
		current = (workspace, store)
		return store
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
	/// rows). Compact width is the one-column list.
	var wide = false
	@State private var openStory: StoryCard?
	/// The card holding keyboard focus on iPad; mirrored to `AppRuntime.forYouSelection` so Return
	/// (and the Go menu item) can accept its recommended option.
	@FocusState private var focusedCard: String?
	@Environment(AppRuntime.self) private var shellRuntime: AppRuntime?
	/// Width of the feed, to pick the briefing card size with or without the sidebar open.
	@State private var feedWidth: CGFloat = 0
	/// Which cards the reader opened with Ask; the rest stay compact.
	@State private var expansion = CardExpansion()
	/// Frozen "now" for snapshots; live screens pass nil.
	var fixedNow: Date?

	@Environment(\.scenePhase) private var scenePhase
	@State private var openedAt = Date()
	@AppStorage("forYou.swipeHintSeen") private var swipeHintSeen = false

	private let readableWidth: CGFloat = 680
	/// Feed side padding on the wide feed (4-iPad.md: 36 to 40).
	private let wideInset: CGFloat = MaskinSpace.s13 + MaskinSpace.s4
	private var rowWidth: CGFloat { wide ? wideMaxWidth : readableWidth }
	private var rowInset: CGFloat { wide ? wideInset : MaskinSpace.s9 }
	/// Gap between the two columns of decision cards on the wide feed.
	private let columnGap: CGFloat = MaskinSpace.s12
	/// The wide feed fills the window up to this width (the cards must not stretch past reading size).
	private let wideMaxWidth: CGFloat = 1200
	/// Below this feed width the sidebar is taking room: briefing cards shrink to 150.
	private let sidebarFeedWidth: CGFloat = 780

	var body: some View {
		let entries = store.entries
		let animationKey = entries.map { "\($0.id)-\($0.bucket.rawValue)" }
		let cardIDs = entries.map { $0.card.id }
		presentations(
			feedList(entries: entries)
			.onChange(of: focusedCard) { _, id in if wide { shellRuntime?.forYouSelection = id } }
			.refreshable { await store.refresh() }
			.animation(store.isFetching ? nil : MaskinMotion.standard, value: animationKey)
			.onChange(of: cardIDs) { _, ids in expansion.prune(keeping: Set(ids)) }
			.onChange(of: scenePhase) { _, phase in
				switch phase {
				case .active: outbox.appDidBecomeActive()
				case .background: store.decisions.commitHeld()
				default: break
				}
			}
		)
	}

	private func feedList(entries: [FeedEntry]) -> some View {
		List {
			if let stories, !stories.cards.isEmpty {
				StoryRow(stories: stories, open: { card in openStory = card }, metrics: storyMetrics)
				.listRowSeparator(.hidden)
				.listRowBackground(Color.clear)
				.listRowInsets(EdgeInsets(top: MaskinSpace.s3, leading: rowInset, bottom: MaskinSpace.s3, trailing: rowInset))
			}
			headerRows(entries: entries)
			feedRows(entries: entries)
		}
		.listStyle(.plain)
		.scrollContentBackground(.hidden)
		.ambientBackground()
		.background(
			GeometryReader { proxy in
				Color.clear.onChange(of: proxy.size.width, initial: true) { _, width in feedWidth = width }
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
					sequence: BriefSequence.make(cards: stories.cards, opening: card)
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
	}

	/// Briefing cards: 124 wide on compact, 204 on iPad, 150 when the sidebar takes room (4-iPad.md).
	private var storyMetrics: StoryCardMetrics {
		guard wide else { return .compact }
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

	// MARK: Rows

	@ViewBuilder
	private func feedRows(entries: [FeedEntry]) -> some View {
		switch store.phase {
		case .idle, .loading:
			LoadingSkeleton(rows: 3).modifier(ReadableRow(width: rowWidth, inset: rowInset))
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load your feed", message: message) {
				Button("Try again") { Task { await store.load() } }.buttonStyle(.secondaryAction)
			}
			.modifier(ReadableRow(width: rowWidth, inset: rowInset))
		case .loaded:
			if entries.isEmpty {
				CaughtUp(filtered: store.options.typeFilter != nil)
					.modifier(ReadableRow(width: rowWidth, inset: rowInset))
			} else {
				if !wide { swipeHint }
				ForEach(groups(of: entries), id: \.bucket) { group in
					// The primary group is the feed itself: the design shows no header above it.
					if group.bucket != .needs {
						SectionHeader(
							title: title(for: group.bucket), count: group.entries.count,
							action: group.bucket == .fyi ? ("Mark all read", { store.dismissAllFYIs() }) : nil
						)
						.modifier(ReadableRow(width: rowWidth, inset: rowInset))
					}
					if wide {
						ForEach(pairs(of: group.entries)) { pair in wideRow(pair) }
					} else {
						ForEach(group.entries) { entry in feedRow(entry) }
					}
				}
			}
		}
	}

	private func groups(of entries: [FeedEntry]) -> [(bucket: FeedBucket, entries: [FeedEntry])] {
		FeedBucket.allCases.compactMap { bucket in
			let inBucket = entries.filter { $0.section == bucket }
			return inBucket.isEmpty ? nil : (bucket, inBucket)
		}
	}

	private func title(for bucket: FeedBucket) -> String {
		switch bucket {
		case .needs: "Needs you"
		case .waiting: "Waiting on an agent"
		case .fyi: "Updates for you"
		case .done: "Done just now"
		}
	}

	/// One-time explanation of the two swipes, which nothing else on the card hints at.
	@ViewBuilder private var swipeHint: some View {
		if !swipeHintSeen {
			HStack(alignment: .top, spacing: MaskinSpace.s4) {
				Image(systemName: "hand.draw").accessibilityHidden(true)
				Text("Swipe right to accept the recommended option, left to mark read.")
					.maskinText(.subhead)
				Spacer(minLength: 0)
				Button("Got it") { withAnimation(MaskinMotion.standard) { swipeHintSeen = true } }
					.maskinText(.subhead).fontWeight(.semibold)
					.frame(minHeight: MaskinSpace.touchMin)
			}
			.foregroundStyle(MaskinColor.ink4)
			.modifier(ReadableRow(width: rowWidth, inset: rowInset))
		}
	}

	/// Two decision cards side by side, each (feed - gap) / 2 wide, tops aligned.
	private func wideRow(_ pair: EntryPair) -> some View {
		HStack(alignment: .top, spacing: columnGap) {
			wideCell(pair.first)
			if let second = pair.second {
				wideCell(second)
			} else {
				Color.clear.frame(maxWidth: .infinity).accessibilityHidden(true)
			}
		}
		.modifier(ReadableRow(width: rowWidth, inset: rowInset))
	}

	/// One card in the grid. It takes keyboard focus; Return takes the recommended option when that
	/// can be undone (a card that needs a confirmation keeps it on the card).
	private func wideCell(_ entry: FeedEntry) -> some View {
		card(entry)
			.frame(maxWidth: .infinity, alignment: .top)
			.focusable()
			.focused($focusedCard, equals: entry.id)
			.onKeyPress(.return) {
				guard entry.record == nil, let option = entry.card.decision?.recommended,
					!option.destructive
				else { return .ignored }
				DecisionCardView.Actions.live(store: store, entry: entry, openObject: openObject)
					.choose(option)
				return .handled
			}
			.contextMenu {
				if entry.record == nil {
					Button("Mark read", systemImage: "checkmark") { dismiss(entry) }
				}
			}
	}

	private func pairs(of entries: [FeedEntry]) -> [EntryPair] {
		stride(from: 0, to: entries.count, by: 2).map {
			EntryPair(first: entries[$0], second: $0 + 1 < entries.count ? entries[$0 + 1] : nil)
		}
	}

	private func feedRow(_ entry: FeedEntry) -> some View {
		card(entry)
			.modifier(ReadableRow(width: rowWidth, inset: rowInset))
			.swipeActions(edge: .leading, allowsFullSwipe: true) {
				// Swipe right to take the agent's recommendation. Options that can't be undone
				// are never one swipe away: they keep their confirmation on the card.
				if entry.record == nil, let option = entry.card.decision?.recommended,
					!option.destructive
				{
					Button {
						DecisionCardView.Actions.live(store: store, entry: entry, openObject: openObject)
							.choose(option)
					} label: {
						Label(option.label, systemImage: "checkmark")
					}
					.tint(MaskinColor.doneFg)
				}
			}
			.swipeActions(edge: .trailing, allowsFullSwipe: true) {
				if entry.record == nil {
					Button {
						dismiss(entry)
					} label: {
						Label("Mark read", systemImage: "checkmark")
					}
					.tint(MaskinColor.doneFg)
				}
			}
	}

	private func card(_ entry: FeedEntry) -> some View {
		var actions = DecisionCardView.Actions.live(store: store, entry: entry, openObject: openObject)
		let id = entry.card.id
		if wide {
			// The Chief of Staff thread opens in a form sheet; the card stays compact behind it.
			actions.expand = { Task { await chief?.openThread(card: entry.card) } }
		} else {
			actions.expand = { withAnimation(MaskinMotion.standard) { expansion.expand(id) } }
			actions.collapse = { withAnimation(MaskinMotion.standard) { expansion.collapse(id) } }
		}
		return DecisionCardView(
			entry: entry, sender: store.senderName(of: entry.card),
			expanded: !wide && expansion.isManuallyExpanded(id), now: fixedNow ?? Date(),
			actions: actions, chief: chief, threadInDetail: wide,
			typeLabel: store.typeLabel(for:))
			.maskinHover(.lift, cornerRadius: MaskinRadius.brief)
	}

	/// The compact card shown inside the iPad Ask sheet, live from the same store entry.
	private func sheetCard(for id: String) -> AnyView? {
		guard let entry = store.entries.first(where: { $0.id == id }) else { return nil }
		var actions = DecisionCardView.Actions.live(store: store, entry: entry, openObject: openObject)
		actions.expand = nil
		actions.collapse = nil
		return AnyView(
			DecisionCardView(
				entry: entry, sender: store.senderName(of: entry.card), expanded: false,
				now: fixedNow ?? Date(), actions: actions, chief: nil, threadInDetail: true,
				typeLabel: store.typeLabel(for:)))
	}

	private func dismiss(_ entry: FeedEntry) {
		MaskinHaptics.play(.selection)
		withAnimation(MaskinMotion.standard) { store.dismiss(entry.card) }
	}
}

// MARK: - Pieces

/// A row of the wide feed: one or two decision cards.
private struct EntryPair: Identifiable {
	let first: FeedEntry
	let second: FeedEntry?
	var id: String { first.id }
}

/// A quiet label above each group of cards, with its count and an optional bulk action.
private struct SectionHeader: View {
	let title: String
	let count: Int
	var action: (title: String, run: () -> Void)?

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			Text(title).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
			Text("\(count)").maskinText(.subhead).foregroundStyle(MaskinColor.ink5)
			Spacer(minLength: MaskinSpace.s3)
			if let action {
				Button(action.title, action: action.run)
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.frame(minHeight: MaskinSpace.touchMin)
			}
		}
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}
}

private struct ReadableRow: ViewModifier {
	let width: CGFloat
	var inset: CGFloat = MaskinSpace.s9

	func body(content: Content) -> some View {
		content
			.frame(maxWidth: width)
			.frame(maxWidth: .infinity)
			.listRowSeparator(.hidden)
			.listRowBackground(Color.clear)
			.listRowInsets(EdgeInsets(top: MaskinSpace.s3, leading: inset, bottom: MaskinSpace.s3, trailing: inset))
	}
}

/// "You're caught up": the feed is genuinely empty.
struct CaughtUp: View {
	var filtered = false

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
			Text(
				filtered
					? "Nothing in your feed matches this filter."
					: "Nothing needs you right now. The flows keep running \u{2014} you'll hear when one does."
			)
			.maskinText(.body).foregroundStyle(MaskinColor.ink4).multilineTextAlignment(.center)
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
