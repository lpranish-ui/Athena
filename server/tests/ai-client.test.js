import assert from 'node:assert/strict';
import test from 'node:test';
import { chatJson } from '../src/ai.js';

test('JSON-mode requests include an explicit instruction without mutating caller messages', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'local-mocked-provider-key';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    assert.ok(payload.messages.some((message) => message.role === 'system' && /\bJSON\b/.test(message.content)));
    assert.deepEqual(payload.response_format, { type: 'json_object' });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const messages = Object.freeze([
    Object.freeze({ role: 'system', content: 'Return {"answer":"..."}.' }),
    Object.freeze({ role: 'user', content: 'Where is the synthetic preview stored?' }),
  ]);
  assert.equal(await chatJson({ messages, thinking: 'disabled' }), '{"ok":true}');
  assert.equal(messages[0].content, 'Return {"answer":"..."}.');
  assert.equal(messages.length, 2);
  assert.match(payloads[0].messages[0].content, /Return one valid JSON object only/);
  const noSystem = Object.freeze([Object.freeze({ role: 'user', content: 'Return {"ok":true}.' })]);
  await chatJson({ messages: noSystem, thinking: 'disabled' });
  assert.equal(noSystem.length, 1);
  assert.equal(payloads[1].messages[0].role, 'system');
  assert.equal(payloads[1].messages[1].content, noSystem[0].content);
});
