import SwiftUI

/// A timestamp that re-renders once a minute. Renders nothing for a nil date.
public struct RelativeTime: View {
	private let date: Date?
	private let style: RelativeTimeFormatter.Style
	private let compactDayLimit: Int

	public init(_ date: Date?, style: RelativeTimeFormatter.Style = .relative, compactDayLimit: Int = 30) {
		self.date = date
		self.style = style
		self.compactDayLimit = compactDayLimit
	}

	public var body: some View {
		if let date {
			TimelineView(.everyMinute) { context in
				Text(RelativeTimeFormatter.string(for: date, now: context.date, style: style, compactDayLimit: compactDayLimit))
					.accessibilityLabel(Text(date, format: .dateTime.day().month().year().hour().minute()))
			}
		}
	}
}

#Preview("RelativeTime") {
	VStack(alignment: .leading) {
		RelativeTime(Date().addingTimeInterval(-90))
		RelativeTime(Date().addingTimeInterval(-7200), style: .compact)
		RelativeTime(Date().addingTimeInterval(-3600), style: .clock)
	}
	.padding()
}
