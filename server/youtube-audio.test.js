'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  parseYouTubeUrl, parseAudioRequest, validateMetadata, startAudioJob,
  MAX_DURATION_SECONDS, MAX_AUDIO_BYTES,
} = require('./youtube-audio');

const VID = 'dQw4w9WgXcQ';
const CANONICAL = 'https://www.youtube.com/watch?v=' + VID;

test('accepts single YouTube watch, short, live replay, music and shorts URLs', () => {
  assert.equal(parseYouTubeUrl('https://youtu.be/' + VID + '?feature=share'), CANONICAL);
  assert.equal(parseYouTubeUrl('https://www.youtube.com/watch?v=' + VID + '&list=PLabc'), CANONICAL);
  assert.equal(parseYouTubeUrl('https://m.youtube.com/shorts/' + VID), CANONICAL);
  assert.equal(parseYouTubeUrl('https://music.youtube.com/watch?v=' + VID), CANONICAL);
  assert.equal(parseYouTubeUrl('https://youtube.com/live/' + VID), CANONICAL);
  assert.equal(parseYouTubeUrl('https://youtube.com/embed/' + VID), CANONICAL);
});

test('rejects arbitrary hosts, malformed ids, unsafe URLs, and playlists', () => {
  for (const value of [
    'https://youtube.com.evil.test/watch?v=' + VID,
    'https://www.youtube.com@evil.test/watch?v=' + VID,
    'https://youtu.be/' + VID + '/extra',
    'http://youtu.be/' + VID,
    'https://youtu.be/bad',
    'https://youtube.com/playlist?list=PLabc',
    'https://127.0.0.1:8080/',
    'https://example.com/?url=https://youtu.be/' + VID,
    'https://youtu.be/' + VID + '\n--exec something',
    'not a link',
  ]) assert.equal(parseYouTubeUrl(value), null, value);
});

test('recognizes /audio and an otherwise bare YouTube link', () => {
  assert.deepEqual(parseAudioRequest('/audio ' + CANONICAL), { explicit: true, url: CANONICAL });
  assert.deepEqual(parseAudioRequest('/audio@HvostMarketRusBot ' + CANONICAL), { explicit: true, url: CANONICAL });
  assert.deepEqual(parseAudioRequest('/audio'), { explicit: true, url: null });
  assert.deepEqual(parseAudioRequest('https://youtu.be/' + VID), { explicit: false, url: CANONICAL });
  assert.equal(parseAudioRequest('Посмотри https://youtu.be/' + VID), null);
  assert.equal(parseAudioRequest('/stock'), null);
});

test('enforces maximum length and rejects live or unknown-duration content', () => {
  assert.deepEqual(validateMetadata({duration: 12, title: 'A\nB'}), { duration: 12, title: 'A B' });
  assert.equal(validateMetadata({duration: MAX_DURATION_SECONDS, title: 'ok'}).duration, MAX_DURATION_SECONDS);
  assert.throws(() => validateMetadata({duration: MAX_DURATION_SECONDS + 1}), /40 минут/);
  assert.throws(() => validateMetadata({duration: 0}), /длительность/i);
  assert.throws(() => validateMetadata({duration: 10, is_live: true}), /трансляции/);
  assert.throws(() => validateMetadata({duration: 10, live_status: 'is_upcoming'}), /трансляции/);
  assert.ok(MAX_AUDIO_BYTES < 50 * 1000 * 1000);
});

test('one queued job does not block the caller, prevents overlap and cleans temporary files', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-audio-test-'));
  let complete;
  const gate = new Promise(resolve => { complete = resolve; });
  const messages = [];
  const first = startAudioJob({
    chatId: 7, videoUrl: CANONICAL, botToken: 'fake',
    reply: async (_, message) => { messages.push(message); },
    prepare: async () => {
      await gate;
      const filePath = path.join(temp, 'audio.mp3');
      await fs.writeFile(filePath, Buffer.from('mock audio'));
      return { filePath, tmpDir: temp, title: 'Test', duration: 2 };
    },
    upload: async ({audio}) => assert.equal(audio.title, 'Test'),
  });
  assert.equal(first.ok, true);
  const second = startAudioJob({
    chatId: 8, videoUrl: CANONICAL, botToken: 'fake',
    reply: async () => {},
  });
  assert.equal(second.ok, false);
  complete();
  await first.done;
  assert.ok(messages.some(message => message.includes('отправлено')));
  await assert.rejects(() => fs.stat(temp), { code: 'ENOENT' });
  const after = startAudioJob({
    chatId: 8, videoUrl: CANONICAL, botToken: 'fake',
    reply: async () => {},
    prepare: async () => { throw new Error('mock'); },
  });
  assert.equal(after.ok, true);
  await after.done;
});
