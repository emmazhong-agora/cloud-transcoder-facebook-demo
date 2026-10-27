import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postApi } from '../public/api.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('local session renewal preserves the exact create body and updates only the marker', async () => {
  const calls = [];
  const settings = { csrf: 'old', appId: 'user-edited-app' };
  const body = { payload: { streamUrl: 'rtmps://example.com/key?a=FAKE_SIGNATURE+%2F==&s_vt=api-s' } };
  const result = await postApi('agora/create', body, settings, async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === 1) return json({ code: 'LAB_SESSION_EXPIRED' }, 403);
    if (url === '/api/config') return json({ csrf: 'new', appId: 'server-default' });
    return json({ data: { taskId: 'created-once' } });
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(calls.map(call => call.url), ['/api/agora/create', '/api/config', '/api/agora/create']);
  assert.equal(calls[0].body, calls[2].body);
  assert.deepEqual(JSON.parse(calls[2].body), body);
  assert.equal(calls[0].headers['X-Lab-Token'], 'old');
  assert.equal(calls[2].headers['X-Lab-Token'], 'new');
  assert.equal(settings.appId, 'user-edited-app');
});

test('upstream and Origin 403 responses are never retried', async () => {
  for (const error of ['Query Transcoder returned HTTP 403', 'Origin rejected']) {
    let calls = 0;
    const result = await postApi('agora/query', {}, { csrf: 'current' }, async () => { calls++; return json({ error }, 403); });
    assert.equal(calls, 1);
    assert.equal(result.response.status, 403);
    assert.equal(result.result.error, error);
  }
});

test('a second session rejection stops without another renewal or replay', async () => {
  let calls = 0;
  const result = await postApi('agora/destroy', {}, { csrf: 'old' }, async url => {
    calls++;
    return url === '/api/config' ? json({ csrf: 'new' }) : json({ code: 'LAB_SESSION_EXPIRED' }, 403);
  });
  assert.equal(result.response.status, 403);
  assert.equal(calls, 3);
});

test('failed session refresh and network failures do not replay operations', async () => {
  let calls = 0;
  await assert.rejects(postApi('agora/create', {}, { csrf: 'old' }, async url => {
    calls++;
    return url === '/api/config' ? json({}, 503) : json({ code: 'LAB_SESSION_EXPIRED' }, 403);
  }), /Could not refresh the local session/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(postApi('agora/create', {}, { csrf: 'current' }, async () => { calls++; throw new TypeError('Failed to fetch'); }), /Failed to fetch/);
  assert.equal(calls, 1);
});
