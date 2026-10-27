import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtcSession } from '../public/rtc.js';

function fixture({ cameraFails = false, publishFails = false, joinFails = false } = {}) {
  const calls = [], handlers = {};
  const track = name => ({ stop: () => calls.push(`${name}.stop`), close: () => calls.push(`${name}.close`), play: () => calls.push(`${name}.play`) });
  const audio = track('audio'), video = track('video');
  const client = {
    on: (event, callback) => { handlers[event] = callback; calls.push(`on.${event}`); },
    setClientRole: async role => calls.push(['role', role]),
    join: async (...args) => { calls.push(['join', ...args]); if (joinFails) throw new Error('join failed'); },
    publish: async tracks => { calls.push(['publish', tracks]); if (publishFails) throw new Error('publish failed'); },
    subscribe: async (user, mediaType) => calls.push(['subscribe', user.uid, mediaType]),
    renewToken: async token => calls.push(['renewToken', token]),
    leave: async () => calls.push('leave'), removeAllListeners: () => calls.push('removeAllListeners'),
  };
  const sdk = {
    createClient: () => client,
    createMicrophoneAudioTrack: async () => audio,
    createCameraVideoTrack: async () => { if (cameraFails) throw new Error('camera denied'); return video; },
  };
  const states = [];
  const session = new RtcSession(sdk, { log: () => {}, state: value => states.push(value), video: () => {}, token: () => 'new-browser-token' });
  const options = { appId: 'a'.repeat(32), channel: 'demo-channel', uid: 12345, token: 'publisher-token', sourceUid: 12345, mode: 'publish' };
  return { session, options, calls, handlers, audio, video, states };
}

test('publisher registers events before joining with exact identity and cleans tracks before leave', async () => {
  const f = fixture(); await f.session.join(f.options);
  const joinIndex = f.calls.findIndex(call => Array.isArray(call) && call[0] === 'join');
  assert.ok(f.calls.indexOf('on.user-published') < joinIndex);
  assert.deepEqual(f.calls[joinIndex], ['join', f.options.appId, 'demo-channel', 'publisher-token', 12345]);
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'publish' && call[1].length === 2));
  await f.session.cleanup();
  assert.ok(f.calls.indexOf('audio.stop') < f.calls.indexOf('audio.close'));
  assert.ok(f.calls.indexOf('video.close') < f.calls.indexOf('leave'));
  assert.equal(f.session.client, null);
});

for (const failure of ['cameraFails', 'publishFails', 'joinFails']) test(`${failure} releases partial initialization and does not keep a joined client`, async () => {
  const f = fixture({ [failure]: true });
  await assert.rejects(f.session.join(f.options));
  assert.equal(f.session.client, null); assert.equal(f.session.tracks.length, 0);
  assert.ok(f.calls.includes('leave'));
  if (failure === 'cameraFails') { assert.ok(f.calls.includes('audio.close')); assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'publish'), false); }
});

test('monitor subscribes only to target UID, handles audio/video separately, and renews from current input', async () => {
  const f = fixture(); await f.session.join({ ...f.options, mode: 'monitor', uid: 12346 });
  await f.handlers['user-published']({ uid: 99, audioTrack: f.audio }, 'audio');
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'subscribe'), false);
  await f.handlers['user-published']({ uid: 12345, audioTrack: f.audio, videoTrack: f.video }, 'audio');
  await f.handlers['user-published']({ uid: 12345, audioTrack: f.audio, videoTrack: f.video }, 'video');
  assert.ok(f.calls.includes('video.play'));
  assert.equal(f.calls.includes('audio.play'), false);
  f.session.playAudio(); assert.ok(f.calls.includes('audio.play'));
  f.handlers['token-privilege-will-expire'](); assert.match(f.states.at(-1), /expires soon/);
  await f.session.renew(); assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'renewToken' && call[1] === 'new-browser-token'));
  f.handlers['user-unpublished']({ uid: 12345 }, 'audio'); assert.throws(() => f.session.playAudio());
  await f.session.cleanup();
});
