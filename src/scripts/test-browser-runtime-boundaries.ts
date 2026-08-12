import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const sourceRoot = path.resolve('src');

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const filePath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(filePath) : [filePath];
  }));
  return nested.flat();
}

describe('login-owned browser runtime boundaries', () => {
  it('does not retain legacy runtime switches, factories, or test isolation', async () => {
    const [packageSource, configSource, sessionSource] = await Promise.all([
      fs.readFile(path.resolve('package.json'), 'utf8'),
      fs.readFile(path.join(sourceRoot, 'config.ts'), 'utf8'),
      fs.readFile(path.join(sourceRoot, 'browser', 'session.ts'), 'utf8'),
    ]);
    const retiredSymbols = [
      'AUTORECRUIT_BROWSER_RUNTIME_POLICY',
      'BrowserRuntimePolicy',
      'resolveBrowserRuntimePolicy',
      'createBrowserSession',
      'createFreshBrowserSession',
      'createPersistentBrowserSession',
      'PLAYWRIGHT_51JOB_REUSE_BROWSER',
      'PLAYWRIGHT_LIEPIN_REUSE_BROWSER',
      'PLAYWRIGHT_ZHILIAN_REUSE_BROWSER',
      'PLAYWRIGHT_BOSS_REUSE_BROWSER',
    ];
    for (const symbol of retiredSymbols) {
      assert.equal(packageSource.includes(symbol), false, `${symbol} remains in package.json`);
      assert.equal(configSource.includes(symbol), false, `${symbol} remains in config.ts`);
      assert.equal(sessionSource.includes(symbol), false, `${symbol} remains in browser/session.ts`);
    }
  });

  it('keeps production browser launch exclusively in the login runtime owner', async () => {
    const files = (await listFiles(sourceRoot))
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => !file.includes(`${path.sep}scripts${path.sep}test-`));
    const offenders: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      if (/\.(?:launch|launchPersistentContext)\s*\(/.test(source)
        && !file.endsWith(path.join('browser', 'platform-runtime.ts'))) {
        offenders.push(path.relative(sourceRoot, file));
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it('keeps direct production session creation imports out of runners, server, platforms, and mapping', async () => {
    const roots = ['mode-runners', 'server', 'platforms', 'talent-mapping'];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of (await listFiles(path.join(sourceRoot, root))).filter((item) => item.endsWith('.ts') && !item.includes('test-'))) {
        const source = await fs.readFile(file, 'utf8');
        if (/\bcreate(?:Fresh|Persistent)?BrowserSession\b/.test(source)) offenders.push(path.relative(sourceRoot, file));
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it('uses explicit login-owned process teardown in every session-attaching script entrypoint', async () => {
    const offenders: string[] = [];
    for (const file of (await listFiles(path.join(sourceRoot, 'scripts')))
      .filter((item) => item.endsWith('.ts') && !path.basename(item).startsWith('test-'))) {
      const source = await fs.readFile(file, 'utf8');
      const ownsBrowserCliLifecycle = source.includes('ensureAuthenticatedBrowserSession')
        || source.includes('verifyCoreSavedSearchTarget')
        || path.basename(file) === 'run-search-operation.ts';
      if (ownsBrowserCliLifecycle && !source.includes('runBrowserCliMain')) {
        offenders.push(path.relative(sourceRoot, file));
      }
    }
    assert.deepStrictEqual(offenders, []);
  });
});
