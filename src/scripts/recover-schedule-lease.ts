import { config } from '../config.js';
import { assertScheduleId } from '../server/schedule-identifiers.js';
import { ScheduleStore } from '../server/schedule-store.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const scheduleId = argument('--schedule-id');
  const confirmation = argument('--confirm-processes-stopped');
  const ownerToken = argument('--owner-token');
  if (!scheduleId) throw new Error('--schedule-id is required');
  assertScheduleId(scheduleId);
  if (confirmation !== 'true') {
    throw new Error('--confirm-processes-stopped true is required after stopping every API and scheduler process');
  }

  const result = await new ScheduleStore(config.dataDir).recoverScheduleLease(scheduleId, {
    processesStopped: true,
    ...(ownerToken ? { confirmedToken: ownerToken } : {}),
  });
  if (!result.recovered) {
    console.log(`No schedule lease exists for ${scheduleId}`);
    return;
  }
  console.log(`Schedule lease moved to quarantine: ${result.quarantinePath}`);
}

await main();
