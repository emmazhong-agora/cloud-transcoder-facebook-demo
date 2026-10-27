import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftKey, loadDraft, saveDraft } from '../public/draft.js';

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test('draft restores independent form and incomplete JSON edits without changing signed URL bytes', () => {
  const store = storage();
  assert.equal(loadDraft(store), null);
  const fields = { channel: 'changed-channel', uid: '12345', audioToken: 'rtc-secret',
    destination: 'rtmps://example.com/live/key?a=FAKE_SIGNATURE+Some%2FValue==&s_vt=api-s',
    payload: '{\n  "services": { "partially edited": ', liveVideoId: '987', metaViewerUrl: 'https://www.facebook.com/123/videos/456',
    browserToken: 'browser-secret', rtcMode: 'monitor', facebookMode: 'manual', requestMode: 'custom', wizardStep: '3',
    previewConfirmed: 'true', poll: 'true', unknownField: 'ignored' };
  saveDraft(store, fields);
  const restored = loadDraft(store);
  for (const id of ['channel', 'uid', 'audioToken', 'destination', 'payload', 'liveVideoId', 'metaViewerUrl', 'browserToken', 'rtcMode', 'facebookMode', 'requestMode', 'wizardStep']) {
    assert.equal(restored.fields[id], fields[id]);
  }
  assert.equal('poll' in restored.fields, false);
  assert.equal('previewConfirmed' in restored.fields, false);
  assert.equal('unknownField' in restored.fields, false);
  saveDraft(store, { ...restored.fields, channel: 'latest-edit', browserToken: '' });
  assert.equal(loadDraft(store).fields.channel, 'latest-edit');
  assert.equal(loadDraft(store).fields.browserToken, '');
});

test('invalid drafts and storage failures are reported instead of pretending to save', () => {
  const store = storage();
  for (const value of ['{broken', JSON.stringify({ version: 2, fields: {} }), JSON.stringify({ version: 1, fields: [] })]) {
    store.setItem(draftKey, value);
    assert.throws(() => loadDraft(store));
  }
  assert.throws(() => saveDraft({ setItem() { throw new Error('quota exceeded'); } }, { channel: 'test' }), /quota exceeded/);
});
