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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
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

function addLocalDays(value: Pick<LocalDateTime, 'year' | 'month' | 'day'>, days: number): Pick<LocalDateTime, 'year' | 'month' | 'day'> {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localDateTimeToEpoch(value: LocalDateTime, timeZone: string): number {
  let candidate = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
  const desired = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = localParts(new Date(candidate), timeZone);
    const observedEpoch = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const adjustment = desired - observedEpoch;
    if (adjustment === 0) {
      return candidate;
    }
    candidate += adjustment;
  }
  return candidate;
}

function localDateAtMinute(
  date: Pick<LocalDateTime, 'year' | 'month' | 'day'>,
  minuteOfDay: number,
  timeZone: string,
): Date {
  const dayOffset = Math.floor(minuteOfDay / 1440);
  const localDate = addLocalDays(date, dayOffset);
  const minute = minuteOfDay % 1440;
  return new Date(localDateTimeToEpoch({
    ...localDate,
    hour: Math.floor(minute / 60),
    minute: minute % 60,
    second: 0,
  }, timeZone));
}

export function getWindowState(now: Date, window: DailyWindow, timeZone: string): WindowState {
  assertTimeZone(timeZone);
  validateDailyWindow(window);
  const start = parseDailyTime(window.start, 'dailyWindow.start');
  const end = parseDailyTime(window.end, 'dailyWindow.end', true);
  const local = localParts(now, timeZone);
  const date = { year: local.year, month: local.month, day: local.day };
  const minute = local.hour * 60 + local.minute;
  const crossesMidnight = start > end;

  if (!crossesMidnight) {
    if (minute >= start && minute < end) {
      return {
        within: true,
        nextStartAt: localDateAtMinute(addLocalDays(date, 1), start, timeZone),
        endAt: localDateAtMinute(date, end, timeZone),
      };
    }
    return {
      within: false,
      nextStartAt: minute < start
        ? localDateAtMinute(date, start, timeZone)
        : localDateAtMinute(addLocalDays(date, 1), start, timeZone),
    };
  }

  if (minute >= start) {
    return {
      within: true,
      nextStartAt: localDateAtMinute(addLocalDays(date, 1), start, timeZone),
      endAt: localDateAtMinute(addLocalDays(date, 1), end, timeZone),
    };
  }
  if (minute < end) {
    return {
      within: true,
      nextStartAt: localDateAtMinute(date, start, timeZone),
      endAt: localDateAtMinute(date, end, timeZone),
    };
  }
  return {
    within: false,
    nextStartAt: localDateAtMinute(date, start, timeZone),
  };
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
