import MaskinCore
import MaskinDesign
import SwiftUI

/// Related approvals as one card: "Review 5 wiki pages", how many are still open, and a row for
/// each with its own Approve. One button at the foot approves everything still open. When the last
/// one is approved the card gives way to a one-line receipt with Undo, for as long as Undo is free.
struct ApprovalGroupCard: View {
	let group: ApprovalGroup
	/// The workspace's name for the cards' type ("Wiki page").
	let typeLabel: String
	/// Undo still works for an approved card of the group.
	let canUndo: Bool
	var approveOne: (ForYouCard) -> Void = { _ in }
	var approveAll: () -> Void = {}
	var undo: () -> Void = {}

	@State private var expanded = true
	/// The row opened to show who wrote it and its Approve.
	@State private var openRow: String?
	@Environment(\.dynamicTypeSize) private var typeSize

	private var shape: RoundedRectangle {
		RoundedRectangle(cornerRadius: MaskinRadius.brief, style: .continuous)
	}

	var body: some View {
		if group.isDone {
			doneStrip
		} else {
			card
		}
	}

	// MARK: Open

	private var card: some View {
		VStack(alignment: .leading, spacing: 0) {
			header
			if expanded {
				ForEach(group.members) { member in
					Rectangle().fill(MaskinSurface.separator).frame(height: 1)
					row(member)
				}
				approveAllButton
			}
		}
		.background(MaskinSurface.card, in: shape)
		.accessibilityElement(children: .contain)
	}

	private var header: some View {
		Button {
			withAnimation(MaskinMotion.standard) { expanded.toggle() }
		} label: {
			let layout = typeSize.isAccessibilitySize
				? AnyLayout(VStackLayout(alignment: .leading, spacing: MaskinSpace.s3))
				: AnyLayout(HStackLayout(spacing: MaskinSpace.s5))
			layout {
				Text("GROUP")
					.font(MaskinTypeface.mono(MaskinFontSize.t11, weight: .semibold)).tracking(0.88)
					.foregroundStyle(MaskinColor.ink4)
				Text(group.title(typeLabel: typeLabel))
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold)).tracking(-0.15)
					.foregroundStyle(MaskinColor.ink)
					.multilineTextAlignment(.leading)
					.frame(maxWidth: .infinity, alignment: .leading)
				HStack(spacing: MaskinSpace.s4) {
					Text("\(group.openCount) open")
						.font(MaskinTypeface.sans(MaskinFontSize.t13))
						.foregroundStyle(MaskinColor.ink5)
					Image(systemName: "chevron.down")
						.maskinSymbol(MaskinFontSize.t12, weight: .bold)
						.foregroundStyle(MaskinColor.ink5)
						.rotationEffect(.degrees(expanded ? 180 : 0))
						.accessibilityHidden(true)
				}
			}
			.padding(.horizontal, MaskinSpace.s8)
			.padding(.vertical, MaskinSpace.s7)
			.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s4, alignment: .leading)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel("\(group.title(typeLabel: typeLabel)), \(group.openCount) open")
		.accessibilityValue(expanded ? "Expanded" : "Collapsed")
		.accessibilityHint(expanded ? "Hides the list" : "Shows the list")
	}

	private func rowTitle(_ member: ApprovalGroup.Member) -> String {
		let card = member.entry.card
		return card.objectTitle?.trimmed.nonEmpty ?? card.headline
	}

	private func row(_ member: ApprovalGroup.Member) -> some View {
		let isOpen = openRow == member.id
		let title = rowTitle(member)
		return VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			Button {
				withAnimation(MaskinMotion.standard) { openRow = isOpen ? nil : member.id }
			} label: {
				HStack(spacing: MaskinSpace.s5) {
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text(title)
							.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold))
							.foregroundStyle(MaskinColor.ink)
							.multilineTextAlignment(.leading)
						status(member)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
					Image(systemName: "chevron.right")
						.maskinSymbol(MaskinFontSize.t13, weight: .semibold)
						.foregroundStyle(MaskinColor.inkPlaceholder)
						.rotationEffect(.degrees(isOpen ? 90 : 0))
						.accessibilityHidden(true)
				}
				.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s4, alignment: .leading)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("\(title), \(member.isApproved ? "Approved" : "Proposed")")
			.accessibilityValue(isOpen ? "Expanded" : "Collapsed")
			if isOpen {
				if let author = group.agentName {
					Text("Written by \(author).")
						.font(MaskinTypeface.sans(MaskinFontSize.t14))
						.foregroundStyle(MaskinColor.ink3)
						.frame(maxWidth: .infinity, alignment: .leading)
				}
				if !member.isApproved {
					Button {
						approveOne(member.entry.card)
					} label: {
						Text("Approve")
							.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold))
							.foregroundStyle(MaskinSurface.onInverse)
							.padding(.horizontal, MaskinSpace.s9)
							.frame(minHeight: MaskinSpace.touchMin)
							.background(MaskinSurface.inverse, in: Capsule())
							.contentShape(Capsule())
					}
					.buttonStyle(.maskinPressed(.shrink))
					.accessibilityLabel("Approve \(title)")
				}
			}
		}
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.bottom, isOpen ? MaskinSpace.s7 : 0)
	}

	private func status(_ member: ApprovalGroup.Member) -> some View {
		HStack(spacing: 0) {
			Text(member.isApproved ? "Approved" : "Proposed")
				.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold))
				.foregroundStyle(member.isApproved ? MaskinColor.successStrong : MaskinColor.ink3)
			if let author = group.agentName {
				Text(" \u{00B7} \(author)")
					.font(MaskinTypeface.sans(MaskinFontSize.t12))
					.foregroundStyle(MaskinColor.ink5)
			}
		}
	}

	private var approveAllButton: some View {
		Button(action: approveAll) {
			Text("Approve all \(group.openCount)")
				.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold))
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s4)
				.background(MaskinSurface.inverse, in: Capsule())
				.contentShape(Capsule())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.bottom, MaskinSpace.s8)
		.padding(.top, MaskinSpace.s3)
		.accessibilityLabel("Approve all \(group.openCount) \(ApprovalGrouping.plural(typeLabel.lowercased(), count: group.openCount))")
		.accessibilityHint("Approves each one. You can undo for a few seconds.")
	}

	// MARK: Done

	private var doneStrip: some View {
		HStack(spacing: MaskinSpace.s5) {
			Image(systemName: "checkmark")
				.maskinSymbol(MaskinFontSize.t13, weight: .bold)
				.foregroundStyle(ForYouPalette.receiptBackground)
				.frame(width: MaskinSpace.s12, height: MaskinSpace.s12)
				.background(ForYouPalette.receiptCheck, in: Circle())
				.accessibilityHidden(true)
			Text(group.doneText(typeLabel: typeLabel))
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
				.foregroundStyle(ForYouPalette.receiptForeground)
				.frame(maxWidth: .infinity, alignment: .leading)
			if canUndo {
				Button(action: undo) {
					Text("Undo")
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
						.foregroundStyle(ForYouPalette.receiptForeground)
						.padding(.horizontal, MaskinSpace.s4)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.accessibilityLabel("Undo approving \(group.total) \(ApprovalGrouping.plural(typeLabel.lowercased(), count: group.total))")
			}
		}
		.padding(.horizontal, MaskinSpace.s7)
		.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s5)
		.background(ForYouPalette.receiptBackground, in: shape)
		.overlay(shape.strokeBorder(ForYouPalette.receiptBorder, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
}

extension String {
	/// Local copies of the core helpers (they are internal to MaskinCore).
	fileprivate var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
	fileprivate var nonEmpty: String? { isEmpty ? nil : self }
}
