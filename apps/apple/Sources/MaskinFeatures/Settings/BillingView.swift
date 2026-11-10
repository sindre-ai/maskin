import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Billing (2C): the plan, its state and this period's usage, read-only. Owners get the mockup's
/// "Manage on web" button; there is no in-app purchase. Whether App Review 3.1.1 accepts that link
/// is the open question from the D2 report: pass `manageURL: nil` to drop it.
struct BillingView: View {
	@State private var store: BillingStore
	@Environment(\.openURL) private var openURL
	/// The web billing page, set only for owners (2C: non-owners see the summary without the button).
	private let manageURL: URL?

	init(store: BillingStore, manageURL: URL? = nil) {
		_store = State(initialValue: store)
		self.manageURL = manageURL
	}

	var body: some View {
		WorkspacePage(title: "Billing") {
			if let usage = store.usage {
				if let banner = Self.trialBanner(usage) {
					TrialBanner(title: banner.title, detail: banner.detail, actionTitle: manageURL == nil ? nil : "Choose") {
						if let manageURL { openURL(manageURL) }
					}
				}
				PageGroupLabel(text: "Plan")
				PageCard(rows: rows(usage))
				// The percent is shown to everyone: the app does not read the web's percent flag, and
				// there are no dollar or token figures to fall back to.
				if let percent = usage.usedPercent {
					UsageMeter(percent: percent)
					if percent >= Self.warnPercent {
						Text("Work will wait at 100%. Choose a plan to keep going.")
							.font(MaskinTypeface.sans(MaskinFontSize.t13))
							.foregroundStyle(MaskinColor.ink3)
					}
					if let manageURL {
						Button("Upgrade") { openURL(manageURL) }.buttonStyle(.secondaryAction)
					}
				}
				PageFootnote(
					text: "Usage by model, agent and flow is not in the app yet. This is a summary of your plan and this period's usage.")
				if let manageURL, usage.usedFraction == nil {
					Button("Manage on web") { openURL(manageURL) }.buttonStyle(.primaryAction)
				}
			} else {
				switch store.phase {
				case .failed(let message): PageStatus(text: message)
				default: PageStatus(text: "Loading your plan")
				}
			}
		}
		.task { await store.load() }
		.refreshable { await store.load() }
	}

	private func rows(_ usage: BillingUsage) -> [PageRowModel] {
		let healthy = usage.status == .active
		var rows = [
			PageRowModel(
				id: "plan", title: "Plan",
				subtitle: [usage.statusLabel, usage.resetsText].compactMap { $0 }.joined(separator: " · "),
				accessory: .state(PageState(usage.planLabel, healthy ? .active : .muted)))
		]
		if let percent = usage.usedPercent {
			rows.append(
				PageRowModel(
					id: "usage", title: "Agent usage", subtitle: "\(percent)% of plan used",
					accessory: .state(PageState("\(percent)%", .plain))))
		} else {
			rows.append(PageRowModel(id: "usage", title: "Agent usage", subtitle: "This period"))
		}
		// Invoices, auto top-up and the credit balance are not shown: top-up is closed and the web
		// shows usage as a percent of the plan only.
		return rows
	}
}

extension BillingView {
	/// The meter turns to the warning colour here and says work will wait at 100% (the web's 80%).
	static let warnPercent = 80

	/// "Trial ends in 5 days" while on a trial; nil on any paid plan.
	static func trialBanner(_ usage: BillingUsage) -> (title: String, detail: String)? {
		guard usage.plan == "trial", usage.status == .active else { return nil }
		let detail = "Choose a plan to keep your agents running."
		// No end date from the server is not the same as an ended trial: say only what is known.
		guard let ms = usage.resetsInMs else { return ("You are on a trial", detail) }
		guard ms > 0 else { return ("Your trial has ended", detail) }
		let days = Int((Double(ms) / 86_400_000).rounded(.up))
		return ("Trial ends in \(days) \(days == 1 ? "day" : "days")", detail)
	}
}

/// The trial notice at the top of Billing (the same words the app-wide banner uses).
private struct TrialBanner: View {
	let title: String
	let detail: String
	let actionTitle: String?
	let action: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s8) {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(title)
					.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: MaskinFontWeight.semibold))
					.foregroundStyle(MaskinColor.ink)
				Text(detail)
					.font(MaskinTypeface.sans(MaskinFontSize.t13))
					.foregroundStyle(MaskinColor.ink3)
			}
			Spacer(minLength: MaskinSpace.s4)
			if let actionTitle {
				Button(actionTitle, action: action).buttonStyle(.secondaryAction)
			}
		}
		.padding(MaskinSpace.s9)
		.background(MaskinColor.noticeBg, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.accessibilityElement(children: .combine)
	}
}

/// "N% of plan used" with a bar underneath: the same words as the web billing page. Warning colour
/// from 80%, danger at 100%.
private struct UsageMeter: View {
	let percent: Int

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			Text("Plan usage").maskinText(.microLabelLarge).textCase(.uppercase).foregroundStyle(MaskinColor.ink4)
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
				Text("\(percent)%")
					.font(MaskinTypeface.sans(MaskinFontSize.t20, weight: MaskinFontWeight.semibold))
					.foregroundStyle(MaskinColor.ink)
				Text("of plan used")
					.font(MaskinTypeface.sans(MaskinFontSize.t14))
					.foregroundStyle(MaskinColor.ink4)
			}
			ProgressView(value: Double(percent) / 100)
				.tint(tint)
		}
		.padding(MaskinSpace.s9)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.accessibilityElement(children: .combine)
		.accessibilityValue("\(percent) percent of plan used")
	}

	private var tint: Color {
		if percent >= 100 { return MaskinColor.danger }
		if percent >= BillingView.warnPercent { return MaskinColor.noticeFg3 }
		return MaskinColor.sig
	}
}
