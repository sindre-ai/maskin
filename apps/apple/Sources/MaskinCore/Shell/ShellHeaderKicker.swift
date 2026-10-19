import Foundation

/// The small line above a root screen's title.
public enum ShellHeaderKicker {
	/// "SUN 18 OCT" in the UK, "SUN OCT 18" in the US: weekday, day and month, localised by the locale.
	public static func date(_ date: Date, calendar: Calendar = .current, locale: Locale = .current)
		-> String
	{
		let formatter = DateFormatter()
		formatter.locale = locale
		formatter.calendar = calendar
		formatter.timeZone = calendar.timeZone
		formatter.setLocalizedDateFormatFromTemplate("EEEdMMM")
		return formatter.string(from: date).replacingOccurrences(of: ",", with: "").uppercased()
	}
}
