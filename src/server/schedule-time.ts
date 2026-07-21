export interface DailyWindow {
  start: string;
  end: string;
}

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface WindowInterval {
  start: Date;
  end: Date;
}

type BoundaryDisambiguation = 'earlier' | 'later';

export interface WindowState {
  within: boolean;
  nextStartAt: Date;
  endAt?: Date;
}

function parseInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  return parsed;
}

export function parseDailyTime(value: string, fieldName: string, allowEndOfDay = false): number {
  if (!/^\d{2}:\d{2}$/.test(value)) {
    throw new Error(`${fieldName} must use HH:mm format`);
  }

  const [hoursText, minutesText] = value.split(':');
  const hours = parseInteger(hoursText!, fieldName);
  const minutes = parseInteger(minutesText!, fieldName);
  if (minutes < 0 || minutes > 59 || hours < 0 || hours > (allowEndOfDay ? 24 : 23)) {
    throw new Error(`${fieldName} must be a valid local time`);
  }
  if (hours === 24 && minutes !== 0) {
    throw new Error(`${fieldName} can only use 24:00 at the end of a day`);
  }
  return hours * 60 + minutes;
}

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
  } catch {
    throw new Error(`timeZone is invalid: ${timeZone}`);
  }
}

export function validateDailyWindow(window: DailyWindow): void {
  const start = parseDailyTime(window.start, 'dailyWindow.start');
  const end = parseDailyTime(window.end, 'dailyWindow.end', true);
  if (start === end) {
    throw new Error('dailyWindow.start and dailyWindow.end cannot be the same');
  }
}

function localParts(date: Date, timeZone: string): LocalDateTime {
  const formatter = localFormatters.get(timeZone) ?? new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  localFormatters.set(timeZone, formatter);
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  };
}

const localFormatters = new Map<string, Intl.DateTimeFormat>();

function wallEpoch(value: LocalDateTime): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
}

function sameLocalTime(left: LocalDateTime, right: LocalDateTime): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function localDateTimeToEpoch(
  value: LocalDateTime,
  timeZone: string,
  disambiguation: BoundaryDisambiguation,
): number | undefined {
  const desired = wallEpoch(value);
  const offsets = new Set<number>();

  // Sampling the surrounding wall-clock range finds both offsets on a fall-back transition.
  for (let hours = -48; hours <= 48; hours += 6) {
    const reference = desired + hours * 60 * 60 * 1000;
    const observed = localParts(new Date(reference), timeZone);
    offsets.add(wallEpoch(observed) - reference);
  }

  const candidates = [...offsets]
    .map((offset) => desired - offset)
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .filter((candidate) => sameLocalTime(localParts(new Date(candidate), timeZone), value))
    .sort((left, right) => left - right);

  if (candidates.length > 0) {
    return disambiguation === 'earlier' ? candidates[0] : candidates[candidates.length - 1];
  }

  // A spring-forward gap has no exact instant. Roll the boundary to the first valid
  // minute on the same local date so it cannot produce a past wake-up time.
  const searchStart = desired - 18 * 60 * 60 * 1000;
  const searchEnd = desired + 42 * 60 * 60 * 1000;
  for (let candidate = searchStart; candidate <= searchEnd; candidate += 60 * 1000) {
    const observed = localParts(new Date(candidate), timeZone);
    if (
      observed.year === value.year
      && observed.month === value.month
      && observed.day === value.day
      && observed.second === 0
      && wallEpoch(observed) >= desired
    ) {
      return candidate;
    }
  }

  return undefined;
}

function addLocalDays(value: Pick<LocalDateTime, 'year' | 'month' | 'day'>, days: number): Pick<LocalDateTime, 'year' | 'month' | 'day'> {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localDateAtMinute(
  date: Pick<LocalDateTime, 'year' | 'month' | 'day'>,
  minuteOfDay: number,
  timeZone: string,
  disambiguation: BoundaryDisambiguation,
): Date | undefined {
  const dayOffset = Math.floor(minuteOfDay / 1440);
  const localDate = addLocalDays(date, dayOffset);
  const minute = minuteOfDay % 1440;
  const epoch = localDateTimeToEpoch({
    ...localDate,
    hour: Math.floor(minute / 60),
    minute: minute % 60,
    second: 0,
  }, timeZone, disambiguation);
  return epoch === undefined ? undefined : new Date(epoch);
}

export function getWindowState(now: Date, window: DailyWindow, timeZone: string): WindowState {
  assertTimeZone(timeZone);
  validateDailyWindow(window);
  const start = parseDailyTime(window.start, 'dailyWindow.start');
  const end = parseDailyTime(window.end, 'dailyWindow.end', true);
  const local = localParts(now, timeZone);
  const date = { year: local.year, month: local.month, day: local.day };
  const crossesMidnight = start > end;

  const intervals: WindowInterval[] = [];
  for (let dayOffset = -2; dayOffset <= 8; dayOffset += 1) {
    const startDate = addLocalDays(date, dayOffset);
    const endDate = addLocalDays(startDate, crossesMidnight ? 1 : 0);
    const startAt = localDateAtMinute(startDate, start, timeZone, 'earlier');
    const endAt = localDateAtMinute(endDate, end, timeZone, 'later');
    if (startAt && endAt && endAt.getTime() > startAt.getTime()) {
      intervals.push({ start: startAt, end: endAt });
    }
  }

  intervals.sort((left, right) => left.start.getTime() - right.start.getTime());
  const nowTime = now.getTime();
  const current = intervals.find((interval) => nowTime >= interval.start.getTime() && nowTime < interval.end.getTime());
  const next = intervals.find((interval) => interval.start.getTime() > nowTime);

  if (current && next) {
    return { within: true, nextStartAt: next.start, endAt: current.end };
  }
  if (!current && next) {
    return { within: false, nextStartAt: next.start };
  }

  throw new Error('Could not resolve the next daily window boundary');
}

export function resolveNextEligibleStart(
  finishedAt: Date,
  delaySeconds: number,
  window: DailyWindow,
  timeZone: string,
): Date {
  const target = new Date(finishedAt.getTime() + Math.max(1, delaySeconds) * 1000);
  const state = getWindowState(target, window, timeZone);
  return state.within ? target : state.nextStartAt;
}
