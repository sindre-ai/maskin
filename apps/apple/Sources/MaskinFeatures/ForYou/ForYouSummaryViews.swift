import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A rounded card of one-line rows: LATER and HANDLED TODAY at the foot of For you.
struct SummaryList<Content: View>: View {
	@ViewBuilder let content: Content

	var body: some View {
		VStack(spacing: 0) { content }
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
			.accessibilityElement(children: .contain)
	}
}

/// One row: a round mark, a label and a detail line, and an optional trailing button (Bring back,
/// Undo). Tapping the text opens the object.
struct SummaryRow: View {
	enum Mark { case done, held, queued, later }
	enum Trailing {
		case none
		case button(String, () -> Void)
	}

	let mark: Mark
	let label: String
	let detail: String
	var open: (() -> Void)?
	var trailing: Trailing = .none

	var body: some View {
		HStack(spacing: MaskinSpace.s7) {
			markView
			Button {
				open?()
			} label: {
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(label)
						.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold)).tracking(-0.15)
						.foregroundStyle(MaskinColor.ink).lineLimit(1)
					Text(detail)
						.font(MaskinTypeface.sans(MaskinFontSize.t13)).foregroundStyle(MaskinColor.ink5)
						.lineLimit(1)
				}
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: .leading)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.disabled(open == nil)
			if case .button(let title, let run) = trailing {
				Button(action: run) {
					Text(title)
						.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold))
						.foregroundStyle(MaskinColor.ink2)
						.padding(.horizontal, MaskinSpace.s7)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
			}
		}
		.padding(.leading, MaskinSpace.s8 + 1).padding(.trailing, MaskinSpace.s4)
		.overlay(alignment: .top) {
			Rectangle().fill(MaskinSurface.separator).frame(height: 1).padding(.leading, MaskinSpace.s8 + 1)
		}
		.accessibilityElement(children: .combine)
	}

	@ViewBuilder private var markView: some View {
		let size: CGFloat = mark == .later ? 28 : MaskinSpace.s12
		let symbol: String = {
			switch mark {
			case .done: "checkmark"
			case .held: "pause"
			case .queued: "arrow.up"
			case .later: "clock"
			}
		}()
		Image(systemName: symbol)
			.maskinSymbol(MaskinFontSize.t12, weight: .bold)
			.foregroundStyle(mark == .later ? MaskinColor.ink4 : MaskinSurface.onInverse)
			.frame(width: size, height: size)
			.background(mark == .later ? MaskinSurface.fill : MaskinSurface.inverse, in: Circle())
			.accessibilityHidden(true)
	}
}

/// The loading skeleton, shown only once loading has taken longer than `after` (the Chat and
/// Objects rule), so a feed that arrives quickly never flashes grey boxes.
struct DelayedSkeleton: View {
	let after: Duration
	@State private var show = false

	var body: some View {
		Group {
			if show { LoadingSkeleton(rows: 3) } else { Color.clear.frame(height: 1) }
		}
		.task {
			try? await Task.sleep(for: after)
			if !Task.isCancelled { show = true }
		}
	}
}
