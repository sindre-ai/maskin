import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

// MARK: Hosting inside the profile sheet's stack

private struct PushedInHostStackKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
	/// True when a screen is pushed onto the profile sheet's single `NavigationStack`. Such a screen
	/// must not wrap itself in a stack or add a Done button; the sheet owns both.
	var isPushedInHostStack: Bool {
		get { self[PushedInHostStackKey.self] }
		set { self[PushedInHostStackKey.self] = newValue }
	}
}

/// Wraps `content` in its own `NavigationStack` when the screen is shown standalone (a sheet,
/// a tab), and leaves it bare when it is pushed onto a host stack.
struct StandaloneStack<Content: View>: View {
	@Environment(\.isPushedInHostStack) private var pushed
	@ViewBuilder let content: Content

	var body: some View {
		if pushed { content } else { NavigationStack { content } }
	}
}

// MARK: Pushed workspace pages (Members, Integrations, Triggers, Billing, Keys)

/// One row on a pushed page: title 16/600, sub 13 in ink4, an optional trailing state (14/650) or
/// switch, and an optional leading avatar.
struct PageRowModel: Identifiable {
	enum Accessory {
		case none
		case state(PageState)
		case toggle(isOn: Bool, set: (Bool) -> Void)
	}

	let id: String
	var title: String
	var subtitle: String?
	var avatar: (name: String, isAgent: Bool)?
	var accessory: Accessory = .none
	var showsChevron = false
	var action: (() -> Void)?
}

extension PageStateTone {
	var color: Color {
		switch self {
		case .active: MaskinColor.sigInk
		case .muted: MaskinColor.ink5
		case .notice: MaskinColor.warning
		case .plain: MaskinColor.ink3
		}
	}
}

/// A grouped white card of rows with hairlines between them.
struct PageCard: View {
	let rows: [PageRowModel]

	var body: some View {
		VStack(spacing: 0) {
			ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
				if index > 0 {
					Rectangle().fill(MaskinSurface.separator).frame(height: 1)
						.padding(.leading, MaskinSpace.s9)
				}
				PageRow(model: row)
			}
		}
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
	}
}

private struct PageRow: View {
	let model: PageRowModel

	var body: some View {
		if let action = model.action {
			Button(action: action) { content }
				.buttonStyle(.maskinPressed)
		} else {
			content
		}
	}

	private var content: some View {
		HStack(spacing: MaskinSpace.s7) {
			if let avatar = model.avatar {
				ActorAvatar(name: avatar.name, kind: avatar.isAgent ? .agent : .human, size: MaskinSpace.s14)
			}
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(model.title)
					.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: MaskinFontWeight.semibold))
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(1)
				if let subtitle = model.subtitle {
					Text(subtitle)
						.font(MaskinTypeface.sans(MaskinFontSize.t13))
						.foregroundStyle(MaskinColor.ink4)
						.lineLimit(2)
						.multilineTextAlignment(.leading)
				}
			}
			Spacer(minLength: MaskinSpace.s4)
			accessory
			if model.showsChevron {
				Image(systemName: "chevron.right")
					.font(.system(size: MaskinSpace.s7, weight: .semibold))
					.foregroundStyle(MaskinColor.ink5)
					.accessibilityHidden(true)
			}
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.vertical, MaskinSpace.s8)
		.frame(minHeight: MaskinSpace.touchMin)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
	}

	@ViewBuilder private var accessory: some View {
		switch model.accessory {
		case .none: EmptyView()
		case .state(let state):
			Text(state.text)
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.w650))
				.foregroundStyle(state.tone.color)
		case .toggle(let isOn, let set):
			Toggle(model.title, isOn: Binding(get: { isOn }, set: set))
				.labelsHidden()
				.tint(MaskinColor.sig)
		}
	}
}

/// The scaffold of a pushed page: a native large title, optional group label, cards, a footnote
/// and an optional primary button, on the ambient canvas.
struct WorkspacePage<Content: View>: View {
	let title: String
	@ViewBuilder let content: Content

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s9) { content }
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s9)
		}
		.ambientBackground()
		.foregroundStyle(MaskinColor.ink)
		.navigationTitle(title)
		#if os(iOS)
			.navigationBarTitleDisplayMode(.large)
		#endif
	}
}

struct PageGroupLabel: View {
	let text: String
	var body: some View {
		Text(text)
			.maskinText(.microLabelLarge)
			.textCase(.uppercase)
			.foregroundStyle(MaskinColor.ink4)
			.padding(.horizontal, MaskinSpace.s2)
			.accessibilityAddTraits(.isHeader)
	}
}

struct PageFootnote: View {
	let text: String
	var body: some View {
		Text(text)
			.font(MaskinTypeface.sans(MaskinFontSize.t13))
			.foregroundStyle(MaskinColor.ink4)
			.padding(.horizontal, MaskinSpace.s7)
			.fixedSize(horizontal: false, vertical: true)
	}
}

/// A centred one-line status for loading and error states inside a page.
struct PageStatus: View {
	let text: String
	var body: some View {
		Text(text)
			.font(MaskinTypeface.sans(MaskinFontSize.t14))
			.foregroundStyle(MaskinColor.ink4)
			.frame(maxWidth: .infinity)
			.padding(.vertical, MaskinSpace.s12)
	}
}
