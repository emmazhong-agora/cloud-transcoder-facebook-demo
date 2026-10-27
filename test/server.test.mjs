import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { defaultPayload, combineDestination, inspectDestination, redact } from '../public/config.js';
import { postApi } from '../public/api.js';

const env = { AGORA_APP_ID: 'a'.repeat(32), AGORA_CUSTOMER_ID: 'customer-key', AGORA_CUSTOMER_SECRET: 'customer-secret', META_PAGE_ACCESS_TOKEN: 'meta-page-secret', META_PAGE_ID: '123' };
const streamUrl = 'rtmps://live-api-s.facebook.com:443/rtmp/000000000000000?s_bl=1&s_ow=10&s_psm=1&s_pub=1&s_sw=0&s_tids=1&s_vt=api-s&a=FAKE_SIGNATURE+Some%2FValue==';
const payload = () => {
  const result = structuredClone(defaultPayload), config = result.services.cloudTranscoder.config.transcoder;
  config.outputs[0].streamUrl = [streamUrl];
  config.audioInputs[0].rtc.rtcToken = 'audio-test-token';
  config.videoInputs[0].rtc.rtcToken = 'video-test-token';
  return result;
};
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'X-Request-ID': 'upstream-request-id' } });
async function fixture(t, fetcher, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcoder-lab-'));
  const stateFile = path.join(dir, 'tasks.json');
  const server = await createApp({ env: { ...env, ...overrides }, fetcher, stateFile });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const settings = await fetch(`${base}/api/config`).then(res => res.json());
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { server, base, settings, stateFile, post: async (route, body, extra = {}) => {
    const res = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': settings.csrf, ...extra }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  } };
}

test('signed destination keeps every query byte, including plus and percent encoding', () => {
  assert.equal(combineDestination('rtmps://live-api-s.facebook.com:443/rtmp/', streamUrl.split('/rtmp/')[1]), streamUrl);
  assert.deepEqual(inspectDestination(streamUrl).queryNames, ['s_bl', 's_ow', 's_psm', 's_pub', 's_sw', 's_tids', 's_vt', 'a']);
  assert.equal(inspectDestination(streamUrl.replace('&s_ow', '&amp;s_ow')).htmlEscaped, true);
  assert.throws(() => combineDestination('rtmps://example.com/', 'key\n'));
  assert.throws(() => inspectDestination('https://example.com/key'));
});

test('Acquire/Create/Query/Destroy preserve customer JSON and retain stop credentials across restarts', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (String(url).endsWith('/builderTokens')) return response({ tokenName: 'builder+token/=' });
    return response({ taskId: 'task-1', status: options.method === 'DELETE' ? 'STOPPING' : 'IN_PROGRESS' });
  });
  const sent = payload();
  const created = await f.post('agora/create', { payload: sent });
  assert.equal(created.status, 200);
  assert.deepEqual(JSON.parse(calls[0].body).services, sent.services);
  assert.deepEqual(JSON.parse(calls[1].body), sent);
  assert.equal(JSON.parse(calls[1].body).services.cloudTranscoder.config.transcoder.outputs[0].streamUrl[0], streamUrl);
  assert.equal(new URL(calls[1].url).searchParams.get('builderToken'), 'builder+token/=');
  assert.equal(calls[1].headers.Authorization, 'Basic ' + Buffer.from('customer-key:customer-secret').toString('base64'));
  assert.match(calls[1].headers['X-Request-ID'], /^[\da-f-]{36}$/);
  const handle = created.data.handle;
  await f.post('agora/query', { handle });
  const destroyed = await f.post('agora/destroy', { handle });
  assert.equal(destroyed.data.data.status, 'STOPPING');
  assert.equal(calls[2].method, 'GET'); assert.equal(calls[3].method, 'DELETE');
  assert.equal(calls[2].body, undefined); assert.equal(calls[3].body, undefined);
  for (const secret of [streamUrl, 'audio-test-token', 'video-test-token', 'builder+token/=', 'customer-secret']) assert.equal(JSON.stringify(created.data).includes(secret), false);
  const persisted = JSON.parse(await readFile(f.stateFile));
  assert.equal(persisted[handle].builderToken, 'builder+token/=');
  const restored = await createApp({ env, stateFile: f.stateFile });
  await new Promise(resolve => restored.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => restored.close(resolve)));
  const restoredConfig = await fetch(`http://127.0.0.1:${restored.address().port}/api/config`).then(res => res.json());
  assert.equal(restoredConfig.tasks[0].handle, handle);
  assert.equal(restoredConfig.tasks[0].status, 'STOPPING');
});

test('string streamUrl remains a string without silent normalization', async t => {
  const bodies = [];
  const f = await fixture(t, async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return response(String(url).endsWith('/builderTokens') ? { tokenName: 'token' } : { taskId: 'task-2', status: 'STARTED' });
  });
  const sent = payload(); sent.services.cloudTranscoder.config.transcoder.outputs[0].streamUrl = streamUrl;
  assert.equal((await f.post('agora/create', { payload: sent })).status, 200);
  assert.equal(bodies[1].services.cloudTranscoder.config.transcoder.outputs[0].streamUrl, streamUrl);
});

test('failed acquire never creates, preserves upstream error and request ID', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response({ message: 'invalid credentials' }, 401); });
  const result = await f.post('agora/create', { payload: payload() });
  assert.equal(result.status, 401); assert.equal(calls, 1);
  assert.equal(result.data.traces[0].response.message, 'invalid credentials');
  assert.equal(result.data.traces[0].responseRequestId, 'upstream-request-id');
});

test('placeholder payloads and cross-origin or missing-CSRF requests never reach upstream', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response({}); });
  assert.equal((await f.post('agora/create', { payload: defaultPayload })).status, 400);
  const crossOrigin = await f.post('agora/create', { payload: payload() }, { Origin: 'https://other.test' });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.data.code, undefined);
  const stale = await f.post('agora/create', { payload: payload() }, { 'X-Lab-Token': 'old-session' });
  assert.equal(stale.status, 403);
  assert.equal(stale.data.code, 'LAB_SESSION_EXPIRED');
  assert.deepEqual(stale.data.traces, []);
  assert.equal((await f.post('agora/create', { payload: payload() }, { 'X-Lab-Token': '' })).status, 403);
  assert.equal((await f.post('agora/query', { handle: '__proto__' })).status, 404);
  assert.equal((await fetch(`${f.base}/.env`)).status, 404);
  assert.equal(calls, 0);
});

test('stale browser session refreshes and queries the task exactly once upstream', async t => {
  let queries = 0;
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'GET') queries++;
    return response(String(url).endsWith('/builderTokens') ? { tokenName: 'token' } : { taskId: 'task-session', status: 'IN_PROGRESS' });
  });
  const created = await f.post('agora/create', { payload: payload() });
  const settings = { csrf: 'previous-server-session' };
  const result = await postApi('agora/query', { handle: created.data.handle }, settings, (url, options) => fetch(`${f.base}${url}`, options));
  assert.equal(result.response.status, 200);
  assert.equal(result.result.data.status, 'IN_PROGRESS');
  assert.equal(settings.csrf, f.settings.csrf);
  assert.equal(queries, 1);
});

test('Meta creates UNPUBLISHED, fills full secure URL and keeps secrets out of diagnostic traces', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => { calls.push({ url: String(url), ...options }); return response({ id: '987', status: 'UNPUBLISHED', secure_stream_url: streamUrl, permalink_url: '/123/videos/456' }); });
  const result = await f.post('meta/create', { title: 'Test & stream' });
  assert.equal(result.status, 200); assert.equal(result.data.secureStreamUrl, streamUrl);
  const params = new URLSearchParams(calls[0].body);
  assert.equal(params.get('status'), 'UNPUBLISHED'); assert.equal(params.get('title'), 'Test & stream');
  assert.ok(params.get('fields').split(',').includes('permalink_url'));
  assert.equal(result.data.data.permalink_url, '/123/videos/456');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v26.0/123/live_videos');
  assert.equal(calls[0].headers.Authorization, 'Bearer meta-page-secret');
  assert.equal(JSON.stringify(result.data.traces).includes(streamUrl), false);
  assert.equal(JSON.stringify(result.data.traces).includes(env.META_PAGE_ACCESS_TOKEN), false);
  await f.post('meta/publish', { liveVideoId: '987', version: 'v25.0' });
  assert.equal(new URLSearchParams(calls[1].body).get('status'), 'LIVE_NOW');
  await f.post('meta/end', { liveVideoId: '987' });
  assert.equal(new URLSearchParams(calls[2].body).get('end_live_video'), 'true');
});

test('redaction handles nested configuration, URLs in error messages and paging tokens', () => {
  const value = redact({ nested: { rtcToken: 'secret', streamUrl: [streamUrl] }, message: `failed: ${streamUrl}`, paging: { next: 'https://graph.facebook.com?access_token=secret' } });
  assert.equal(JSON.stringify(value).includes('secret'), false);
  assert.equal(JSON.stringify(value).includes('FAKE_SIGNATURE'), false);
});

test('personal profile uses its User token and /me, even when a Page ID is present', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push({ url: String(url), ...options });
    return response({ id: '987', status: 'UNPUBLISHED', secure_stream_url: streamUrl });
  }, { META_TARGET_TYPE: 'profile', META_USER_ACCESS_TOKEN: 'meta-user-secret' });
  assert.equal(f.settings.metaTargetType, 'profile');
  assert.equal(f.settings.metaReady, true);
  assert.equal(JSON.stringify(f.settings).includes('meta-user-secret'), false);
  const result = await f.post('meta/create', { pageId: '456' });
  assert.equal(result.status, 200);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v26.0/me/live_videos');
  assert.equal(calls[0].headers.Authorization, 'Bearer meta-user-secret');
  assert.equal(new URLSearchParams(calls[0].body).get('status'), 'UNPUBLISHED');
  assert.equal(JSON.stringify(result.data.traces).includes('meta-user-secret'), false);
  await f.post('meta/query', { liveVideoId: '987' });
  assert.equal(new URL(calls[1].url).pathname, '/v26.0/987');
  assert.equal((await f.post('meta/query', { liveVideoId: 'me' })).status, 400);
});

test('personal mode never falls back to a Page token and checks identity without creating live video', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push({ url: String(url), ...options });
    return response(String(url).endsWith('/permissions')
      ? { data: [{ permission: 'publish_video', status: 'granted' }] } : { id: '789', name: 'Test User' });
  }, { META_USER_ACCESS_TOKEN: 'meta-user-secret' });
  const checked = await f.post('meta/check', { targetType: 'profile' });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.data.identity.id, '789');
  assert.equal(checked.data.data.permissions[0].status, 'granted');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.method === 'GET' && call.headers.Authorization === 'Bearer meta-user-secret'));
  assert.equal((await f.post('meta/create', { targetType: 'invalid' })).status, 400);
  const noUserToken = await fixture(t, async () => { throw new Error('must not call upstream'); });
  const missing = await noUserToken.post('meta/create', { targetType: 'profile' });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /META_USER_ACCESS_TOKEN/);
});
