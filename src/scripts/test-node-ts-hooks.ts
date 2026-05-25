import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { loadTypeScriptModuleSource, mapLocalJavaScriptSpecifierToTypeScriptPath } from '../../scripts/node-ts-hooks.mjs';

test('mapLocalJavaScriptSpecifierToTypeScriptPath rewrites a sibling .js specifier to .ts when the source file exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autorecruit-node-hooks-'));
  const parentFilePath = path.join(tempDir, 'src', 'scripts', 'test-platform-registry.ts');
  const siblingTypeScriptPath = path.join(tempDir, 'src', 'config.ts');

  fs.mkdirSync(path.dirname(parentFilePath), { recursive: true });
  fs.writeFileSync(parentFilePath, '');
  fs.writeFileSync(siblingTypeScriptPath, 'export const value = 1;');

  const resolved = mapLocalJavaScriptSpecifierToTypeScriptPath(
    '../config.js',
    pathToFileURL(parentFilePath),
  );

  assert.equal(resolved?.href, pathToFileURL(siblingTypeScriptPath).href);
});

test('mapLocalJavaScriptSpecifierToTypeScriptPath keeps non-local specifiers untouched', () => {
  const resolved = mapLocalJavaScriptSpecifierToTypeScriptPath(
    'node:test',
    new URL('file:///workspace/src/scripts/test-platform-registry.ts'),
  );

  assert.equal(resolved, null);
});

test('mapLocalJavaScriptSpecifierToTypeScriptPath does not rewrite non-.js local specifiers', () => {
  const resolved = mapLocalJavaScriptSpecifierToTypeScriptPath(
    '../config.ts',
    new URL('file:///workspace/src/scripts/test-platform-registry.ts'),
  );

  assert.equal(resolved, null);
});

test('mapLocalJavaScriptSpecifierToTypeScriptPath preserves query strings while rewriting .js to .ts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autorecruit-node-hooks-'));
  const parentFilePath = path.join(tempDir, 'src', 'scripts', 'test-platform-registry.ts');
  const siblingTypeScriptPath = path.join(tempDir, 'src', 'browser', 'session.ts');

  fs.mkdirSync(path.dirname(parentFilePath), { recursive: true });
  fs.mkdirSync(path.dirname(siblingTypeScriptPath), { recursive: true });
  fs.writeFileSync(parentFilePath, '');
  fs.writeFileSync(siblingTypeScriptPath, 'export const value = 1;');

  const resolved = mapLocalJavaScriptSpecifierToTypeScriptPath(
    '../browser/session.js?test=123',
    pathToFileURL(parentFilePath),
  );

  assert.equal(resolved?.href, `${pathToFileURL(siblingTypeScriptPath).href}?test=123`);
});

test('loadTypeScriptModuleSource strips type-only usage and preserves ESM exports', () => {
  const transformed = loadTypeScriptModuleSource(
    new URL('file:///workspace/src/example.ts'),
    `
      import { AgeRange, NormalizedJob } from './types/job.js';
      const value: AgeRange | undefined = undefined;
      export const job: NormalizedJob | null = null;
      console.log(value, job);
    `,
  );

  assert.match(transformed, /export const job = null;/);
  assert.doesNotMatch(transformed, /AgeRange/);
  assert.doesNotMatch(transformed, /NormalizedJob/);
});

test('loadTypeScriptModuleSource removes type-only names from mixed imports', () => {
  const transformed = loadTypeScriptModuleSource(
    new URL('file:///workspace/src/index.ts?test=1'),
    `
      import { BrowserSession, closeBrowserSession, ensureAuthenticatedBrowserSession } from './browser/session.js';
      let session: BrowserSession | null = null;
      console.log(closeBrowserSession, ensureAuthenticatedBrowserSession, session);
    `,
  );

  assert.match(transformed, /import \{ closeBrowserSession, ensureAuthenticatedBrowserSession \} from '\.\/browser\/session\.js';/);
  assert.doesNotMatch(transformed, /import \{[^}]*\bBrowserSession\b[^}]*\} from '\.\/browser\/session\.js';/);
  assert.doesNotMatch(transformed, /let session:\s*BrowserSession/);
});
