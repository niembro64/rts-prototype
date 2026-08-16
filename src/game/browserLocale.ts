const CLOCK_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'short',
};
const MAX_TIMEZONE_CLOCK_FORMATTERS = 32;

let localClockFormatter: Intl.DateTimeFormat | null = null;
const timezoneClockFormatters = new Map<string, Intl.DateTimeFormat>();

export function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

function getClockFormatter(timezone?: string): Intl.DateTimeFormat {
  if (!timezone) {
    localClockFormatter ??= new Intl.DateTimeFormat('en-US', CLOCK_FORMAT_OPTIONS);
    return localClockFormatter;
  }
  const cached = timezoneClockFormatters.get(timezone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    ...CLOCK_FORMAT_OPTIONS,
    timeZone: timezone,
  });
  if (timezoneClockFormatters.size >= MAX_TIMEZONE_CLOCK_FORMATTERS) {
    const oldestTimezone = timezoneClockFormatters.keys().next().value;
    if (oldestTimezone !== undefined) timezoneClockFormatters.delete(oldestTimezone);
  }
  timezoneClockFormatters.set(timezone, formatter);
  return formatter;
}

export function formatBrowserClockTime(
  timezone?: string,
  date: Date = new Date(),
): string | undefined {
  try {
    return getClockFormatter(timezone).format(date);
  } catch {
    return undefined;
  }
}
