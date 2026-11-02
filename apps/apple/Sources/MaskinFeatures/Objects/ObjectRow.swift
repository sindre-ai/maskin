import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

extension ObjectsStatusTone {
	/// Patina for running and needs-you, ink for done, grey for paused.
	var color: Color {
		switch self {
		case .patina: MaskinColor.sigInk
		case .ink: MaskinColor.doneFg
		case .quiet: MaskinColor.ink4
		case .neutral: MaskinColor.ink3
		}
	}
}

/// The type as a mono pill with its dot (the one place a type keeps its hue). Kept for the
/// detail header; rows no longer carry it (handoff spec 8).
struct ObjectTypeTag: View {
	let type: String
	let name: String

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous)
				.fill(MaskinObjectType.dotColor(for: type))
				.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
				.accessibilityHidden(true)
			MonoLabel(name, color: MaskinColor.ink2, size: .chip)
				.padding(.horizontal, MaskinSpace.s3)
				.padding(.vertical, MaskinSpace.s1)
				.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.inputSm, style: .continuous))
				.lineLimit(1)
		}
		.fixedSize()
	}
}

/// "Needs you": the Patina marker the lists use.
struct NeedsYouDot: View {
	var body: some View {
		Circle().fill(MaskinColor.sig)
			.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
			.accessibilityLabel("Needs you")
	}
}

/// The driver's coded avatar (people are circles, agents their own shapes), with the Patina
/// working ring while an agent runs on the object. An empty quiet slot when the driver can't be
/// resolved: no initials of an id.
struct ObjectDriverAvatar: View {
	let name: String?
	let isAgent: Bool
	let seed: String?
	var working = false
	var size: CGFloat = MaskinSpace.s10

	var body: some View {
		if let name, !name.isEmpty {
			ActorAvatar(name: name, kind: isAgent ? .agent : .human, size: size, seed: seed, working: working)
		} else {
			Circle()
				.fill(MaskinSurface.fill)
				.frame(width: size, height: size)
				.overlay {
					Image(systemName: "person")
						.maskinSymbol(MaskinFontSize.t10, weight: .semibold)
						.foregroundStyle(MaskinColor.ink5)
				}
				.accessibilityLabel("No owner")
		}
	}
}

/// Three small Patina bars that say "an agent is working here now". Still under Reduce Motion.
struct ObjectWorkingBars: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var phase = false

	private let heights: [CGFloat] = [5, 11, 7]

	var body: some View {
		HStack(alignment: .center, spacing: 1.5) {
			ForEach(0..<3, id: \.self) { i in
				RoundedRectangle(cornerRadius: 1, style: .continuous)
					.fill(MaskinColor.sigInk)
					.frame(width: 2, height: phase && !reduceMotion ? heights[(i + 1) % 3] : heights[i])
			}
		}
		.frame(height: 11)
		.onAppear {
			guard !reduceMotion else { return }
			withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { phase = true }
		}
		.accessibilityLabel("Agent working")
	}
}

/// One object in the list or on the board, to the handoff's anatomy (`specs/8-Objects.md`):
/// - line 1: type glyph (only when the list mixes types) + title (2 lines) + favourite star + unseen dot
/// - line 2: the ask in Patina, "Strategist: …", only when it needs you
/// - line 3: driver avatar 18 (Patina ring while an agent works) · working bars · status · time
/// No type tag, mono id, flow, due or priority: those live on the object page.
/// Pure values in, so it renders in previews and snapshots; the card belongs to the list.
struct ObjectRow: View {
	let object: WorkObject
	let typeName: String
	/// The list mixes types, so the row says which one this is.
	var showsGlyph = true
	/// An open ask for the reader, when the object needs them.
	var ask: ObjectAsk?
	/// The driver's resolved name; an empty slot when it can't be resolved.
	var ownerName: String?
	var ownerIsAgent = false
	var showsStatus = true
	var showsDriver = true
	var showsUpdated = true

	private var unseen: Bool { object.unreadCount > 0 }
	private var needsYou: Bool { ask != nil || ObjectsUrgency.needsYou(object) }

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			if showsGlyph {
				Image(systemName: MaskinObjectType.glyph(for: object.type))
					.maskinSymbol(MaskinFontSize.t17, weight: .regular)
					.foregroundStyle(MaskinColor.ink4)
					.frame(width: MaskinSpace.s11 + MaskinSpace.s1, height: MaskinSpace.s11 + MaskinSpace.s1)
					.accessibilityHidden(true)
			}
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(alignment: .top, spacing: MaskinSpace.s3) {
					Text(object.displayTitle)
						.maskinText(.headline)
						.fontWeight(unseen ? .bold : .semibold)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(2)
						.multilineTextAlignment(.leading)
						.frame(maxWidth: .infinity, alignment: .leading)
					if object.isStarred {
						Image(systemName: "star.fill")
							.maskinSymbol(MaskinFontSize.t13, weight: .regular)
							.foregroundStyle(MaskinColor.sigInk)
							.padding(.top, MaskinSpace.s1)
							.accessibilityHidden(true)
					}
					if unseen {
						Circle()
							.fill(MaskinColor.sig)
							.frame(width: MaskinSpace.s3 + 1, height: MaskinSpace.s3 + 1)
							.padding(.top, MaskinSpace.s3)
							.accessibilityHidden(true)
					}
				}
				if let ask {
					askLine(ask)
				}
				metaLine
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
		.maskinHover()
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	private func askLine(_ ask: ObjectAsk) -> some View {
		Group {
			if let who = ask.askedBy, !who.isEmpty {
				Text("\(who): ").fontWeight(.bold) + Text(ask.text)
			} else {
				Text(ask.text)
			}
		}
		.maskinText(.subhead)
		.foregroundStyle(MaskinColor.sigInk)
		.lineLimit(1)
		.padding(.top, MaskinSpace.s1)
	}

	@ViewBuilder private var metaLine: some View {
		if showsDriver || showsStatus || showsUpdated || object.hasActiveSession {
			HStack(spacing: MaskinSpace.s3 + 1) {
				if showsDriver {
					ObjectDriverAvatar(
						name: ownerName, isAgent: ownerIsAgent, seed: object.driverId,
						working: object.hasActiveSession)
				}
				if object.hasActiveSession {
					ObjectWorkingBars()
				}
				if showsStatus {
					Text(MaskinStatus.sentenceLabel(for: object.status))
						.maskinText(.caption)
						.foregroundStyle(ObjectsStatusTone.of(object).color)
						.lineLimit(1)
				}
				Spacer(minLength: 0)
				if showsUpdated {
					RelativeTime(object.updatedAt, style: .compact)
						.maskinText(.caption)
						.monospacedDigit()
						.foregroundStyle(MaskinColor.ink5)
				}
			}
			.padding(.top, MaskinSpace.s2)
		}
	}

	private var accessibilityLabel: String {
		var parts = [typeName, object.displayTitle]
		if object.isStarred { parts.append("Favourite") }
		if unseen { parts.append("Changed since you last looked") }
		if let ask { parts.append("Needs you. \(ask.line)") } else if needsYou { parts.append("Needs you") }
		if let ownerName, showsDriver { parts.append("owned by \(ownerName)") }
		if object.hasActiveSession { parts.append("Agent working") }
		parts.append(MaskinStatus.sentenceLabel(for: object.status))
		return parts.joined(separator: ", ")
	}
}

/// Foldable header for a group: the status category's mark (or the type glyph) + name + count,
/// a chevron at the end. Tap to fold.
struct ObjectGroupHeader: View {
	let group: ObjectGroup
	var collapsed = false
	var onToggle: (() -> Void)?

	var body: some View {
		Button {
			onToggle?()
		} label: {
			HStack(spacing: MaskinSpace.s4) {
				icon
				Text(group.title ?? "")
					.maskinText(.subhead)
					.fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink2)
					.lineLimit(1)
				Text("\(group.objects.count)")
					.maskinText(.caption)
					.monospacedDigit()
					.foregroundStyle(MaskinColor.ink5)
				Spacer(minLength: 0)
				if onToggle != nil {
					Image(systemName: "chevron.down")
						.maskinSymbol(MaskinFontSize.t11, weight: .bold)
						.foregroundStyle(MaskinColor.ink5)
						.rotationEffect(.degrees(collapsed ? -90 : 0))
				}
			}
			.padding(.horizontal, MaskinSpace.s4)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.disabled(onToggle == nil)
		.textCase(nil)
		.accessibilityAddTraits(.isHeader)
		.accessibilityLabel("\(group.title ?? ""), \(group.objects.count)")
		.accessibilityHint(onToggle == nil ? "" : (collapsed ? "Expands the group" : "Folds the group"))
	}

	@ViewBuilder private var icon: some View {
		if group.isType {
			Image(systemName: MaskinObjectType.glyph(for: group.id))
				.maskinSymbol(MaskinFontSize.t14, weight: .medium)
				.foregroundStyle(MaskinColor.ink4)
				.frame(width: MaskinSpace.s8, height: MaskinSpace.s8)
		} else if group.isAttention {
			Circle().fill(MaskinColor.sigInk)
				.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
				.accessibilityHidden(true)
		} else if let status = group.status, !status.isEmpty {
			StatusCategoryGlyph(category: StatusCategory.of(status), size: MaskinSpace.s8)
		} else if !group.id.isEmpty {
			StatusCategoryGlyph(category: StatusCategory.of(group.id), size: MaskinSpace.s8)
		}
	}
}
