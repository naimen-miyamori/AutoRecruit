interface BrowserCliLifecycleDependencies {
  exit(code: number): void;
  reportError(error: unknown): void;
}

const defaultDependencies: BrowserCliLifecycleDependencies = {
  exit: (code) => process.exit(code),
  reportError: (error) => console.error(error instanceof Error ? error.message : String(error)),
};

/**
 * A Playwright CDP client has no public detach method and keeps Node's event
 * loop referenced. Once a CLI has completed all awaited work and released its
 * runtime lease, an explicit process exit is the only public-API-only detach.
 * Long-lived server entrypoints must never use this helper.
 */
export async function runBrowserCliMain(
  main: () => Promise<unknown>,
  dependencies: BrowserCliLifecycleDependencies = defaultDependencies,
): Promise<void> {
  try {
    await main();
    dependencies.exit(0);
  } catch (error) {
    dependencies.reportError(error);
    dependencies.exit(1);
  }
}
