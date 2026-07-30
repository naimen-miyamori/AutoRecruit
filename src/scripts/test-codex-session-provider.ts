import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isForbiddenCodexToolItem, toCodexStrictOutputSchema } from '../llm/codex-session-provider.js';

describe('Codex session provider tool isolation', () => {
  it('blocks every executable, external, or unknown item type', () => {
    for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'imageView', 'sleep', 'imageGeneration', 'unknown']) {
      assert.equal(isForbiddenCodexToolItem({ type }), true, type);
    }
  });

  it('allows only non-tool lifecycle items through the completion stream', () => {
    assert.equal(isForbiddenCodexToolItem({ type: 'agentMessage', text: '{"ok":true}' }), false);
    assert.equal(isForbiddenCodexToolItem({ type: 'reasoning' }), false);
    assert.equal(isForbiddenCodexToolItem({ type: 'plan' }), false);
    assert.equal(isForbiddenCodexToolItem(undefined), false);
  });

  it('converts optional object properties to the strict nullable output form', () => {
    assert.deepEqual(toCodexStrictOutputSchema({
      type: 'object',
      properties: {
        requiredValue: { type: 'string' },
        optionalValue: { type: 'number' },
      },
      required: ['requiredValue'],
    }), {
      type: 'object',
      properties: {
        requiredValue: { type: 'string' },
        optionalValue: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      },
      required: ['requiredValue', 'optionalValue'],
    });
  });
});
