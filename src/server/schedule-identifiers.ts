const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, fieldName: string): void {
  if (!uuidPattern.test(value)) {
    throw new Error(`${fieldName} must be a UUID`);
  }
}

export function assertScheduleId(scheduleId: string): void {
  assertUuid(scheduleId, 'scheduleId');
}

export function assertScheduleRunId(runId: string): void {
  assertUuid(runId, 'runId');
}

export function isScheduleId(value: string): boolean {
  return uuidPattern.test(value);
}

export function isScheduleRunId(value: string): boolean {
  return uuidPattern.test(value);
}
