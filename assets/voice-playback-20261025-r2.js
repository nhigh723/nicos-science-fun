// A single owner for all recorded narration. Only explicit mute/Skip may interrupt it.
export function voiceHash(text) {
  let hash = 5381;
  const trimmed = text.trim();
  for (let i = 0; i < trimmed.length; i++) hash = (hash * 33 + trimmed.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

const small = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const tens = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
export function numberWords(number) {
  if (number < 20) return small[number];
  if (number < 100) return tens[Math.floor(number / 10)] + (number % 10 ? ' ' + small[number % 10] : '');
  for (const [size, name] of [[1000000000,'billion'],[1000000,'million'],[1000,'thousand'],[100,'hundred']]) {
    if (number >= size) return numberWords(Math.floor(number / size)) + ' ' + name + (number % size ? ' ' + numberWords(number % size) : '');
  }
  return String(number);
}

export function normalizeVoiceText(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/co2/g, 'carbon dioxide').replace(/[’']/g, '')
    .replace(/\+/g, ' plus ').replace(/\bvs\b/g, 'versus')
    .replace(/\bunder water\b/g, 'underwater')
    .replace(/\b\d+\b/g, value => numberWords(Number(value)))
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export function resolveRecordedSpeech(text, manifest, index) {
  const exact = manifest[voiceHash(text)];
  if (exact) return Array.isArray(exact) ? exact : [exact];
  const normalized = normalizeVoiceText(text);
  if (index[normalized]) return [].concat(index[normalized]);
  const words = normalized.split(' '), best = Array(words.length + 1).fill(null);
  best[words.length] = [];
  // Prefer the fewest complete recorded phrases. Never fall back to a device voice.
  for (let start = words.length - 1; start >= 0; start--) {
    for (let end = words.length; end > start; end--) {
      const clip = index[words.slice(start, end).join(' ')];
      if (!clip || !best[end]) continue;
      const candidate = [].concat(clip, best[end]);
      if (!best[start] || candidate.length < best[start].length) best[start] = candidate;
    }
  }
  return best[0];
}

// Assemble before starting: the audio thread plays the complete sentence even
// when the canvas/game loop keeps the JavaScript thread busy. Only digital silence
// at internal joins is removed; the first and final recording remain complete.
export function joinRecordedBuffers(context, clips) {
  if (clips.length === 1) return clips[0];
  const sampleRate = clips[0].sampleRate;
  const channels = Math.max(...clips.map(b => b.numberOfChannels));
  const spans = clips.map((b, index) => {
    if (b.sampleRate !== sampleRate) throw new Error('Inconsistent recording sample rate');
    let first = b.length, last = -1;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const data = b.getChannelData(c);
      for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > 0.0001) { first = Math.min(first, i); break; }
      for (let i = data.length - 1; i >= 0; i--) if (Math.abs(data[i]) > 0.0001) { last = Math.max(last, i); break; }
    }
    const pad = Math.ceil(sampleRate * 0.04);
    return { b, start: index && last >= 0 ? Math.max(0, first - pad) : 0,
      end: index < clips.length - 1 && last >= 0 ? Math.min(b.length, last + 1 + pad) : b.length };
  });
  const merged = context.createBuffer(channels, spans.reduce((n,s) => n + s.end - s.start, 0), sampleRate);
  for (let c = 0; c < channels; c++) {
    const out = merged.getChannelData(c); let offset = 0;
    for (const {b,start,end} of spans) {
      out.set(b.getChannelData(Math.min(c,b.numberOfChannels-1)).subarray(start,end), offset);
      offset += end - start;
    }
  }
  return merged;
}

export function createRecordedVoicePlayer({ getContext, isEnabled, connect, onMissing = () => {}, fetcher = (...args) => fetch(...args), manifestURL = './voice/manifest-20261025-r2.json', indexURL = './voice/recorded-text-20261025-r2.json', maxPending = 3, maxCachedBytes = 16 * 1024 * 1024 }) {
  let manifest = null, index = {}, ready = null, active = null, queue = [];
  const buffers = new Map(), loading = new Map(), durations = new Map();
  let cachedBytes = 0;
  async function init() {
    if (!ready) ready = Promise.all([readJSON(manifestURL), readJSON(indexURL)]).then(([m, i]) => { manifest = m; index = i.phrases || i; for (const [file, duration] of Object.entries(i.durations || {})) durations.set(file, duration); }).catch(error => { ready = null; throw error; });
    return ready;
  }
  async function readJSON(url) {
    const response = await fetcher(url);
    if (!response.ok) throw new Error('Voice catalog could not load');
    return response.json();
  }
  function load(file) {
    if (buffers.has(file)) { const b = buffers.get(file); buffers.delete(file); buffers.set(file,b); return Promise.resolve(b); }
    if (!loading.has(file)) {
      const url = file.startsWith('./') ? file : './voice/' + file;
      const request = fetcher(url).then(response => {
        if (!response.ok) throw new Error('Voice recording could not load');
        return response.arrayBuffer();
      }).then(bytes => getContext().decodeAudioData(bytes)).then(buffer => {
        buffers.set(file, buffer); durations.set(file, buffer.duration);
        cachedBytes += buffer.length * buffer.numberOfChannels * 4;
        while (cachedBytes > maxCachedBytes && buffers.size > 1) {
          const oldest = buffers.keys().next().value, b = buffers.get(oldest);
          cachedBytes -= b.length * b.numberOfChannels * 4; buffers.delete(oldest);
        }
        return buffer;
      }).finally(() => loading.delete(file));
      loading.set(file, request);
    }
    return loading.get(file);
  }
  function settle(item, reason) {
    if (item.settled) return;
    item.settled = true;
    item.onEnd?.(reason);
  }
  function clearPending() {
    const pending = queue; queue = [];
    for (const item of pending) settle(item, 'superseded');
    // An abandoned fetch must not start speaking on a later screen.
    if (active && !active.started) {
      const item = active; active = null; settle(item, 'superseded');
    }
  }
  function stop() {
    clearPending();
    if (!active) return;
    const item = active; active = null;
    item.stop?.(); settle(item, 'stopped');
  }
  function enqueue(item, priority = false) {
    if (!isEnabled() || !getContext()) { settle(item, 'disabled'); return; }
    if (active?.key === item.key || queue.some(q => q.key === item.key)) { settle(item, 'duplicate'); return; }
    if (priority) clearPending();
    queue.push(item);
    while (queue.length > maxPending) settle(queue.shift(), 'superseded');
    pump();
  }
  async function pump() {
    if (active || !queue.length) return;
    const item = active = queue.shift();
    try {
      await init();
      if (active !== item) return;
      const files = item.url ? [item.url] : resolveRecordedSpeech(item.text, manifest, index);
      if (!files?.length) { onMissing(item.text); throw new Error('No approved recording'); }
      const clips = await Promise.all(files.map(load));
      if (active !== item || !isEnabled()) return;
      const context = getContext();
      const buffer = joinRecordedBuffers(context, clips);
      item.started = true;
      item.onStart?.(buffer.duration);
      await new Promise(resolve => {
        const source = context.createBufferSource();
        source.buffer = buffer;
        connect(source);
        const onEnded = source.onended;
        let done = false;
        const finish = () => { if (done) return; done = true; onEnded?.(); resolve(); };
        source.onended = finish;
        item.stop = () => { try { source.stop(); } catch {} finish(); };
        source.start();
      });
      if (active === item) settle(item, 'ended');
    } catch (error) {
      if (active === item) settle(item, 'unavailable');
    } finally {
      if (active === item) active = null;
      pump();
    }
  }
  return {
    init,
    say(text, options = {}) { enqueue({ text, key: normalizeVoiceText(text), ...options }, options.priority); },
    playURL(url, options = {}) { enqueue({ url, key: url, ...options }, options.priority); },
    clearPending, stop,
    contains(text) { const key = normalizeVoiceText(text); return active?.key === key || queue.some(item => item.key === key); },
    get busy() { return !!active || queue.length > 0; },
    get active() { return active ? { text: active.text, key: active.key, started: !!active.started } : null; },
    get pending() { return queue.map(item => item.text || item.url); },
    duration(text) {
      if (!manifest) return 0;
      const files = resolveRecordedSpeech(text, manifest, index);
      return files?.every(file => durations.has(file)) ? files.reduce((sum, file) => sum + durations.get(file), 0) : 0;
    },
    // Initialize the small catalogs only. Decoding the entire library during play
    // creates unnecessary memory/CPU pressure on children's tablets and phones.
    async preload() { await init(); },
    get cacheBytes() { return cachedBytes; },
    resolve(text) { return manifest ? resolveRecordedSpeech(text, manifest, index) : null; }
  };
}
