// Download the audio track from a single public YouTube video for linked super-admins.
// Keep this workload outside the Telegram long-polling loop and the shop order flow.
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_DURATION_SECONDS = 40 * 60;
const MAX_AUDIO_BYTES = 45 * 1024 * 1024; // Telegram Bot API upload limit is 50 MB.
const MAX_ACTIVE_JOBS = 1; // Protect the shop's CPU, memory, and network.
const activeChats = new Set();

class AudioRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AudioRequestError';
  }
}

// Construct a canonical watch URL, never pass arbitrary URLs or user-supplied
// yt-dlp options to the downloader (SSRF and command-injection prevention).
function parseYouTubeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 2048 || /\s/.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch (_) { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;

  const hostname = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let videoId = null;

  if (hostname === 'youtu.be') {
    if (parts.length === 1) videoId = parts[0];
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(hostname)) {
    if (url.pathname === '/watch') videoId = url.searchParams.get('v');
    else if (parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0])) videoId = parts[1];
  }

  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) return null;
  return 'https://www.youtube.com/watch?v=' + videoId;
}

function parseAudioRequest(text) {
  const raw = String(text || '').trim();
  const command = /^\/audio(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(raw);
  if (command) return { explicit: true, url: parseYouTubeUrl(command[1]) };
  const url = parseYouTubeUrl(raw);
  return url ? { explicit: false, url } : null;
}

function validateMetadata(metadata) {
  if (metadata?.is_live || ['is_live', 'is_upcoming', 'post_live'].includes(metadata?.live_status)) {
    throw new AudioRequestError('🔴 Прямые трансляции и ещё не завершённые эфиры не поддерживаются.');
  }
  const seconds = Number(metadata?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new AudioRequestError('⚠️ Не удалось определить длительность видео. Такой ролик загрузить нельзя.');
  }
  if (seconds > MAX_DURATION_SECONDS) {
    throw new AudioRequestError('⏱ Видео длиннее 40 минут. Для защиты сервера такие файлы не загружаются.');
  }
  return {
    duration: Math.ceil(seconds),
    title: String(metadata.title || 'Аудио с YouTube').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140) || 'Аудио с YouTube',
  };
}

// One process group per yt-dlp call, killed on timeout or excessive output.
// No shell is involved; ffmpeg descendants are killed with the group on Linux.
async function runYtDlp(args, timeoutMs, stdoutLimit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.YT_DLP_BIN || 'yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let stopped = false;
    let timedOut = false;
    let tooMuchOutput = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch (_) { /* Process already exited. */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > stdoutLimit) {
        tooMuchOutput = true;
        stop();
      }
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new AudioRequestError('⌛ YouTube слишком долго отвечает. Повторите попытку позднее.'));
      else if (tooMuchOutput) reject(new AudioRequestError('⚠️ YouTube вернул слишком много данных о ролике.'));
      else if (code !== 0) {
        console.warn('[youtube-audio] yt-dlp:', stderr.replace(/https?:\/\/\S+/g, '[url]').slice(-1200));
        reject(new AudioRequestError('⚠️ Не удалось получить аудио. Проверьте, что видео открыто для просмотра и не требует авторизации.'));
      } else resolve(stdout);
    });
  });
}

const COMMON_ARGS = [
  '--ignore-config', '--no-playlist', '--no-cache-dir', '--no-warnings',
  '--js-runtimes', 'node',
  '--socket-timeout', '15', '--retries', '2', '--extractor-retries', '2',
];

async function prepareYoutubeAudio(videoUrl) {
  const infoJson = await runYtDlp(
    [...COMMON_ARGS, '--dump-single-json', '--skip-download', videoUrl], 45000
  );
  let metadata;
  try { metadata = JSON.parse(infoJson); }
  catch (_) { throw new AudioRequestError('⚠️ Не удалось прочитать сведения о видео.'); }
  const details = validateMetadata(metadata);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hvost-youtube-audio-'));
  try {
    await runYtDlp([
      ...COMMON_ARGS,
      '--no-progress', '--quiet', '--no-part',
      '--max-filesize', '45M',
      '--match-filters', 'duration <= 2400 & !is_live',
      '--format', 'bestaudio[ext=m4a]/bestaudio',
      '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '128K',
      '--output', path.join(tmpDir, 'audio.%(ext)s'),
      videoUrl,
    ], 180000, 64 * 1024);

    const filePath = path.join(tmpDir, 'audio.mp3');
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AUDIO_BYTES) {
      throw new AudioRequestError('📦 Аудиофайл слишком большой для отправки в Telegram (максимум 45 МБ).');
    }
    return { ...details, filePath, tmpDir };
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function uploadTelegramAudio({ token, chatId, audio }) {
  const bytes = await fs.readFile(audio.filePath);
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new AudioRequestError('📦 Аудиофайл превышает допустимый размер.');
  }
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('title', audio.title);
  form.append('duration', String(audio.duration));
  form.append('audio', new Blob([bytes], { type: 'audio/mpeg' }), 'YouTube_audio.mp3');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch('https://api.telegram.org/bot' + token + '/sendAudio', {
      method: 'POST', body: form, signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      console.warn('[youtube-audio] Telegram refused upload:', response.status, String(result.description || '').slice(0, 250));
      throw new AudioRequestError('⚠️ Telegram не принял аудиофайл. Попробуйте другой ролик или повторите позже.');
    }
    return result.result;
  } catch (error) {
    if (error instanceof AudioRequestError) throw error;
    throw new AudioRequestError('⚠️ Не удалось отправить аудио в Telegram. Повторите позднее.');
  } finally {
    clearTimeout(timer);
  }
}

// Fire-and-forget by design. Awaiting a video download in processUpdate would
// block Telegram getUpdates, including payment notifications and Mini App login.
function startAudioJob({ chatId, videoUrl, botToken, reply, prepare = prepareYoutubeAudio, upload = uploadTelegramAudio }) {
  if (activeChats.size >= MAX_ACTIVE_JOBS) {
    return { ok: false, message: '⏳ Бот уже обрабатывает один аудиофайл. Повторите запрос после завершения.' };
  }
  if (!botToken) return { ok: false, message: '⚠️ Telegram-бот сейчас не настроен.' };
  const key = String(chatId);
  activeChats.add(key);
  const done = (async () => {
    let audio;
    try {
      await reply(chatId, '🎧 Получаю аудио с YouTube и готовлю MP3. Пришлю его сюда.');
      audio = await prepare(videoUrl);
      await upload({ token: botToken, chatId, audio });
      await reply(chatId, '✅ Аудио отправлено. Сохранить его можно через меню файла в Telegram.');
    } catch (error) {
      console.warn('[youtube-audio] Job failed:', error.message);
      const userMessage = error instanceof AudioRequestError
        ? error.message
        : (error.code === 'ENOENT'
          ? '⚠️ На сервере пока не установлен загрузчик аудио.'
          : '⚠️ Ошибка загрузки аудио. Попробуйте позже.');
      try { await reply(chatId, userMessage); }
      catch (replyError) { console.warn('[youtube-audio] Error reply failed:', replyError.message); }
    } finally {
      if (audio?.tmpDir) await fs.rm(audio.tmpDir, { recursive: true, force: true }).catch(() => {});
      activeChats.delete(key);
    }
  })();
  return { ok: true, done };
}

module.exports = {
  parseYouTubeUrl, parseAudioRequest, validateMetadata, startAudioJob,
  MAX_DURATION_SECONDS, MAX_AUDIO_BYTES,
};
