export class RtcSession {
  constructor(sdk, { log, state, video, token, player = 'player' }) {
    Object.assign(this, { sdk, log, state, video, token, player });
    this.client = null;
    this.tracks = [];
    this.remoteAudio = null;
    this.busy = false;
  }

  async join({ appId, channel, uid, token, sourceUid, mode }) {
    if (this.client || this.busy) throw new Error('Leave the current channel first.');
    if (!this.sdk) throw new Error('Agora Web SDK is not loaded. Run npm install, then reload the page.');
    this.busy = true;
    const client = this.sdk.createClient({ mode: 'live', codec: 'h264' });
    this.client = client;
    client.on('connection-state-change', (current, previous, reason) => {
      this.state(`${current}${reason ? ` / ${reason}` : ''}`);
      this.log('RTC connection', { current, previous, reason });
    });
    client.on('exception', event => this.log('RTC exception', event, true));
    client.on('token-privilege-will-expire', () => {
      this.state('Token expires soon. Enter a new token and click Renew token.');
      this.log('RTC token expires soon', { action: 'Enter a new browser RTC token and click Renew token' }, true);
    });
    client.on('token-privilege-did-expire', () => {
      this.state('Token expired. Leave and rejoin with a new token.');
      this.log('RTC token expired', {}, true);
    });
    client.on('user-published', async (user, mediaType) => {
      this.log('RTC stream discovered', { uid: user.uid, mediaType, isTarget: user.uid === sourceUid });
      if (mode !== 'monitor' || user.uid !== sourceUid || !['audio', 'video'].includes(mediaType)) return;
      try {
        await client.subscribe(user, mediaType);
        if (this.client !== client) return;
        if (mediaType === 'video') { user.videoTrack.play(this.player); this.video(true); }
        if (mediaType === 'audio') this.remoteAudio = user.audioTrack;
        this.state(`Subscribed to UID ${user.uid} / ${mediaType}${mediaType === 'audio' ? ' (click Play subscribed audio to listen)' : ''}`);
        this.log('RTC subscription succeeded', { uid: user.uid, mediaType });
      } catch (error) { this.log('RTC subscription failed', { message: error.message }, true); }
    });
    client.on('user-unpublished', (user, mediaType) => {
      if (user.uid !== sourceUid) return;
      if (mediaType === 'video') this.video(false);
      if (mediaType === 'audio') this.remoteAudio = null;
      this.state(`Source stopped publishing ${mediaType}`);
    });
    client.on('user-left', user => {
      if (user.uid === sourceUid) { this.video(false); this.remoteAudio = null; this.state('Source user left'); }
    });
    try {
      await client.setClientRole(mode === 'publish' ? 'host' : 'audience');
      await client.join(appId, channel, token || null, uid);
      this.state(mode === 'publish' ? 'Joined. Opening the camera and microphone...' : `Joined. Waiting for source UID ${sourceUid}`);
      if (mode === 'publish') {
        const audio = await this.sdk.createMicrophoneAudioTrack({ encoderConfig: 'high_quality' });
        this.tracks.push(audio);
        const video = await this.sdk.createCameraVideoTrack({ encoderConfig: { width: 1080, height: 1920, frameRate: 30, bitrateMax: 3780 } });
        this.tracks.push(video);
        await client.publish(this.tracks);
        video.play(this.player);
        this.video(true);
        this.state(`Publishing audio and video / UID ${uid}`);
      }
      this.log('RTC join completed', { channel, uid, mode, sourceUid });
    } catch (error) {
      await this.cleanup().catch(cleanupError => this.log('RTC cleanup failed', { message: cleanupError.message }, true));
      throw error;
    } finally { this.busy = false; }
  }

  async renew() {
    if (!this.client) throw new Error('Join a channel first.');
    const token = this.token();
    if (!token || /xxx|<[^>]+>/i.test(token)) throw new Error('Enter a valid new browser RTC token.');
    await this.client.renewToken(token);
    this.log('RTC token renewed', {});
    this.state('Browser token renewed. Manage transcoder tokens separately.');
  }

  playAudio() {
    if (!this.remoteAudio) throw new Error('No source audio has been subscribed to yet.');
    this.remoteAudio.play();
  }

  async cleanup() {
    const client = this.client;
    this.client = null;
    for (const track of this.tracks) { track.stop(); track.close(); }
    this.tracks = [];
    this.remoteAudio?.stop();
    this.remoteAudio = null;
    this.video(false);
    if (client) {
      try { await client.leave(); } finally { client.removeAllListeners(); }
    }
    this.state('Not connected');
  }
}
