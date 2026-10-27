export const defaultPayload = {
  services: {
    cloudTranscoder: {
      config: {
        transcoder: {
          audioInputs: [{ rtc: {
            rtcChannel: 'demo-channel',
            rtcToken: '<YOUR_TRANSCODER_RTC_TOKEN>',
            rtcUid: 12345,
          } }],
          canvas: { color: 0, width: 1080, height: 1920 },
          outputs: [{
            audioOption: { profileType: 'AUDIO_PROFILE_MUSIC_STANDARD' },
            streamUrl: ['rtmps://live-api-s.facebook.com/rtmp/000000000000000?s_bl=1&s_ow=10&s_psm=1&s_pub=1&s_sw=0&s_tids=1&s_vt=api-s&a=<YOUR_STREAM_KEY>'],
            videoOption: { width: 1080, fps: 30, height: 1920, bitrate: 3780, codec: 'H264' },
          }],
          videoInputs: [{
            region: { x: 0, y: 0, width: 1080, height: 1920, zOrder: 2 },
            placeholderImageUrl: 'https://web-cdn.agora.io/website-files/images/advantage-interactive-live-streaming.png',
            rtc: {
              rtcChannel: 'demo-channel',
              rtcToken: '<YOUR_TRANSCODER_RTC_TOKEN>',
              rtcUid: 12345,
            },
          }],
        },
      },
      serviceType: 'cloudTranscoderV2',
    },
  },
};

// Never parse/re-serialize the destination: signed query bytes must survive unchanged.
export function combineDestination(server, key) {
  if (!server || !key || /\s/.test(server + key)) throw new Error('Server URL and stream key must be nonempty and contain no whitespace.');
  if (/^rtmps?:\/\//i.test(key)) throw new Error('Enter only the stream key here. Paste a complete URL in the destination field.');
  return server.replace(/\/+$/, '') + '/' + key;
}

export function inspectDestination(value) {
  if (typeof value !== 'string' || /\s/.test(value)) throw new Error('The streaming URL must be a string without whitespace.');
  const url = new URL(value);
  if (!['rtmp:', 'rtmps:'].includes(url.protocol) || !url.hostname || !url.pathname.replace(/\/$/, '')) {
    throw new Error('Enter a complete RTMP or RTMPS streaming URL.');
  }
  if (url.hash) throw new Error('The URL contains a fragment (#). Check that the stream key was copied completely.');
  return { host: url.host, protocol: url.protocol, length: value.length,
    queryNames: [...url.searchParams.keys()], htmlEscaped: value.includes('&amp;'),
    encodedQuery: /%3[fF]|%26/.test(value), placeholder: /xxxxx|\.\.\.|<[^>]+>/i.test(value) };
}

export function validateSource({ appId, channel, uid, audioToken, videoToken }) {
  if (!/^[a-f\d]{32}$/i.test(appId)) throw new Error('Step 1: enter a valid 32-character Agora App ID.');
  if (!channel.trim()) throw new Error('Step 1: enter the RTC channel name.');
  if (!/^\d+$/.test(String(uid)) || Number(uid) < 1 || Number(uid) > 4294967295) throw new Error('Step 1: Publisher UID must be an integer between 1 and 4294967295.');
  if ([audioToken, videoToken].some(token => /xxx|<[^>]+>|\.\.\./i.test(token))) throw new Error('Step 1: replace the sample transcoder RTC tokens, or leave them empty for a project without token authentication.');
}

export function preparePayload(raw, fields, mode = 'guided', urlType = 'array') {
  const payload = JSON.parse(raw);
  if (mode === 'custom') return payload;
  validateSource(fields);
  const info = inspectDestination(fields.destination);
  if (info.placeholder || info.htmlEscaped) throw new Error('Step 2: use the complete original Facebook streaming URL, without placeholders or &amp;.');
  const config = payload.services?.cloudTranscoder?.config?.transcoder;
  if (!config?.outputs?.length) throw new Error('The request JSON needs at least one output. Restore the sample or fix the JSON.');
  for (const [inputs, token] of [[config.audioInputs, fields.audioToken], [config.videoInputs, fields.videoToken]]) {
    for (const input of inputs || []) if (input.rtc) Object.assign(input.rtc, { rtcChannel: fields.channel, rtcUid: Number(fields.uid), rtcToken: token });
  }
  // Copy the signed URL as text; parsing and serializing it could change its signature.
  config.outputs[0].streamUrl = urlType === 'array' ? [fields.destination] : fields.destination;
  return payload;
}

export const isEndedBroadcast = status => ['VOD', 'PROCESSING', 'LIVE_STOPPED', 'ENDED', 'DELETED'].includes(status);

export function canPublish({ mode, liveVideoId, status, previewConfirmed }) {
  return mode === 'api' && /^\d+$/.test(liveVideoId) && previewConfirmed && !isEndedBroadcast(status) && !['LIVE', 'LIVE_NOW'].includes(status);
}

export function redact(value, key = '') {
  if (/token|secret|authorization|stream_?url|dash_preview_url|embed_html|paging/i.test(key)) return value ? '[REDACTED]' : value;
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  if (typeof value === 'string') return value
    .replace(/rtmps?:\/\/[^\s"'<>]+/gi, '[RTMP URL REDACTED]')
    .replace(/00[67][A-Za-z0-9+/=]{24,}/g, '[RTC TOKEN REDACTED]')
    .replace(/EA[A-Za-z0-9]{30,}/g, '[META TOKEN REDACTED]');
  return value;
}
