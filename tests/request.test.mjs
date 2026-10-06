import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchText } from '../src/lib/request.ts';

test('deadline also covers a response body that never finishes', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) });
  try {
    await assert.rejects(fetchText('http://local.test', {}, 20), /timed out/);
  } finally {
    globalThis.fetch = previous;
  }
});

test('deadline rejects even when a fetch implementation ignores abort', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    await assert.rejects(fetchText('http://local.test', {}, 20), /timed out/);
  } finally {
    globalThis.fetch = previous;
  }
});

test('HTTP failures remain available to the API error mapper', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"Not signed in"}', { status: 401 });
  try {
    assert.deepEqual(await fetchText('http://local.test', {}, 100), {
      ok: false, status: 401, text: '{"error":"Not signed in"}',
    });
  } finally {
    globalThis.fetch = previous;
  }
});
