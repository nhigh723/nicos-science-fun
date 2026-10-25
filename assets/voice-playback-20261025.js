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

export function createRecordedVoicePlayer({ getContext, isEnabled, connect, onMissing = () => {}, fetcher = (...args) => fetch(...args), manifestURL = './voice/manifest.json?v=20261025', indexURL = './voice/recorded-text-20261025.json', maxPending = 3 }) {
  let manifest = null, index = {}, ready = null, active = null, queue = [];
  const buffers = new Map(), loading = new Map();
  async function init() {
    if (!ready) ready = Promise.all([readJSON(manifestURL), readJSON(indexURL)]).then(([m, i]) => { manifest = m; index = i; }).catch(error => { ready = null; throw error; });
    return ready;
  }
  async function readJSON(url) {
    const response = await fetcher(url);
    if (!response.ok) throw new Error('Voice catalog could not load');
    return response.json();
  }
  function load(file) {
    if (buffers.has(file)) return Promise.resolve(buffers.get(file));
    if (!loading.has(file)) {
      const url = file.startsWith('./') ? file : './voice/' + file;
      const request = fetcher(url).then(response => {
        if (!response.ok) throw new Error('Voice recording could not load');
        return response.arrayBuffer();
      }).then(bytes => getContext().decodeAudioData(bytes)).then(buffer => {
        buffers.set(file, buffer); return buffer;
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
      item.started = true;
      item.onStart?.(clips.reduce((sum, b) => sum + b.duration, 0));
      // One source at a time, even for phrases assembled from recorded names/numbers.
      for (const buffer of clips) {
        if (active !== item || !isEnabled()) break;
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
      }
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
    get active() { return active ? { text: active.text, key: active.key, started: !!active.started } : null; },
    get pending() { return queue.map(item => item.text || item.url); },
    duration(text) {
      if (!manifest) return 0;
      const files = resolveRecordedSpeech(text, manifest, index);
      return files?.every(file => buffers.has(file)) ? files.reduce((sum, file) => sum + buffers.get(file).duration, 0) : 0;
    },
    async preload() {
      await init();
      const files = [...new Set(Object.values(manifest).flat())]; let next = 0;
      const worker = async () => { while (next < files.length) { try { await load(files[next++]); } catch {} } };
      await Promise.all([worker(), worker(), worker(), worker()]);
    },
    resolve(text) { return manifest ? resolveRecordedSpeech(text, manifest, index) : null; }
  };
}
