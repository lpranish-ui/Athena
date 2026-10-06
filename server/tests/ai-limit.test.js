import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createAiLimiter } from '../src/ai-limit.js';

function request(limiter, id = 'student') {
  const res = new EventEmitter();
  res.set = () => res;
  res.status = (status) => { res.statusCode = status; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => res;
  let accepted = false;
  limiter({ user: { id } }, res, () => { accepted = true; });
  return { res, accepted };
}

test('AI work is bounded per account, and finish/close release only once', () => {
  const limiter = createAiLimiter({ maxRequests: 10, maxConcurrent: 1 });
  const first = request(limiter);
  assert.equal(first.accepted, true);
  assert.equal(request(limiter).res.statusCode, 429);
  assert.equal(request(limiter, 'other').accepted, true);
  first.res.emit('finish');
  first.res.emit('close');
  assert.equal(request(limiter).accepted, true);
});

test('hourly limits reset while in-flight work stays counted', () => {
  let now = 0;
  const limiter = createAiLimiter({ maxRequests: 1, maxConcurrent: 2, windowMs: 100, now: () => now });
  request(limiter).res.emit('finish');
  assert.equal(request(limiter).res.statusCode, 429);
  now = 100;
  assert.equal(request(limiter).accepted, true);
});

test('disconnecting a client does not free its still-running AI work', () => {
  const limiter = createAiLimiter({ maxRequests: 10, maxConcurrent: 1 });
  const first = request(limiter);
  first.res.emit('close');
  assert.equal(request(limiter).res.statusCode, 429);
  first.res.end();
  first.res.emit('finish');
  assert.equal(request(limiter).accepted, true);
  assert.equal(request(limiter).res.statusCode, 429);
});
