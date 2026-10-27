export const draftKey = 'cloud-transcoder-facebook-lab:draft:v1';
export const draftFieldIds = [
  'appId', 'channel', 'uid', 'audioToken', 'videoToken', 'destination', 'serverUrl', 'streamKey',
  'urlType', 'payload', 'metaTargetType', 'pageId', 'graphVersion', 'liveTitle', 'liveVideoId', 'metaViewerUrl',
  'rtcMode', 'browserUid', 'browserToken', 'taskSelect', 'facebookMode', 'requestMode', 'wizardStep',
];

function pickFields(fields) {
  return Object.fromEntries(draftFieldIds.filter(id => typeof fields[id] === 'string').map(id => [id, fields[id]]));
}

export function saveDraft(storage, fields) {
  const draft = { version: 1, savedAt: new Date().toISOString(), fields: pickFields(fields) };
  // Keep JSON as text so incomplete edits and signed URL bytes survive a refresh.
  storage.setItem(draftKey, JSON.stringify(draft));
  return draft;
}

export function loadDraft(storage) {
  const raw = storage.getItem(draftKey);
  if (raw === null) return null;
  const draft = JSON.parse(raw);
  if (draft?.version !== 1 || !draft.fields || typeof draft.fields !== 'object' || Array.isArray(draft.fields)) {
    throw new Error('Unsupported saved draft');
  }
  return { savedAt: draft.savedAt, fields: pickFields(draft.fields) };
}
