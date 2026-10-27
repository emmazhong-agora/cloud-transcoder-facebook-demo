import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inspectDestination, redact } from './public/config.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const fail = (message, status = 400, code) => Object.assign(new Error(message), { status, code });

export async function createApp({ env = process.env, fetcher = fetch, stateFile = path.join(root, '.runtime/tasks.json') } = {}) {
  const csrf = randomUUID();
  let tasks = {};
  try { tasks = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let saveQueue = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(tasks, null, 2);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      await writeFile(`${stateFile}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${stateFile}.tmp`, stateFile);
    });
    return saveQueue;
  };
  const publicTasks = () => Object.entries(tasks).map(([handle, task]) => ({ handle, appId: task.appId, taskId: task.taskId, created: task.created, status: task.status }));
  const metaTargetType = env.META_TARGET_TYPE || 'page';
  const metaToken = type => type === 'profile' ? env.META_USER_ACCESS_TOKEN : env.META_PAGE_ACCESS_TOKEN;

  async function upstream(url, { method = 'GET', body, auth }, traces, operation) {
    const requestId = randomUUID();
    const trace = { operation, method, url: redact(String(url).replace(/(builderToken=)[^&]+/, '$1[REDACTED]')),
      requestId, request: redact(body instanceof URLSearchParams ? Object.fromEntries(body) : body), time: new Date().toISOString() };
    traces.push(trace);
    let response;
    try {
      response = await fetcher(url, { method, headers: { Authorization: auth, 'Content-Type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json', 'X-Request-ID': requestId },
        ...(body === undefined ? {} : { body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000), redirect: 'error' });
    } catch (error) {
      trace.error = 'Connection failed or timed out';
      throw fail(`${operation}: upstream connection failed or timed out (${error.name}). The create result may be unknown; verify it before creating another task.`, 502);
    }
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }
    trace.httpStatus = response.status;
    trace.responseRequestId = response.headers.get('x-request-id') || response.headers.get('x-fb-trace-id');
    trace.response = redact(data);
    if (!response.ok || data.error) throw fail(`${operation} returned HTTP ${response.status}. Expand the response for details.`, response.ok ? 502 : response.status);
    return data;
  }

  function agoraAuth() {
    if (!env.AGORA_CUSTOMER_ID || !env.AGORA_CUSTOMER_SECRET) throw fail('Set AGORA_CUSTOMER_ID and AGORA_CUSTOMER_SECRET in .env, then restart the server.');
    return `Basic ${Buffer.from(`${env.AGORA_CUSTOMER_ID}:${env.AGORA_CUSTOMER_SECRET}`).toString('base64')}`;
  }
  function appId(value) {
    const id = value || env.AGORA_APP_ID;
    if (!/^[a-f\d]{32}$/i.test(id || '')) throw fail('Agora App ID must be a 32-character hexadecimal string.');
    return id;
  }
  const agoraUrl = id => `https://api.sd-rtn.com/v1/projects/${id}/rtsc/cloud-transcoder`;
  function validatePayload(payload) {
    const service = payload?.services?.cloudTranscoder;
    const config = service?.config?.transcoder;
    if (service?.serviceType !== 'cloudTranscoderV2' || !config?.outputs?.length) throw fail('Missing cloudTranscoderV2 configuration or outputs.');
    for (const output of config.outputs) {
      const urls = Array.isArray(output.streamUrl) ? output.streamUrl : [output.streamUrl];
      if (!urls.length) throw fail('streamUrl must not be empty.');
      for (const url of urls) {
        const info = inspectDestination(url);
        if (info.placeholder || info.htmlEscaped) throw fail('Replace the placeholder stream key and use original & characters instead of &amp;.');
      }
    }
    for (const input of [...(config.audioInputs || []), ...(config.videoInputs || [])]) {
      if (input.rtc && /xxx|<[^>]+>|\.\.\./i.test(input.rtc.rtcToken)) throw fail('Replace placeholder RTC tokens in audioInputs and videoInputs.');
    }
    return payload;
  }

  const server = http.createServer(async (req, res) => {
    const traces = [];
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      // Loopback binding plus Host/Origin checks keep this credentialed proxy local.
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) throw fail('Host rejected', 403);
      const requestUrl = new URL(req.url, `http://${req.headers.host}`);
      if (req.headers.origin && req.headers.origin !== requestUrl.origin) throw fail('Origin rejected', 403);
      if (req.method === 'GET' && requestUrl.pathname === '/api/config') return send(200, {
        csrf, appId: env.AGORA_APP_ID || '', agoraReady: Boolean(env.AGORA_CUSTOMER_ID && env.AGORA_CUSTOMER_SECRET),
        metaReady: Boolean(metaToken(metaTargetType)), metaTargetType,
        pageId: env.META_PAGE_ID || '', graphVersion: env.META_GRAPH_VERSION || 'v26.0', tasks: publicTasks(),
      });
      if (requestUrl.pathname.startsWith('/api/')) {
        if (req.method !== 'POST') throw fail('Use POST', 405);
        const supplied = Buffer.from(req.headers['x-lab-token'] || '');
        const expected = Buffer.from(csrf);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail('The local session has changed. Reload the page and try again.', 403, 'LAB_SESSION_EXPIRED');
        if (!req.headers['content-type']?.startsWith('application/json')) throw fail('Use application/json', 415);
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) throw fail('Request body is too large.', 413); }
        let body;
        try { body = JSON.parse(raw); } catch { throw fail('Invalid JSON.'); }
        const action = requestUrl.pathname;
        if (action === '/api/agora/create') {
          const id = appId(body.appId), auth = agoraAuth(), payload = validatePayload(body.payload);
          const acquired = await upstream(`${agoraUrl(id)}/builderTokens`, { method: 'POST', auth,
            body: { instanceId: randomUUID(), services: payload.services } }, traces, 'Acquire');
          if (!acquired.tokenName) throw fail('Acquire response is missing tokenName.', 502);
          const url = new URL(`${agoraUrl(id)}/tasks`);
          url.searchParams.set('builderToken', acquired.tokenName);
          const data = await upstream(url, { method: 'POST', auth, body: payload }, traces, 'Create Transcoder');
          if (!data.taskId) throw fail('Create response is missing taskId.', 502);
          const handle = randomUUID();
          tasks[handle] = { appId: id, taskId: data.taskId, builderToken: acquired.tokenName, created: new Date().toISOString(), status: data.status };
          try { await save(); } catch { return send(200, { data: redact(data), handle, tasks: publicTasks(), traces, warning: 'Task created, but the local task record could not be saved. Keep the server running and destroy the task after testing.' }); }
          return send(200, { data: redact(data), handle, tasks: publicTasks(), traces });
        }
        if (['/api/agora/query', '/api/agora/destroy'].includes(action)) {
          const task = Object.hasOwn(tasks, body.handle) ? tasks[body.handle] : null;
          if (!task) throw fail('Local task not found. Reload the page.', 404);
          const url = new URL(`${agoraUrl(task.appId)}/tasks/${encodeURIComponent(task.taskId)}`);
          url.searchParams.set('builderToken', task.builderToken);
          const destroy = action.endsWith('/destroy');
          const data = await upstream(url, { method: destroy ? 'DELETE' : 'GET', auth: agoraAuth() }, traces, destroy ? 'Destroy' : 'Query');
          // A destroy response can still be STOPPING; retain credentials for later queries.
          task.status = data.status;
          await save();
          return send(200, { data: redact(data), tasks: publicTasks(), traces });
        }
        if (action.startsWith('/api/meta/')) {
          const targetType = body.targetType || metaTargetType;
          if (!['profile', 'page'].includes(targetType)) throw fail('Meta target type must be profile or page.');
          const token = metaToken(targetType);
          if (!token) throw fail(`Set ${targetType === 'profile' ? 'META_USER_ACCESS_TOKEN' : 'META_PAGE_ACCESS_TOKEN'} in .env, then restart the server.`);
          const version = body.version || env.META_GRAPH_VERSION || 'v26.0';
          if (!/^v\d+\.0$/.test(version)) throw fail('Use a Graph API version such as v26.0.');
          const verb = action.split('/').at(-1);
          const auth = `Bearer ${token}`;
          if (verb === 'check') {
            const identity = await upstream(`https://graph.facebook.com/${version}/me?fields=id,name`, { auth }, traces, 'Meta identity');
            const permissions = targetType === 'profile'
              ? await upstream(`https://graph.facebook.com/${version}/me/permissions`, { auth }, traces, 'Meta permissions') : undefined;
            return send(200, { data: { identity: redact(identity), permissions: redact(permissions?.data) }, traces });
          }
          // A User token resolves /me to the personal profile; never reuse a Page ID here.
          const id = verb === 'create' ? (targetType === 'profile' ? 'me' : body.pageId || env.META_PAGE_ID) : body.liveVideoId;
          if (!(verb === 'create' && targetType === 'profile') && !/^\d+$/.test(id || '')) throw fail('Enter a numeric Page ID or Live Video ID.');
          let endpoint = id, method = 'GET', params;
          if (verb === 'create') {
            endpoint += '/live_videos'; method = 'POST';
            params = new URLSearchParams({ status: 'UNPUBLISHED', title: body.title || 'Agora Cloud Transcoder test', fields: 'id,secure_stream_url,status,permalink_url' });
          } else if (verb === 'publish' || verb === 'end') {
            method = 'POST'; params = new URLSearchParams(verb === 'publish' ? { status: 'LIVE_NOW' } : { end_live_video: 'true' });
          } else if (verb === 'errors') endpoint += '/errors';
          else if (verb !== 'query') throw fail('Unknown Meta action', 404);
          const url = new URL(`https://graph.facebook.com/${version}/${endpoint}`);
          if (verb === 'query') url.searchParams.set('fields', 'id,status,secure_stream_url,permalink_url');
          const data = await upstream(url, { method, body: params, auth }, traces, `Meta ${verb}`);
          // The complete secure URL is returned only for the explicit form fill, never in traces.
          return send(200, { data: redact(data), ...(data.secure_stream_url ? { secureStreamUrl: data.secure_stream_url } : {}), traces });
        }
        throw fail('Unknown endpoint', 404);
      }
      if (req.method !== 'GET') throw fail('Method not allowed', 405);
      const files = {
        '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'],
        '/config.js': ['public/config.js', 'text/javascript'], '/draft.js': ['public/draft.js', 'text/javascript'],
        '/api.js': ['public/api.js', 'text/javascript'],
        '/rtc.js': ['public/rtc.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'],
        '/vendor/agora.js': ['node_modules/agora-rtc-sdk-ng/AgoraRTC_N-production.js', 'text/javascript'],
      };
      const entry = files[requestUrl.pathname];
      if (!entry) throw fail('Not found', 404);
      const data = await readFile(path.join(root, entry[0]));
      res.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(data);
    } catch (error) { send(error.status || 500, { error: redact(error.status ? error.message : 'Local server error. Check the server environment.'), ...(error.code === 'LAB_SESSION_EXPIRED' ? { code: error.code } : {}), traces }); }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApp();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, '127.0.0.1', () => console.log(`Cloud Transcoder Lab: http://localhost:${port}`));
}
