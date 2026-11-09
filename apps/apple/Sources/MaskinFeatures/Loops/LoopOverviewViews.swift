import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

extension View {
	func loopCard() -> some View {
		padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(
				MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
	}
}

/// The flow page's section label: 12px mono, +0.08em, inset to line up with the cards' text.
struct FlowSectionHeader<Trailing: View>: View {
	private let title: String
	private let trailing: Trailing

	init(_ title: String, @ViewBuilder trailing: () -> Trailing) {
		self.title = title
		self.trailing = trailing()
	}

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			Text(title.uppercased())
				.maskinText(.microLabelLarge)
				.foregroundStyle(MaskinColor.ink5)
				.lineLimit(1)
			Spacer(minLength: MaskinSpace.s4)
			trailing
		}
		.padding(.horizontal, MaskinSpace.s3)
		.accessibilityElement(children: .combine)
		.accessibilityLabel(title)
		.accessibilityAddTraits(.isHeader)
	}
}

extension FlowSectionHeader where Trailing == EmptyView {
	init(_ title: String) { self.init(title) { EmptyView() } }
}

extension View {
	/// A quiet one-line note on a card (empty states).
	func loopNote() -> some View { loopCard() }
}

/// What a loop or an object produced that is worth presenting: the latest page rendered in
/// place, and any other pages or PDFs as rows. Everything opens full screen.
struct OutcomesSection: View {
	let outputs: [LoopOutput]
	/// Who they came from, named when asking for changes ("from the loop…", "from the task…").
	let sourceName: String
	/// On a flow's Outcome tab the section reads WHAT IT PRODUCES and the rows share one card;
	/// elsewhere (objects) it keeps the plain OUTCOMES header and separate rows.
	var producesStyle = false
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Environment(\.horizontalSizeClass) private var sizeClass
	@State private var presented: LoopOutput?

	var body: some View {
		if !outputs.isEmpty, let environment = runtime?.environment {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				if producesStyle {
					FlowSectionHeader("What it produces")
					producesRows(environment)
				} else {
					SectionHeader("Outcomes") {
						Text("\(outputs.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
					}
					ForEach(Array(outputs.prefix(6).enumerated()), id: \.element.id) { index, output in
						Button { presented = output } label: {
							if index == 0 && output.isHTML {
								OutcomeFeatureCard(
									environment: environment, output: output, height: sizeClass == .regular ? 340 : 220)
							} else {
								OutcomeRow(output: output)
							}
						}
						.buttonStyle(.maskinPressed)
						.accessibilityHint("Opens it full screen")
					}
				}
			}
			.sheet(item: $presented) { output in
				OutcomePresenter(environment: environment, output: output, sourceName: sourceName)
			}
		}
	}

	/// The latest page rendered in place, then the rest as rows of one card.
	@ViewBuilder
	private func producesRows(_ environment: AppEnvironment) -> some View {
		let shown = Array(outputs.prefix(6))
		let feature = shown.first.flatMap { $0.isHTML ? $0 : nil }
		let rows = feature == nil ? shown : Array(shown.dropFirst())
		if let feature {
			Button { presented = feature } label: {
				OutcomeFeatureCard(
					environment: environment, output: feature, height: sizeClass == .regular ? 340 : 220)
			}
			.buttonStyle(.maskinPressed(.shrink))
			.accessibilityHint("Opens it full screen")
		}
		if !rows.isEmpty {
			VStack(spacing: 0) {
				ForEach(Array(rows.enumerated()), id: \.element.id) { index, output in
					Button { presented = output } label: { OutcomeRow(output: output, grouped: true) }
						.buttonStyle(.maskinPressed)
						.accessibilityHint("Opens it full screen")
					if index < rows.count - 1 { Divider().overlay(MaskinSurface.separator) }
				}
			}
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		}
	}
}

/// The loop's own briefing cards: the same story cards For you shows, limited to the pages this
/// loop produced. Nothing shows until there is one.
struct LoopBriefingsSection: View {
	let loopID: String
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var openStory: StoryCard?

	var body: some View {
		if let runtime, let stories = runtime.storiesStore() {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				FlowSectionHeader("Briefings") {
					Text("published when something lands")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
				}
				if stories.cards(forLoop: loopID).isEmpty {
					if stories.hasLoaded {
						Text("No briefings yet. The flow publishes one when a cycle closes or a result lands.")
							.maskinText(.body).foregroundStyle(MaskinColor.ink4)
							.lineSpacing(MaskinSpace.s1)
							.loopNote()
					}
				} else {
					let cards = stories.cards(forLoop: loopID)
					if cards.count <= LoopBriefingTiles.largestCount {
						// A few briefings fill the width instead of a strip of small cards.
						LoopBriefingTiles(cards: cards, stories: stories) { openStory = $0 }
					} else {
						StoryRow(stories: stories, loopID: loopID) { card in openStory = card }
					}
				}
			}
			.storyCover(item: $openStory) { card in
				BriefViewer(
					environment: runtime.environment, stories: stories,
					sequence: BriefSequence.make(cards: stories.cards(forLoop: loopID), opening: card)
				) { openStory = nil }
			}
		}
	}
}

/// One to three briefings, drawn large with the For you card: one fills the width, two share a
/// row, three put the third full width beneath. More than that keeps the small row.
struct LoopBriefingTiles: View {
	/// Past this many briefings the flow keeps the strip of small cards.
	static let largestCount = 3
	let cards: [StoryCard]
	let stories: StoriesStore
	let open: (StoryCard) -> Void
	@State private var width: CGFloat = 0

	private let gap = MaskinSpace.s5

	var body: some View {
		VStack(spacing: gap) {
			if cards.count == 1 {
				tile(cards[0], width: width, height: 260)
			} else {
				HStack(spacing: gap) {
					ForEach(cards.prefix(2)) { tile($0, width: (width - gap) / 2, height: 200) }
				}
				if cards.count == 3 { tile(cards[2], width: width, height: 160) }
			}
		}
		.frame(maxWidth: .infinity)
		.background(
			GeometryReader { proxy in
				Color.clear
					.onAppear { width = proxy.size.width }
					.onChange(of: proxy.size.width) { _, new in width = new }
			})
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Briefings")
	}

	@ViewBuilder
	private func tile(_ card: StoryCard, width: CGFloat, height: CGFloat) -> some View {
		if width > 0 {
			StoryCardView(
				card: card, isSeen: stories.isSeen(card),
				metrics: StoryCardMetrics(width: width, radius: 28, height: height)
			) { open(card) }
		}
	}
}

/// What the agents said on the loop's timeline, newest first, in one grouped card.
struct LoopPostsSection: View {
	let posts: [LoopPost]
	let directory: ActorDirectory
	let loopID: String
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var showAll = false

	var body: some View {
		if !posts.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				FlowSectionHeader("From the agents") {
					Text("\(posts.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
				}
				let shown = showAll ? posts : Array(posts.prefix(3))
				VStack(spacing: 0) {
					ForEach(Array(shown.enumerated()), id: \.element.id) { index, post in
						row(post)
						if index < shown.count - 1 { Divider().overlay(MaskinSurface.separator) }
					}
				}
				.padding(.horizontal, MaskinSpace.s8)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
				if posts.count > 3 {
					Button(showAll ? "Show fewer" : "Show all \(posts.count)") { showAll.toggle() }
						.buttonStyle(.maskinPressed)
						.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
	}

	private func row(_ post: LoopPost) -> some View {
		let actor = directory.actor(post.actorID)
		let name = actor?.name ?? "Someone"
		return VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s4) {
				ActorAvatar(
					name: name, kind: actor?.isAgent == true ? .agent : .human,
					size: MaskinSpace.s11, seed: post.actorID)
				Text(name).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				Spacer(minLength: MaskinSpace.s3)
				if post.isDecision {
					Text("Needs you").maskinText(.caption).foregroundStyle(MaskinColor.sigInk)
				}
				RelativeTime(post.date, style: .compact)
					.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
			}
			Button { runtime?.openObject(loopID) } label: {
				Text(post.text)
					.maskinText(.body).foregroundStyle(MaskinColor.ink)
					.lineLimit(6)
					.multilineTextAlignment(.leading)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
			.buttonStyle(.maskinPressed)
			.accessibilityHint("Opens the flow's timeline")
			HStack(spacing: MaskinSpace.s6) {
				Button {
					runtime?.buildInChat("About \(name)'s update on this flow: ")
				} label: {
					Label("Discuss", systemImage: "bubble.left")
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink3)
				}
				.buttonStyle(.maskinPressed)
				if post.replyCount > 0 {
					Text("\(post.replyCount) \(post.replyCount == 1 ? "reply" : "replies")")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
		.padding(.vertical, MaskinSpace.s7)
	}
}

/// The flow's properties as the quiet key/value card the item page uses: who drives it, its tags,
/// the agents that work it, and when it was made and last changed. Only what the flow has shows.
struct LoopPropertiesCard: View {
	let store: LoopDetailStore

	private var agentNames: [String] { store.loop.agentIDs.compactMap { store.directory.name($0) } }
	private var tags: [String] { store.loop.tags ?? [] }

	var body: some View {
		let loop = store.loop
		let hasAny = store.driver != nil || !tags.isEmpty || !agentNames.isEmpty || loop.createdAt != nil || loop.updatedAt != nil
		if hasAny {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				FlowSectionHeader("Properties")
				VStack(spacing: MaskinSpace.s6) {
					if let driver = store.driver {
						row("Owner") {
							HStack(spacing: MaskinSpace.s4) {
								ActorAvatar(name: driver.name, kind: .agent, size: MaskinSpace.s11, seed: driver.id)
								Text(driver.name).foregroundStyle(MaskinColor.ink)
							}
						}
					}
					if !tags.isEmpty {
						row("Tags") {
							ChipFlow {
								ForEach(tags, id: \.self) { tag in
									Text(tag).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
										.padding(.horizontal, MaskinSpace.s6)
										.frame(minHeight: MaskinSpace.s14)
										.background(MaskinSurface.fill, in: Capsule())
								}
							}
						}
					}
					if !agentNames.isEmpty {
						row("Agents") {
							Text(agentNames.joined(separator: ", ")).foregroundStyle(MaskinColor.ink)
						}
					}
					if let created = loop.createdAt {
						row("Created") { Text(created.formatted(date: .abbreviated, time: .omitted)).foregroundStyle(MaskinColor.ink) }
					}
					if let updated = loop.updatedAt {
						row("Last updated") { Text(updated.formatted(date: .abbreviated, time: .omitted)).foregroundStyle(MaskinColor.ink) }
					}
				}
				.padding(MaskinSpace.s9)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			}
		}
	}

	private func row<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
		HStack(alignment: .firstTextBaseline) {
			Text(label).foregroundStyle(MaskinColor.ink4)
			Spacer(minLength: MaskinSpace.s7)
			value().multilineTextAlignment(.trailing)
		}
		.maskinText(.subhead)
	}
}

/// What the flow wants from you: the decisions waiting on its timeline.
struct LoopNeedsYouSection: View {
	let store: LoopDetailStore
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	private var decisions: [LoopPost] { store.posts.filter(\.isDecision) }

	var body: some View {
		// Nothing to show means no section: the handoff's Overview goes straight from Targets to outputs.
		if !decisions.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				FlowSectionHeader("Needs you")
				ForEach(decisions) { post in
					Button { runtime?.openObject(store.loop.id) } label: {
						VStack(alignment: .leading, spacing: MaskinSpace.s3) {
							HStack(alignment: .firstTextBaseline) {
								MonoLabel("Decision", color: MaskinColor.sigInk)
								Spacer(minLength: MaskinSpace.s3)
								RelativeTime(post.date, style: .compact)
									.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
							}
							Text(post.text)
								.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: MaskinFontWeight.w650, relativeTo: .body))
								.tracking(-0.012 * MaskinFontSize.t16)
								.foregroundStyle(MaskinColor.ink)
								.lineLimit(5)
								.multilineTextAlignment(.leading)
								.frame(maxWidth: .infinity, alignment: .leading)
							Text("Decide ›")
								.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.w650, relativeTo: .subheadline))
								.foregroundStyle(MaskinColor.ink)
								.frame(maxWidth: .infinity, alignment: .trailing)
								.padding(.top, MaskinSpace.s3)
						}
						.loopCard()
						.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed)
					.accessibilityHint("Opens the flow's timeline")
				}
			}
		}
	}
}

/// The objects still on their way through the flow: the Items list's own flat hairline rows and
/// plain collapsible status headers, in workflow order. A row opens the item, as it does there.
struct LoopInMotionSection: View {
	let store: LoopDetailStore
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var collapsed: Set<String> = []

	private var groups: [LoopPhase] {
		LoopPhases.inMotion(members: store.overview.members, statusOrder: store.overview.statusOrder)
	}

	var body: some View {
		let groups = groups
		let mixesTypes = Set(groups.flatMap(\.members).map(\.type)).count > 1
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			FlowSectionHeader("In motion") {
				Text("\(groups.reduce(0) { $0 + $1.count })").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
			}
			if groups.isEmpty {
				Text("Nothing is in flight.")
					.maskinText(.body).foregroundStyle(MaskinColor.ink4)
					.loopNote()
			} else {
				ForEach(groups) { group in
					let objects = group.members.map(workObject)
					let isCollapsed = collapsed.contains(group.id)
					VStack(alignment: .leading, spacing: 0) {
						ObjectGroupHeader(
							group: ObjectGroup(id: group.id, title: MaskinStatus.label(for: group.status), objects: objects),
							collapsed: isCollapsed
						) {
							withAnimation(reduceMotion ? nil : MaskinMotion.standard) {
								if !collapsed.insert(group.id).inserted { collapsed.remove(group.id) }
							}
						}
						if !isCollapsed {
							ForEach(objects) { object in
								Divider().overlay(MaskinSurface.separator)
								row(object, showsType: mixesTypes)
							}
						}
					}
				}
			}
		}
	}

	/// A member as the Items list sees an object. Members carry no star or timestamps.
	private func workObject(_ member: LoopMember) -> WorkObject {
		WorkObject(id: member.id, type: member.type, title: member.title, status: member.status, driverId: member.driverID)
	}

	private func row(_ object: WorkObject, showsType: Bool) -> some View {
		Button { runtime?.openObject(object.id) } label: {
			ObjectFlatRow(
				object: object, typeName: ObjectsSchema.fallback.displayName(for: object.type), showsType: showsType,
				ownerName: store.directory.name(object.driverId), showsUpdated: false, showsStar: false)
				.padding(.vertical, MaskinSpace.s5)
				.padding(.horizontal, MaskinSpace.s4)
		}
		.buttonStyle(.maskinPressed)
		.contextMenu {
			Button { runtime?.openObject(object.id) } label: { Label("Open", systemImage: "arrow.up.forward.square") }
		}
	}
}
