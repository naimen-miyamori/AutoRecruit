import test from 'node:test';
import assert from 'node:assert/strict';

import { config, resolveStorageStatePath } from '../config.js';
import { getPlatformAdapter, listSupportedPlatforms, parsePlatformArg } from '../platforms/registry.js';

test('listSupportedPlatforms returns the stable supported platform order', () => {
  assert.deepEqual(listSupportedPlatforms(), ['51job', 'liepin', 'zhilian']);
});

test('parsePlatformArg defaults to 51job', () => {
  assert.equal(parsePlatformArg(), '51job');
});

test('parsePlatformArg accepts supported platform values', () => {
  assert.equal(parsePlatformArg('51job'), '51job');
  assert.equal(parsePlatformArg('liepin'), 'liepin');
  assert.equal(parsePlatformArg('zhilian'), 'zhilian');
});

test('parsePlatformArg rejects unsupported platforms with supported values in the error', () => {
  assert.throws(
    () => parsePlatformArg('boss'),
    /Unsupported platform: boss\. Supported platforms: 51job, liepin, zhilian/,
  );
});

test('resolveStorageStatePath returns platform-specific default paths', () => {
  const originalStorageStatePath = process.env.STORAGE_STATE_PATH;
  delete process.env.STORAGE_STATE_PATH;

  try {
    assert.match(resolveStorageStatePath('51job'), /storage-state\.json$/);
    assert.match(resolveStorageStatePath('liepin'), /storage-state\.liepin\.json$/);
    assert.match(resolveStorageStatePath('zhilian'), /storage-state\.zhilian\.json$/);
  } finally {
    if (originalStorageStatePath === undefined) {
      delete process.env.STORAGE_STATE_PATH;
    } else {
      process.env.STORAGE_STATE_PATH = originalStorageStatePath;
    }
  }
});

test('resolveStorageStatePath honors platform-specific STORAGE_STATE_PATH overrides', () => {
  const originalStorageStatePath = process.env.STORAGE_STATE_PATH;

  try {
    process.env.STORAGE_STATE_PATH = '/tmp/custom-51job-storage-state.json';
    assert.equal(resolveStorageStatePath('51job'), '/tmp/custom-51job-storage-state.json');

    process.env.STORAGE_STATE_PATH = '/tmp/custom-liepin-storage-state.json';
    assert.equal(resolveStorageStatePath('liepin'), '/tmp/custom-liepin-storage-state.json');

    process.env.STORAGE_STATE_PATH = '/tmp/custom-zhilian-storage-state.json';
    assert.equal(resolveStorageStatePath('zhilian'), '/tmp/custom-zhilian-storage-state.json');
  } finally {
    if (originalStorageStatePath === undefined) {
      delete process.env.STORAGE_STATE_PATH;
    } else {
      process.env.STORAGE_STATE_PATH = originalStorageStatePath;
    }
  }
});

test('resolveStorageStatePath rejects cross-platform or shared STORAGE_STATE_PATH overrides', () => {
  const originalStorageStatePath = process.env.STORAGE_STATE_PATH;

  try {
    process.env.STORAGE_STATE_PATH = '/tmp/storage-state.json';
    assert.throws(() => resolveStorageStatePath('liepin'), /not safe for liepin/);
    assert.throws(() => resolveStorageStatePath('zhilian'), /not safe for zhilian/);

    process.env.STORAGE_STATE_PATH = '/tmp/custom-liepin-storage-state.json';
    assert.throws(() => resolveStorageStatePath('51job'), /not safe for 51job/);
    assert.throws(() => resolveStorageStatePath('zhilian'), /not safe for zhilian/);
  } finally {
    if (originalStorageStatePath === undefined) {
      delete process.env.STORAGE_STATE_PATH;
    } else {
      process.env.STORAGE_STATE_PATH = originalStorageStatePath;
    }
  }
});

test('browser pacing and reuse defaults are platform-specific', () => {
  assert.deepEqual(config.playwright.actionDelayMinMsByPlatform, {
    '51job': 0,
    liepin: 2000,
    zhilian: 0,
  });
  assert.deepEqual(config.playwright.actionDelayMaxMsByPlatform, {
    '51job': 0,
    liepin: 3000,
    zhilian: 0,
  });
  assert.deepEqual(config.playwright.candidateDelayMinMsByPlatform, {
    '51job': 0,
    liepin: 2000,
    zhilian: 0,
  });
  assert.deepEqual(config.playwright.candidateDelayMaxMsByPlatform, {
    '51job': 0,
    liepin: 3000,
    zhilian: 0,
  });
  assert.deepEqual(config.playwright.reuseBrowserByPlatform, {
    '51job': false,
    liepin: true,
    zhilian: false,
  });
  assert.deepEqual(config.playwright.reuseCdpPortByPlatform, {
    '51job': 19325,
    liepin: 19327,
    zhilian: 19329,
  });
});

test('51job adapter exposes the shared auth contract', () => {
  const fiftyOneJobAdapter = getPlatformAdapter('51job');
  assert.equal(fiftyOneJobAdapter.platform, '51job');
  assert.equal(fiftyOneJobAdapter.displayName, '51job');
  assert.equal(fiftyOneJobAdapter.subscribeSearchUrl, 'https://ehire.51job.com/Revision/talent/subscribe');
  assert.equal(fiftyOneJobAdapter.loginUrl, 'https://ehire.51job.com/Revision/talent/subscribe');
  assert.equal(fiftyOneJobAdapter.storageStateFileName, 'storage-state.json');
  assert.equal(typeof fiftyOneJobAdapter.openLoginPage, 'function');
  assert.equal(typeof fiftyOneJobAdapter.openAuthenticatedHome, 'function');
  assert.equal(typeof fiftyOneJobAdapter.assertAuthenticated, 'function');
  assert.equal(typeof fiftyOneJobAdapter.openSubscribeSearch, 'function');
  assert.equal(typeof fiftyOneJobAdapter.extractCandidateList, 'function');
  assert.equal(typeof fiftyOneJobAdapter.openResumeDetail, 'function');
  assert.equal(typeof fiftyOneJobAdapter.parseResumeDetail, 'function');
});

test('liepin adapter exposes the shared auth contract', () => {
  const liepinAdapter = getPlatformAdapter('liepin');
  assert.equal(liepinAdapter.platform, 'liepin');
  assert.equal(liepinAdapter.displayName, 'Liepin');
  assert.equal(liepinAdapter.subscribeSearchUrl, 'https://h.liepin.com/search/getConditionItem');
  assert.equal(liepinAdapter.loginUrl, 'https://h.liepin.com/account/login');
  assert.equal(liepinAdapter.storageStateFileName, 'storage-state.liepin.json');
  assert.equal(typeof liepinAdapter.openLoginPage, 'function');
  assert.equal(typeof liepinAdapter.openAuthenticatedHome, 'function');
  assert.equal(typeof liepinAdapter.assertAuthenticated, 'function');
  assert.equal(typeof liepinAdapter.openSubscribeSearch, 'function');
  assert.equal(typeof liepinAdapter.extractCandidateList, 'function');
  assert.equal(typeof liepinAdapter.openResumeDetail, 'function');
  assert.equal(typeof liepinAdapter.parseResumeDetail, 'function');
});

test('zhilian adapter exposes the shared auth contract', () => {
  const zhilianAdapter = getPlatformAdapter('zhilian');
  assert.equal(zhilianAdapter.platform, 'zhilian');
  assert.equal(zhilianAdapter.displayName, 'Zhilian');
  assert.equal(zhilianAdapter.subscribeSearchUrl, 'https://rd6.zhaopin.com/app/search');
  assert.equal(zhilianAdapter.loginUrl, 'https://passport.zhaopin.com/org/login');
  assert.equal(zhilianAdapter.storageStateFileName, 'storage-state.zhilian.json');
  assert.equal(typeof zhilianAdapter.openLoginPage, 'function');
  assert.equal(typeof zhilianAdapter.openAuthenticatedHome, 'function');
  assert.equal(typeof zhilianAdapter.assertAuthenticated, 'function');
  assert.equal(typeof zhilianAdapter.openSubscribeSearch, 'function');
  assert.equal(typeof zhilianAdapter.extractCandidateList, 'function');
  assert.equal(typeof zhilianAdapter.openResumeDetail, 'function');
  assert.equal(typeof zhilianAdapter.parseResumeDetail, 'function');
});
