import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Objects board: one type's objects in a horizontal run of status columns, each a stack of
/// cards with the same content as the list rows. Drag a card between columns to change its
/// status (with Undo); cards open like list rows do.
struct ObjectsBoardView: View {
	@Bindable var store: ObjectsStore
	@Bindable var board: ObjectsBoardStore
	/// Set in a split view, where a card drives the selection instead of pushing.
	let selection: Binding<String?>?
	/// Select mode (owned by the screen); a tap on a card toggles it instead of opening it.
	var picking: SelectionModel = SelectionModel()
	var zoomNamespace: Namespace.ID?
	/// Called after a card moved column, with the toast text and the way back.
	var offerUndo: (String, @escaping @MainActor () async -> Void) -> Void = { _, _ in }
	/// A column's "+": new object in that status.
	var onNew: (String) -> Void = { _ in }

	/// Handoff 1B: 300pt columns that snap sideways, the next one peeking in on a phone.
	private static let columnWidth: CGFloat = 270

	var body: some View {
		Group {
			if store.typeFilter == nil {
				EmptyState(
					symbol: "rectangle.split.3x1", title: "Choose a type",
					message: "The board shows one type at a time. Pick one above.")
			} else {
				content
			}
		}
		.task(id: BoardKey(type: store.typeFilter, sort: store.display.sort)) {
			await board.load(type: store.typeFilter, sort: store.display.sort)
		}
	}

	private struct BoardKey: Hashable {
		var type: String?
		var sort: ObjectsSort
	}

	@ViewBuilder private var content: some View {
		switch board.phase {
		case .idle, .loading:
			LoadingSkeleton().padding(MaskinSpace.s9)
		case .failed(let message):
			Group {
				if board.isOffline {
					AmberNotice.offline(since: store.freshness.updatedAt) { Task { await board.refresh() } }
				} else {
					AmberNotice(
						title: "Couldn't load the board", message: message, actionTitle: "Retry"
					) { Task { await board.refresh() } }
				}
			}
			.padding(MaskinSpace.s9)
		case .loaded:
			if board.columns.allSatisfy({ $0.total == 0 }) {
				EmptyState(
					symbol: "square.stack.3d.up", title: "Nothing here yet",
					message: "Create an object, or ask an agent to. What you and your agents make shows up here.")
			} else {
				columns
			}
		}
	}

	private var columns: some View {
		let needsYouOnly = store.needsYouOnly
		return VStack(spacing: 0) {
			if let error = board.moveError {
				FormError(error)
					.onTapGesture { board.clearMoveError() }
					.padding(.horizontal, MaskinSpace.s9)
			}
			ScrollView(.horizontal, showsIndicators: false) {
				LazyHStack(alignment: .top, spacing: MaskinSpace.s5) {
					ForEach(board.shownColumns) { column in
						ObjectsBoardColumnView(
							column: column, cards: board.cards(in: column, needsYouOnly: needsYouOnly),
							count: board.count(in: column, needsYouOnly: needsYouOnly), store: store,
							selection: selection, picking: picking, zoomNamespace: zoomNamespace,
							isLoadingMore: board.loadingMore.contains(column.id),
							showsMore: column.hasMore && !needsYouOnly,
							onMore: { Task { await board.loadMore(column: column.id) } },
							onMove: { id, status in move(id, to: status) },
							onNew: { onNew(column.value) })
					}
				}
				.scrollTargetLayout()
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s8)
			}
			.scrollTargetBehavior(.viewAligned)
		}
	}

	private func move(_ id: String, to status: String) {
		MaskinHaptics.play(.selection)
		Task {
			guard let change = await board.move(id, toColumn: status) else { return }
			offerUndo("Moved to \(MaskinStatus.label(for: status)). Undo.") {
				_ = await board.move(id, toColumn: change.from)
			}
		}
	}
}

/// One status column: category mark + name + count + "+", then the cards, then "Show more".
/// Accepts dropped card ids.
struct ObjectsBoardColumnView: View {
	let column: ObjectsBoardColumn
	let cards: [WorkObject]
	let count: Int
	let store: ObjectsStore
	var selection: Binding<String?>? = nil
	var picking = SelectionModel()
	var zoomNamespace: Namespace.ID? = nil
	var isLoadingMore = false
	var showsMore = false
	var onMore: () -> Void = {}
	var onMove: (String, String) -> Void = { _, _ in }
	var onNew: () -> Void = {}

	@State private var targeted = false

	private static let columnWidth: CGFloat = 270

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			header
			if cards.isEmpty {
				Text("Drop a card here")
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink5)
					.frame(maxWidth: .infinity)
					.padding(.vertical, MaskinSpace.s10)
					.overlay {
						RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
							.strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
							.foregroundStyle(MaskinSurface.line)
					}
			}
			ForEach(cards) { object in
				card(object)
			}
			if showsMore {
				Button {
					onMore()
				} label: {
					Group {
						if isLoadingMore {
							ProgressView()
						} else {
							Text("Show more").maskinText(.subhead).fontWeight(.semibold)
								.foregroundStyle(MaskinColor.ink3)
						}
					}
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				}
				.buttonStyle(.maskinPressed)
			}
		}
		.padding(.horizontal, MaskinSpace.s4)
		.padding(.top, MaskinSpace.s3)
		.padding(.bottom, MaskinSpace.s4)
		.frame(width: Self.columnWidth, alignment: .top)
		.background(
			targeted ? MaskinSurface.fillStrong : MaskinSurface.fill,
			in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		.animation(MaskinMotion.quick, value: targeted)
		// A long-press drag of a card lands here and changes its status.
		.dropDestination(for: String.self) { ids, _ in
			guard let id = ids.first, !column.value.isEmpty else { return false }
			onMove(id, column.value)
			return true
		} isTargeted: { targeted = $0 }
		.accessibilityElement(children: .contain)
		.accessibilityLabel("\(MaskinStatus.sentenceLabel(for: column.value)), \(count)")
	}

	private var header: some View {
		HStack(spacing: MaskinSpace.s4) {
			if !column.value.isEmpty {
				StatusCategoryGlyph(category: StatusCategory.of(column.value), size: MaskinSpace.s8)
			}
			Text(MaskinStatus.sentenceLabel(for: column.value))
				.maskinText(.subhead)
				.fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink2)
				.lineLimit(1)
			Text("\(count)")
				.maskinText(.caption)
				.monospacedDigit()
				.foregroundStyle(MaskinColor.ink5)
			Spacer(minLength: MaskinSpace.s3)
			if !column.value.isEmpty {
				Button {
					onNew()
				} label: {
					Image(systemName: "plus")
						.maskinSymbol(MaskinFontSize.t15, weight: .semibold)
						.foregroundStyle(MaskinColor.ink4)
						.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
						.contentShape(Circle())
				}
				.buttonStyle(.maskinPressed)
				.accessibilityLabel("New in \(MaskinStatus.sentenceLabel(for: column.value))")
			}
		}
		.padding(.leading, MaskinSpace.s4)
		.frame(minHeight: MaskinSpace.touchMin)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}

	@ViewBuilder private func card(_ object: WorkObject) -> some View {
		let content = ObjectBoardCard(
			object: object, typeName: store.directory.typeName(object.type), ask: store.ask(for: object.id),
			ownerName: store.directory.name(for: object.driverId),
			ownerIsAgent: store.directory.actor(for: object.driverId)?.isAgent == true,
			showsStatus: store.display.shows(.status), showsDriver: store.display.shows(.driver),
			showsUpdated: store.display.shows(.updated))
		Group {
			if picking.isActive {
				HStack(spacing: MaskinSpace.s5) {
					SelectionCheckbox(isPicked: picking.contains(object.id))
					content
				}
				.contentShape(Rectangle())
				.onTapGesture { picking.toggle(object.id) }
				.selectionRowAccessibility(isActive: true, isPicked: picking.contains(object.id))
				.accessibilityAddTraits(.isButton)
			} else if let selection {
				Button { selection.wrappedValue = object.id } label: { content }
					.buttonStyle(.maskinPressed(.shrink))
			} else {
				NavigationLink(value: ObjectRoute(id: object.id)) { content }
					.buttonStyle(.maskinPressed(.shrink))
					.zoomSource(id: object.id, in: zoomNamespace)
			}
		}
		.draggable(object.id)
		// The same move without dragging, for VoiceOver and a steady hand.
		.contextMenu {
			Menu("Move to", systemImage: "arrow.right") {
				ForEach(store.directory.schema.statuses(for: object.type).filter { $0 != object.status }, id: \.self) {
					status in
					Button(MaskinStatus.sentenceLabel(for: status)) { onMove(object.id, status) }
				}
			}
		}
	}
}

/// A board card: the row's content on a card (no type glyph: the board is one type).
struct ObjectBoardCard: View {
	let object: WorkObject
	let typeName: String
	var ask: ObjectAsk?
	var ownerName: String?
	var ownerIsAgent = false
	var showsStatus = true
	var showsDriver = true
	var showsUpdated = true

	var body: some View {
		ObjectRow(
			object: object, typeName: typeName, showsGlyph: false, ask: ask, ownerName: ownerName,
			ownerIsAgent: ownerIsAgent, showsStatus: showsStatus, showsDriver: showsDriver,
			showsUpdated: showsUpdated)
		.padding(.horizontal, MaskinSpace.s7)
		.padding(.vertical, MaskinSpace.s6)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
		.contentShape(Rectangle())
	}
}
