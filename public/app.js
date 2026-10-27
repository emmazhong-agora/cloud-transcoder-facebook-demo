import { defaultPayload, combineDestination, inspectDestination, redact, validateSource, preparePayload, isEndedBroadcast, canPublish } from './config.js';
import { RtcSession } from './rtc.js';
import { draftFieldIds, saveDraft, loadDraft } from './draft.js';
import { postApi } from './api.js';

const $ = id => document.getElementById(id);
let settings, logs = [], pending = false, pollTimer, polling = false;
let draftReady = false;
let broadcastStatus = '', statusIdentity = '';
const terminal = new Set(['STOPPED', 'EXIT', 'FAILURE_STOP']);
const format = value => JSON.stringify(value, null, 2);
const source = () => JSON.parse($('payload').value).services.cloudTranscoder.config.transcoder;
const notice = (message, error = false) => { $('notice').textContent = message; $('notice').classList.toggle('error', error); };
const formFields = () => Object.fromEntries(['appId', 'channel', 'uid', 'audioToken', 'videoToken', 'destination'].map(id => [id, $(id).value]));
const broadcastIdentity = () => `${$('metaTargetType').value}/${$('liveVideoId').value}`;
const currentStatus = () => statusIdentity === broadcastIdentity() ? broadcastStatus : '';

function review() {
  $('requestBehavior').textContent = $('requestMode').value === 'custom'
    ? 'Custom mode is selected. Start streaming sends your edited JSON; the source and URL form fields are not applied. The review below describes that JSON.'
    : 'Review your setup and start Cloud Transcoder. Your source and Facebook URL are applied automatically; no JSON editing is needed.';
  try {
    const config = preparePayload($('payload').value, formFields(), $('requestMode').value, $('urlType').value).services.cloudTranscoder.config.transcoder;
    const inputs = [...(config.videoInputs || []), ...(config.audioInputs || [])].filter(input => input.rtc);
    $('reviewSource').textContent = [...new Set(inputs.map(input => `${input.rtc.rtcChannel} / UID ${input.rtc.rtcUid}`))].join('; ') || 'No RTC input';
    $('reviewDestination').textContent = config.outputs.map(output => (Array.isArray(output.streamUrl) ? output.streamUrl : [output.streamUrl]).map(url => inspectDestination(url).host).join(', ')).join('; ');
    $('reviewVideo').textContent = config.outputs.map(({ videoOption: video = {} }) => `${video.width} × ${video.height} / ${video.fps} fps / ${video.codec} / ${video.bitrate} kbps`).join('; ');
  } catch {
    $('reviewSource').textContent = 'Configuration needs attention';
    $('reviewDestination').textContent = 'Check the source, streaming URL and request JSON';
    $('reviewVideo').textContent = 'Open Advanced to review the request';
  }
}

function syncWorkflow() {
  const manual = $('facebookMode').value === 'manual';
  $('facebookApiSetup').hidden = manual;
  $('metaLinks').hidden = $('shareBox').hidden = $('previewConfirmation').hidden = manual;
  $('manualPublishHelp').hidden = !manual;
  $('existingBroadcast').hidden = !$('liveVideoId').value;
  $('metaPublish').hidden = manual;
  $('metaPublish').disabled = pending || !canPublish({ mode: $('facebookMode').value, liveVideoId: $('liveVideoId').value, status: currentStatus(), previewConfirmed: $('previewConfirmed').checked });
  $('previewRefresh').hidden = manual;
  $('metaEnd').hidden = manual;
  $('metaErrors').disabled = pending || manual || !/^\d+$/.test($('liveVideoId').value);
  $('query').disabled = $('destroy').disabled = pending || !$('taskSelect').value;
  $('next3').hidden = !settings?.tasks?.length;
  renderBroadcastDetails();
}

function showStep(step, focus = true) {
  step = Math.min(4, Math.max(1, Number(step) || 1));
  $('wizardStep').value = String(step);
  for (let index = 1; index <= 4; index++) {
    $(`step${index}`).hidden = index !== step;
    const button = document.querySelector(`[data-step="${index}"]`);
    if (index === step) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  if (step === 3) review();
  syncWorkflow();
  if (focus) {
    const title = $(`step${step}Title`);
    title.tabIndex = -1; title.focus({ preventScroll: true });
    $('notice').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  persistDraft();
}

async function advanceTo(step) {
  const current = Number($('wizardStep').value);
  if (step <= current) {
    showStep(step);
    notice(['', 'Step 1: configure your Agora source and keep the publisher sending media.', 'Step 2: create a Facebook broadcast or use your existing streaming URL.', 'Step 3: review your settings, then start streaming.', 'Step 4: check the preview, publish and share. Stop both services after testing.'][step]);
    return;
  }
  if (step === 4 && settings?.tasks?.length && current < 3) {
    showStep(4); $('taskManager').open = true;
    notice('Saved tasks are available below. Refresh the selected task to check its current state.');
    return;
  }
  if (current <= 1) validateSource(formFields());
  if (step >= 3 && current <= 2) {
    if ($('facebookMode').value === 'api') {
      if (!/^\d+$/.test($('liveVideoId').value)) throw new Error('Step 2: create a Facebook broadcast or enter an existing Live Video ID.');
      await meta('query');
      if (isEndedBroadcast(currentStatus())) throw new Error('This Facebook broadcast has ended. Create a new broadcast and streaming URL in step 2.');
    }
    const info = checkUrl();
    if (info.placeholder || info.htmlEscaped) throw new Error('Step 2: replace the sample streaming URL with the complete original Facebook URL.');
  }
  if (step === 4) {
    await taskAction('query');
    if (terminal.has($('taskState').textContent)) throw new Error('The selected Agora task has stopped. Start a new task in step 3.');
    notice('Open Live Producer and check incoming audio and video before publishing.');
  } else notice(step === 2 ? 'Step 2: create a Facebook broadcast or use your existing streaming URL.' : 'Step 3: review your settings, then start streaming.');
  showStep(step);
}

function persistDraft() {
  if (!draftReady) return;
  try {
    const fields = Object.fromEntries(draftFieldIds.map(id => [id, $(id).value]));
    const draft = saveDraft(localStorage, fields);
    $('draftState').textContent = `Saved automatically at ${new Date(draft.savedAt).toLocaleTimeString('en-US', { hour12: false })}`;
    $('draftState').classList.remove('error-text');
  } catch {
    $('draftState').textContent = 'Auto-save failed: browser storage is unavailable or full. Keep this page open.';
    $('draftState').classList.add('error-text');
  }
}

function restoreDraft() {
  try {
    const draft = loadDraft(localStorage);
    if (!draft) { $('draftState').textContent = 'Auto-save is on'; return; }
    for (const [id, value] of Object.entries(draft.fields)) {
      const field = $(id);
      if (field.tagName !== 'SELECT' || Array.from(field.options).some(option => option.value === value)) field.value = value;
    }
    $('channelSummary').textContent = `${$('channel').value} / ${$('uid').value}`;
    $('payloadInfo').textContent = 'Saved request restored. Guided mode applies the current source and URL automatically when you start streaming.';
    $('draftState').textContent = 'Saved settings restored. Auto-save is on.';
  } catch {
    $('draftState').textContent = 'Cannot restore saved settings. Check whether this browser allows local storage.';
    $('draftState').classList.add('error-text');
  }
}

function log(title, data, error = false) {
  const entry = { time: new Date().toISOString(), title, error, data: redact(data) };
  logs.unshift(entry); logs = logs.slice(0, 120);
  $('logList').querySelector('.empty-log')?.remove();
  const item = document.createElement('details');
  item.className = `log-item${error ? ' bad' : ''}`;
  const summary = document.createElement('summary');
  const stamp = document.createElement('span'); stamp.className = 'stamp'; stamp.textContent = new Date(entry.time).toLocaleTimeString('en-US', { hour12: false });
  const strong = document.createElement('strong'); strong.textContent = title;
  const result = document.createElement('span'); result.className = 'result'; result.textContent = error ? 'ERROR' : 'INFO';
  summary.append(stamp, strong, result);
  const pre = document.createElement('pre'); pre.textContent = format(entry.data);
  item.append(summary, pre); $('logList').prepend(item);
  while ($('logList').children.length > 120) $('logList').lastElementChild.remove();
}

async function api(route, body) {
  if (!settings) throw new Error('The local server is not ready.');
  const { response, result } = await postApi(route, body, settings);
  for (const trace of result.traces || []) log(`${trace.operation} / HTTP ${trace.httpStatus ?? 'NETWORK ERROR'}`, trace, !trace.httpStatus || trace.httpStatus >= 400);
  if (result.tasks) renderTasks(result.tasks, result.handle || $('taskSelect').value);
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  if (result.warning) notice(result.warning, true);
  return result;
}

function renderTasks(tasks, selected) {
  settings.tasks = tasks;
  $('taskSelect').replaceChildren();
  if (!tasks.length) $('taskSelect').add(new Option('No saved tasks', ''));
  for (const task of tasks) $('taskSelect').add(new Option(`${task.taskId} / ${task.created.slice(11, 19)}`, task.handle));
  if (tasks.some(task => task.handle === selected)) $('taskSelect').value = selected;
  $('query').disabled = $('destroy').disabled = !tasks.length;
}

function checkUrl() {
  const info = inspectDestination($('destination').value);
  const warnings = [];
  if (info.placeholder) warnings.push('Replace the placeholder stream key');
  if (info.htmlEscaped) warnings.push('Found &amp;; use the original & character');
  if (info.encodedQuery) warnings.push('Found %3F / %26; compare the URL byte for byte with the original Meta URL');
  $('urlInfo').textContent = `${info.host} · ${info.length} characters; parameters: ${info.queryNames.join(', ') || 'none'}${warnings.length ? '; ' + warnings.join('; ') : ''}`;
  $('urlInfo').classList.toggle('error-text', warnings.length > 0);
  log('URL inspection', { ...info, warnings });
  return info;
}

function validate() {
  const payload = JSON.parse($('payload').value);
  if (payload.services?.cloudTranscoder?.serviceType !== 'cloudTranscoderV2') throw new Error('serviceType must be cloudTranscoderV2.');
  const config = source();
  if (!config.outputs?.length) throw new Error('outputs must not be empty.');
  const warnings = [];
  for (const output of config.outputs) {
    if (Array.isArray(output.streamUrl)) warnings.push('streamUrl is an array; compare with the string type in the REST API reference');
    const urls = Array.isArray(output.streamUrl) ? output.streamUrl : [output.streamUrl];
    if (!urls.length) throw new Error('streamUrl must not be empty.');
    for (const value of urls) {
      const info = inspectDestination(value);
      if (info.placeholder) throw new Error('Replace the placeholder stream key in the request JSON with your complete streaming URL.');
      if (info.htmlEscaped) throw new Error('The request JSON contains &amp;. Use the original URL.');
    }
  }
  for (const input of [...(config.audioInputs || []), ...(config.videoInputs || [])]) {
    if (input.rtc && /xxx|<[^>]+>|\.\.\./i.test(input.rtc.rtcToken)) throw new Error('Replace the placeholder RTC tokens in the request JSON.');
  }
  $('payloadInfo').textContent = warnings.join('; ') || 'JSON and URL validation passed.';
  log('Request validation', { warnings, payload });
  return payload;
}

function build() {
  const payload = preparePayload($('payload').value, formFields(), 'guided', $('urlType').value);
  $('payload').value = format(payload);
  $('channelSummary').textContent = `${$('channel').value} / ${$('uid').value}`;
  $('payloadInfo').textContent = 'Request JSON updated.';
  review();
}

function reset() {
  const config = defaultPayload.services.cloudTranscoder.config.transcoder;
  $('payload').value = format(defaultPayload);
  $('channel').value = config.videoInputs[0].rtc.rtcChannel;
  $('uid').value = config.videoInputs[0].rtc.rtcUid;
  $('audioToken').value = config.audioInputs[0].rtc.rtcToken;
  $('videoToken').value = config.videoInputs[0].rtc.rtcToken;
  $('destination').value = config.outputs[0].streamUrl[0];
  $('urlType').value = 'array';
  $('payloadInfo').textContent = 'Sample configuration loaded. Replace the token and stream key placeholders.';
  $('channelSummary').textContent = 'demo-channel / 12345';
}

async function taskAction(action) {
  const handle = $('taskSelect').value;
  if (!handle) throw new Error('Select a task first.');
  const result = await api(`agora/${action}`, { handle });
  $('taskState').textContent = result.data.status || 'Unknown status';
  if (terminal.has(result.data.status)) stopPolling();
  return result;
}

function stopPolling() { clearInterval(pollTimer); $('poll').checked = false; }

function bind(id, handler) {
  $(id).addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    const button = $(id); button.disabled = true;
    try { await handler(); }
    catch (error) { notice(error.message, true); log('Operation failed', { message: error.message }, true); }
    finally { pending = false; button.disabled = false; syncRtcButtons(); syncWorkflow(); persistDraft(); }
  });
}

const rtc = new RtcSession(window.AgoraRTC, {
  log, state: message => { $('rtcState').textContent = message; },
  video: visible => { $('videoEmpty').style.display = visible ? 'none' : 'flex'; },
  token: () => $('browserToken').value,
});
function syncRtcButtons() {
  $('rtcJoin').disabled = Boolean(rtc.client);
  $('rtcLeave').disabled = $('rtcRenew').disabled = !rtc.client;
}

bind('reset', () => { reset(); notice('Sample configuration restored.'); });
bind('saveDraft', persistDraft);
bind('build', () => { build(); notice('Current source and streaming URL applied to the request JSON.'); });
bind('inspect', checkUrl);
bind('combine', () => { $('destination').value = combineDestination($('serverUrl').value, $('streamKey').value); $('previewConfirmed').checked = false; checkUrl(); notice('Streaming URL combined. Continue to step 3.'); });
bind('validate', () => { validate(); notice('Request validation passed. Joining the RTC channel is still required to verify the token.'); });
bind('create', async () => {
  if ($('requestMode').value === 'guided') {
    if ($('facebookMode').value === 'api') {
      await meta('query');
      if (isEndedBroadcast(currentStatus())) throw new Error('This broadcast has ended. Return to step 2 and create a new Facebook broadcast.');
    }
    build();
  }
  const payload = validate();
  if (!/^[a-f\d]{32}$/i.test($('appId').value)) throw new Error('Enter a valid Agora App ID.');
  if (!settings.agoraReady) throw new Error('Configure Agora REST credentials in .env, then restart the server.');
  const active = settings.tasks?.some(task => !terminal.has(task.status));
  if (!confirm(`${active ? 'You have an existing Agora task that may still be running. Stop it before reusing its stream key.\n\n' : ''}Create a billable Cloud Transcoder task and stream to the configured destination?`)) return;
  notice('Acquiring a builder token and creating the task...');
  const result = await api('agora/create', { appId: $('appId').value, payload });
  $('taskState').textContent = result.data.status || 'Created';
  $('previewConfirmed').checked = false;
  showStep(4);
  if (!result.warning) notice(`Agora task created: ${result.data.taskId}. Next: open Live Producer and verify incoming video and audio. Facebook has not been published automatically.`);
});
bind('query', () => taskAction('query'));
bind('destroy', async () => {
  if (!confirm('Destroy the selected transcoding task?')) return;
  await taskAction('destroy'); notice('Destroy requested. Query again to confirm STOPPED or EXIT.');
});
$('poll').addEventListener('change', () => {
  clearInterval(pollTimer);
  if (!$('poll').checked) return;
  if (!$('taskSelect').value) { stopPolling(); notice('Select a task first.', true); return; }
  pollTimer = setInterval(async () => {
    if (pending || polling) return;
    polling = true;
    try { await taskAction('query'); }
    catch (error) { stopPolling(); notice(error.message, true); }
    finally { polling = false; }
  }, 5000);
});
$('taskSelect').addEventListener('change', () => { stopPolling(); $('taskState').textContent = 'Not queried'; });

function renderBroadcastDetails() {
  let url;
  try { url = new URL($('metaViewerUrl').value); } catch { /* No viewer link yet. */ }
  const videoId = $('facebookMode').value === 'api' && url?.protocol === 'https:' && ['www.facebook.com', 'facebook.com'].includes(url.hostname)
    ? /\/videos\/(\d+)(?:[/?]|$)/.exec(url.pathname)?.[1] : null;
  $('copyLiveId').disabled = !/^\d+$/.test($('liveVideoId').value);
  $('copyViewerUrl').disabled = !videoId;
  $('metaWatch').hidden = $('metaProducer').hidden = !videoId;
  $('metaWatch').removeAttribute('href');
  $('metaProducer').removeAttribute('href');
  $('metaProducerUrl').value = '';
  if (videoId) {
    $('metaWatch').href = url.href;
    $('metaProducer').href = $('metaProducerUrl').value = `https://www.facebook.com/live/producer/${videoId}`;
  }
}

async function meta(verb) {
  if (verb !== 'check' && verb !== 'create' && !/^\d+$/.test($('liveVideoId').value)) throw new Error('Step 2: create a broadcast or enter its numeric Live Video ID first.');
  if (verb === 'create' && $('liveVideoId').value && !confirm('Create a new Facebook broadcast? This replaces the saved ID and streaming URL in this form. Any existing Agora task keeps running until you stop it.')) return;
  let result = await api(`meta/${verb}`, { targetType: $('metaTargetType').value, pageId: $('pageId').value, version: $('graphVersion').value,
    title: $('liveTitle').value, liveVideoId: $('liveVideoId').value });
  if (verb === 'check') {
    const granted = result.data.permissions?.some(item => item.permission === 'publish_video' && item.status === 'granted');
    const suffix = $('metaTargetType').value === 'profile' ? (granted ? '; publish_video is granted.' : '; grant publish_video to use this feature.') : '.';
    $('metaState').textContent = `Current account: ${result.data.identity.name} / ${result.data.identity.id}${suffix}`;
    notice($('metaState').textContent);
    log('Meta account and permission check', result.data);
    return;
  }
  if (verb === 'create') {
    $('previewConfirmed').checked = false;
    broadcastStatus = ''; statusIdentity = '';
    $('destination').value = '';
    $('metaViewerUrl').value = '';
    $('liveVideoId').value = result.data.id || '';
    renderBroadcastDetails();
    // Some Meta responses omit the permalink until a separate read.
    if (!result.data.permalink_url && result.data.id) {
      try {
        const details = await api('meta/query', { targetType: $('metaTargetType').value, version: $('graphVersion').value, liveVideoId: result.data.id });
        result = { ...result, data: { ...result.data, ...details.data }, secureStreamUrl: result.secureStreamUrl || details.secureStreamUrl };
      } catch (error) {
        log('Live video created; viewer link lookup failed', { liveVideoId: result.data.id, message: error.message }, true);
      }
    }
    if (!result.secureStreamUrl) notice('Meta created the live video without secure_stream_url. Query its status and URL.', true);
  }
  if (result.data.permalink_url) {
    $('metaViewerUrl').value = new URL(result.data.permalink_url, 'https://www.facebook.com').href;
  }
  renderBroadcastDetails();
  if (result.secureStreamUrl) {
    if ($('destination').value !== result.secureStreamUrl) $('previewConfirmed').checked = false;
    $('destination').value = result.secureStreamUrl; checkUrl();
    notice(Number($('wizardStep').value) < 3 ? 'Facebook streaming URL ready. Continue to step 3 to start sending media.' : 'Facebook details refreshed. Check the status and preview before publishing.');
  }
  if (verb === 'create') notice(`Facebook broadcast created. Live Video ID: ${$('liveVideoId').value}. ${result.secureStreamUrl ? 'Continue to step 3. Your streaming URL will be applied automatically.' : 'Refresh broadcast details to retrieve the streaming URL before continuing.'}`);
  if (result.data.status) {
    broadcastStatus = result.data.status; statusIdentity = broadcastIdentity();
    $('metaState').textContent = `Facebook status: ${result.data.status}. ${isEndedBroadcast(result.data.status) ? 'This broadcast has ended. Create a new one in step 2.' : ['LIVE', 'LIVE_NOW'].includes(result.data.status) ? 'Published. Use the viewer URL to check access for your intended audience.' : 'Check incoming media in Live Producer before publishing. This status alone does not confirm reception.'}`;
  }
  else if (verb === 'create') $('metaState').textContent = 'UNPUBLISHED live video requested. Waiting for media input.';
  else if (verb === 'publish' || verb === 'end') {
    broadcastStatus = verb === 'publish' ? 'LIVE_NOW' : 'LIVE_STOPPED'; statusIdentity = broadcastIdentity();
    $('metaState').textContent = 'Facebook accepted the request. Refresh status & links to confirm the resulting status.';
  }
  if (verb === 'end') $('previewConfirmed').checked = false;
  syncWorkflow();
  log(`Meta ${verb} response`, result.data);
}
function syncMetaTarget() { $('pageIdLabel').hidden = $('metaTargetType').value === 'profile'; }
$('metaTargetType').addEventListener('change', () => { syncMetaTarget(); $('previewConfirmed').checked = false; broadcastStatus = ''; statusIdentity = ''; syncWorkflow(); });
$('liveVideoId').addEventListener('input', () => { $('metaViewerUrl').value = ''; $('previewConfirmed').checked = false; broadcastStatus = ''; statusIdentity = ''; syncWorkflow(); });
bind('copyLiveId', async () => { await navigator.clipboard.writeText($('liveVideoId').value); notice('Live Video ID copied.'); });
bind('copyViewerUrl', async () => { await navigator.clipboard.writeText($('metaViewerUrl').value); notice('Viewer URL copied. This link follows the broadcast audience setting.'); });
bind('metaCheck', () => meta('check'));
bind('metaCreate', () => meta('create'));
bind('metaQuery', () => meta('query'));
bind('previewRefresh', () => meta('query'));
bind('metaErrors', () => meta('errors'));
bind('metaPublish', async () => {
  if (!canPublish({ mode: $('facebookMode').value, liveVideoId: $('liveVideoId').value, status: currentStatus(), previewConfirmed: $('previewConfirmed').checked })) throw new Error('Confirm the incoming preview and audience setting before publishing.');
  await meta('query');
  if (!canPublish({ mode: $('facebookMode').value, liveVideoId: $('liveVideoId').value, status: currentStatus(), previewConfirmed: $('previewConfirmed').checked })) throw new Error('The broadcast or URL changed, or the broadcast is already live or ended. Check its current preview and status.');
  if (confirm('Publish this live video to its configured Facebook audience?')) await meta('publish');
});
bind('metaEnd', async () => { if (confirm('End the current Facebook live video?')) await meta('end'); });

$('rtcMode').addEventListener('change', () => { $('browserUid').value = Number($('uid').value) + ($('rtcMode').value === 'publish' ? 0 : 1); });
bind('rtcJoin', async () => {
  const input = { rtcChannel: $('channel').value, rtcUid: Number($('uid').value) };
  if (!input.rtcChannel || !Number.isInteger(input.rtcUid) || input.rtcUid < 1 || input.rtcUid > 4294967295) throw new Error('Enter a valid RTC channel and Publisher UID in step 1.');
  const mode = $('rtcMode').value, uid = Number($('browserUid').value);
  if (!Number.isInteger(uid) || uid < 1 || uid > 4294967295) throw new Error('Invalid browser UID.');
  if (!/^[a-f\d]{32}$/i.test($('appId').value)) throw new Error('Enter a valid Agora App ID.');
  if (mode === 'publish' && uid !== input.rtcUid) throw new Error('In publisher mode, the browser UID must match Publisher UID in step 1.');
  if (mode === 'monitor' && uid === input.rtcUid) throw new Error('In monitor mode, the browser UID must differ from the source UID.');
  if (/xxx|<[^>]+>|\.\.\./i.test($('browserToken').value)) throw new Error('Replace the placeholder browser RTC token.');
  if (mode === 'publish' && !confirm(`Open the camera and microphone and publish to ${input.rtcChannel} as UID ${uid}? Make sure no other publisher is using this UID.`)) return;
  await rtc.join({ appId: $('appId').value, channel: input.rtcChannel, sourceUid: input.rtcUid, uid, token: $('browserToken').value, mode });
});
bind('rtcLeave', () => rtc.cleanup());
bind('rtcRenew', () => rtc.renew());
bind('playAudio', () => rtc.playAudio());
for (let step = 1; step <= 3; step++) bind(`next${step}`, () => advanceTo(step + 1));
for (const button of document.querySelectorAll('[data-step], [data-back]')) {
  button.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    try { await advanceTo(Number(button.dataset.step || button.dataset.back)); }
    catch (error) { notice(error.message, true); }
    finally { pending = false; syncWorkflow(); persistDraft(); }
  });
}
$('previewConfirmed').addEventListener('change', syncWorkflow);
$('facebookMode').addEventListener('change', () => {
  $('previewConfirmed').checked = false;
  $('metaState').textContent = $('facebookMode').value === 'manual' ? 'Manual destination: preview and publish in the Facebook Live Producer page where you obtained this URL.' : 'Refresh Facebook status & links to check this broadcast.';
  syncWorkflow();
});
for (const id of ['destination', 'channel', 'uid', 'audioToken', 'videoToken', 'appId', 'requestMode', 'payload', 'urlType', 'taskSelect']) {
  $(id).addEventListener('input', () => { $('previewConfirmed').checked = false; review(); syncWorkflow(); });
}
for (const id of ['channel', 'uid']) $(id).addEventListener('input', () => { $('channelSummary').textContent = `${$('channel').value} / ${$('uid').value}`; });
bind('export', () => {
  const report = { generatedAt: new Date().toISOString(), tasks: settings?.tasks, payload: redact(JSON.parse($('payload').value)), logs };
  const blob = new Blob([format(report)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `transcoder-diagnostics-${Date.now()}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('beforeunload', event => {
  if (rtc.client || settings?.tasks?.some(task => !terminal.has(task.status))) { event.preventDefault(); event.returnValue = ''; }
});

reset();
try {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('Failed to load local configuration.');
  settings = await response.json();
  $('facebookMode').value = settings.metaReady ? 'api' : 'manual';
  $('appId').value = settings.appId;
  $('pageId').value = settings.pageId;
  $('metaTargetType').value = settings.metaTargetType;
  $('metaState').textContent = settings.metaReady ? 'Meta token configured. You can check the account and permissions.' : 'Configure the Meta access token for the selected target in .env.';
  $('graphVersion').value = settings.graphVersion;
  $('credentials').textContent = settings.agoraReady ? 'REST credentials configured' : 'Configure .env';
  renderTasks(settings.tasks);
  notice(settings.agoraReady ? 'Start with step 1. Settings are saved automatically as you go.' : 'Configure Agora REST credentials in .env and restart. You can prepare your settings now.');
} catch (error) { notice(error.message, true); }
restoreDraft();
syncMetaTarget();
if ($('taskSelect').value) $('taskState').textContent = 'Saved task / not checked';
showStep($('wizardStep').value, false);
if (settings?.agoraReady && Number($('wizardStep').value) > 1) notice(`Saved progress restored at step ${$('wizardStep').value}. Review the current source and broadcast before continuing.`);
if (settings) $('metaState').textContent = $('facebookMode').value === 'manual'
  ? 'Manual destination: preview and publish in the Facebook Live Producer page where you obtained this URL.'
  : 'Facebook status has not been checked in this session. Refresh status & links before publishing.';
draftReady = true;
for (const id of draftFieldIds) {
  $(id).addEventListener('input', persistDraft);
  $(id).addEventListener('change', persistDraft);
}
window.addEventListener('pagehide', persistDraft);
