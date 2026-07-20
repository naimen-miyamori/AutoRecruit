function parseArgs(argv: readonly string[]): { action: 'start' | 'pause' | 'stop' | 'run-now' | 'stop-all'; scheduleId?: string } {
  const action = argv[0];
  if (action !== 'start' && action !== 'pause' && action !== 'stop' && action !== 'run-now' && action !== 'stop-all') {
    throw new Error('Usage: schedule-control <start|pause|stop|run-now|stop-all> [--schedule-id <id>]');
  }
  const scheduleIndex = argv.indexOf('--schedule-id');
  const scheduleId = scheduleIndex >= 0 ? argv[scheduleIndex + 1]?.trim() : undefined;
  if (action !== 'stop-all' && !scheduleId) {
    throw new Error('--schedule-id is required unless action is stop-all');
  }
  return { action, scheduleId };
}

async function main(): Promise<void> {
  const { action, scheduleId } = parseArgs(process.argv.slice(2));
  const baseUrl = (process.env.AUTORECRUIT_CONSOLE_URL ?? 'http://127.0.0.1:4180').replace(/\/$/, '');
  const pathname = action === 'stop-all'
    ? '/api/schedules/stop-all'
    : `/api/schedules/${encodeURIComponent(scheduleId!)}/${action}`;
  const response = await fetch(`${baseUrl}${pathname}`, { method: 'POST' });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(body || `${response.status} ${response.statusText}`);
  }
  console.log(body);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
