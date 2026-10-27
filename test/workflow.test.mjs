import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPayload, preparePayload, validateSource, canPublish, isEndedBroadcast } from '../public/config.js';

const fields = { appId: 'a'.repeat(32), channel: 'customer-source', uid: '123', audioToken: '', videoToken: '',
  destination: 'rtmps://live-api-s.facebook.com:443/rtmp/987?a=FAKE_SIGNATURE+%2f==&s_vt=api-s' };

test('guided start applies current form automatically while preserving encoding, layout and signed bytes', () => {
  const edited = structuredClone(defaultPayload);
  const config = edited.services.cloudTranscoder.config.transcoder;
  config.outputs[0].videoOption.bitrate = 2500;
  config.videoInputs[0].region.zOrder = 4;
  config.outputs.push({ ...structuredClone(config.outputs[0]), streamUrl: ['rtmps://example.com/other'] });
  for (const type of ['array', 'string']) {
    const payload = preparePayload(JSON.stringify(edited), fields, 'guided', type);
    const actual = payload.services.cloudTranscoder.config.transcoder;
    assert.deepEqual(actual.videoInputs[0].rtc, { rtcChannel: fields.channel, rtcUid: 123, rtcToken: '' });
    assert.deepEqual(actual.audioInputs[0].rtc, actual.videoInputs[0].rtc);
    assert.deepEqual(actual.outputs[0].streamUrl, type === 'array' ? [fields.destination] : fields.destination);
    assert.equal(actual.outputs[0].videoOption.bitrate, 2500);
    assert.equal(actual.videoInputs[0].region.zOrder, 4);
    assert.deepEqual(actual.outputs[1], config.outputs[1]);
  }
  assert.equal(config.videoInputs[0].rtc.rtcChannel, 'demo-channel');
});

test('custom requests bypass the form and retain all independently edited inputs and outputs', () => {
  assert.deepEqual(preparePayload(JSON.stringify(defaultPayload), {}, 'custom'), defaultPayload);
  assert.throws(() => preparePayload('{incomplete', fields), SyntaxError);
});

test('source and destination validation block incomplete wizard settings before effects', () => {
  validateSource(fields);
  for (const change of [{ appId: '' }, { channel: ' ' }, { uid: '1.5' }, { uid: '' }, { uid: '4294967296' }, { audioToken: '<YOUR_TOKEN>' }]) {
    assert.throws(() => validateSource({ ...fields, ...change }), /Step 1/);
  }
  assert.throws(() => preparePayload(JSON.stringify(defaultPayload), { ...fields, destination: fields.destination.replace('&', '&amp;') }), /Step 2/);
});

test('publication requires explicit preview confirmation and an eligible API broadcast', () => {
  const ready = { mode: 'api', liveVideoId: '987', status: 'UNPUBLISHED', previewConfirmed: true };
  assert.equal(canPublish(ready), true);
  for (const change of [{ previewConfirmed: false }, { mode: 'manual' }, { liveVideoId: '' }, { status: 'LIVE' }, { status: 'LIVE_NOW' },
    ...['VOD', 'PROCESSING', 'LIVE_STOPPED', 'ENDED', 'DELETED'].map(status => ({ status }))]) {
    assert.equal(canPublish({ ...ready, ...change }), false);
  }
  assert.equal(isEndedBroadcast('UNPUBLISHED'), false);
});
