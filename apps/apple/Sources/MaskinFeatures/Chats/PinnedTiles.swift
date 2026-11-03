import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The PINNED grid (spec 1 §2, spec 7 §6): three columns, radius-22 cards with a 44pt avatar,
/// name and last item. Long-press (320ms) lifts a tile, dragging it over another swaps them,
/// with a haptic tick per swap; the order is persisted by the store. In selection mode the tiles
/// show their checkbox and a tap toggles them instead.
struct PinnedTiles<Menu: View>: View {
	let tiles: [TeamLayout.Tile]
	let currentActorID: String?
	var workingAgentIDs: Set<String> = []
	/// Non-nil while the list is in selection mode: tiles show their checkmark.
	var picking: SelectionModel?
	let onOpen: (TeamLayout.Tile) -> Void
	/// Move `id` to where `before` sits.
	let onMove: (_ id: String, _ before: String) -> Void
	@ViewBuilder let menu: (TeamLayout.Tile) -> Menu

	@State private var dragging: String?
	@State private var dragOffset: CGSize = .zero
	@State private var frames: [String: CGRect] = [:]
	@State private var dragEndedAt = Date.distantPast
	/// The lifted tile was dragged (or swapped): its release is a reorder, not a tap.
	@State private var moved = false
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	private static var space: String { "pinnedTiles" }
	private static var columns: [GridItem] {
		Array(repeating: GridItem(.flexible(), spacing: MaskinSpace.s4 + 1, alignment: .top), count: 3)
	}

	var body: some View {
		LazyVGrid(columns: Self.columns, spacing: MaskinSpace.s4 + 1) {
			ForEach(tiles) { tile in
				// A real Button opens the chat on the first tap. A tap gesture racing the long-press
				// reorder gesture and the context menu inside a List row was dropped or delayed.
				Button {
					// Not after a reorder drag; a press that lifted the tile but never moved is a tap.
					if !(dragging != nil && moved), Date().timeIntervalSince(dragEndedAt) > 0.3 { onOpen(tile) }
				} label: {
					PinnedTile(
						tile: tile, currentActorID: currentActorID, workingAgentIDs: workingAgentIDs,
						lifted: dragging == tile.id
					)
				}
				.buttonStyle(.plain)
				.overlay(alignment: .topLeading) {
					if let picking, case .conversation(let c) = tile.kind {
						SelectionCheckbox(isPicked: picking.contains(c.id)).padding(MaskinSpace.s4)
					}
				}
				.offset(dragging == tile.id ? dragOffset : .zero)
				.zIndex(dragging == tile.id ? 1 : 0)
				.background {
					GeometryReader { geo in
						Color.clear.preference(key: TileFrameKey.self, value: [tile.id: geo.frame(in: .named(Self.space))])
					}
				}
				.simultaneousGesture(picking == nil ? dragGesture(for: tile) : nil)
				.contextMenu { if picking == nil { menu(tile) } }
				.accessibilityAction(named: "Move earlier") { move(tile, by: -1) }
				.accessibilityAction(named: "Move later") { move(tile, by: 1) }
			}
		}
		.coordinateSpace(name: Self.space)
		.onPreferenceChange(TileFrameKey.self) { value in
			Task { @MainActor in frames = value }
		}
		.animation(reduceMotion ? nil : MaskinMotion.standard, value: tiles.map(\.id))
		.accessibilityElement(children: .contain)
	}

	private func dragGesture(for tile: TeamLayout.Tile) -> some Gesture {
		LongPressGesture(minimumDuration: 0.32)
			.sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.space)))
			.onChanged { value in
				switch value {
				case .first(true):
					if dragging != tile.id {
						dragging = tile.id
						moved = false
						dragOffset = .zero
						MaskinHaptics.play(.medium)
					}
				case .second(true, let drag?):
					guard let frame = frames[tile.id] else { return }
					dragOffset = CGSize(width: drag.location.x - frame.midX, height: drag.location.y - frame.midY)
					if hypot(drag.translation.width, drag.translation.height) > MaskinSpace.s5 { moved = true }
					if let target = frames.first(where: { $0.key != tile.id && $0.value.contains(drag.location) })?.key {
						onMove(tile.id, target)
						MaskinHaptics.play(.selection)
					}
				default:
					break
				}
			}
			.onEnded { _ in
				// Held past the lift delay but let go without moving: the person meant to open it.
				let wasTap = dragging == tile.id && !moved
				if dragging != nil { dragEndedAt = Date() }
				if wasTap { onOpen(tile) }
				dragging = nil
				dragOffset = .zero
			}
	}

	private func move(_ tile: TeamLayout.Tile, by delta: Int) {
		guard let index = tiles.firstIndex(where: { $0.id == tile.id }) else { return }
		let target = index + delta
		guard tiles.indices.contains(target) else { return }
		onMove(tile.id, tiles[target].id)
	}
}

/// Tile frames in the grid's coordinate space, for drag-over swaps.
private struct TileFrameKey: PreferenceKey {
	static let defaultValue: [String: CGRect] = [:]
	static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
		value.merge(nextValue(), uniquingKeysWith: { _, new in new })
	}
}

struct PinnedTile: View {
	let tile: TeamLayout.Tile
	let currentActorID: String?
	var workingAgentIDs: Set<String> = []
	var lifted = false

	/// 44pt: the tile's avatar.
	static let avatarSize: CGFloat = MaskinSpace.s14 + MaskinSpace.s7

	var body: some View {
		VStack(spacing: MaskinSpace.s4 - 1) {
			avatar.frame(height: Self.avatarSize)
			Text(tile.title)
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .bold, relativeTo: .subheadline))
				.tracking(-0.01 * MaskinFontSize.t14)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(2)
				.multilineTextAlignment(.center)
			Text(tile.subtitle)
				.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
				.foregroundStyle(MaskinColor.ink4)
				.lineLimit(2, reservesSpace: true)
				.multilineTextAlignment(.center)
		}
		.frame(maxWidth: .infinity)
		.padding(.top, MaskinSpace.s8)
		.padding(.horizontal, MaskinSpace.s4)
		.padding(.bottom, MaskinSpace.s7)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadiusLarge.tile, style: .continuous))
		.overlay(alignment: .topTrailing) {
			if tile.unreadCount > 0 {
				UnreadBadge(count: tile.unreadCount).padding(MaskinSpace.s4 + 1)
			}
		}
		.scaleEffect(lifted ? 1.06 : 1)
		.shadow(color: lifted ? MaskinPatina.cardShadow : .clear, radius: lifted ? MaskinSpace.s8 : 0, y: lifted ? MaskinSpace.s4 : 0)
		.animation(MaskinMotion.quick, value: lifted)
		.contentShape(RoundedRectangle(cornerRadius: MaskinRadiusLarge.tile, style: .continuous))
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	@ViewBuilder
	private var avatar: some View {
		switch tile.kind {
		case .conversation(let c):
			ConversationAvatar(
				participants: c.others(excluding: currentActorID), size: Self.avatarSize,
				working: c.participants.contains { workingAgentIDs.contains($0.id) })
		case .flow:
			FlowTile(size: Self.avatarSize)
		}
	}

	private var accessibilityLabel: String {
		var parts = [tile.title, tile.subtitle, "pinned"]
		if tile.unreadCount > 0 { parts.append("\(tile.unreadCount) unread") }
		return parts.joined(separator: ", ")
	}
}

extension PinnedTiles where Menu == AnyView {
	/// Pinned conversations only, with Unpin as the sole menu item: the form the chat snapshots
	/// and simple callers use.
	init(
		conversations: [ConversationSummary], currentActorID: String?, selection: Binding<String?>,
		picking: SelectionModel? = nil, onUnpin: @escaping (String) -> Void
	) {
		let tiles = conversations.map { c in
			TeamLayout.Tile(
				id: c.id, kind: .conversation(c), title: TeamLayout.title(of: c, me: currentActorID),
				subtitle: ChatPreviewText.plain(c.title), unreadCount: c.unreadCount)
		}
		self.init(
			tiles: tiles, currentActorID: currentActorID, picking: picking,
			onOpen: { tile in if case .conversation(let c) = tile.kind { selection.wrappedValue = c.id } },
			onMove: { _, _ in }
		) { tile in
			AnyView(Button("Unpin", systemImage: "pin.slash") { onUnpin(tile.id) })
		}
	}
}
