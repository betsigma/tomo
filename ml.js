// ml.js
// ---------------------------------------------------------------------------
// LEARNED RELEVANCE FILTER (on-device, main process only).
//
// Plain-English summary of what happens here:
//   1. EMBED  - a small pre-trained sentence model (via Transformers.js) turns a
//               piece of text into a list of ~384 numbers ("a vector"). Text
//               with a similar meaning gets a similar vector. The model weights
//               are downloaded from Hugging Face ONCE and cached under
//               data/models, then every run is fully local. No email text ever
//               leaves this computer.
//   2. TRAIN  - a logistic-regression classifier is fitted in plain JavaScript
//               on the vectors of YOUR labelled examples (useful / not useful).
//               That is the only thing that "learns" your taste.
//   3. SCORE  - a new piece of text is embedded and the classifier returns a
//               probability from 0 (= not useful) to 1 (= useful).
//   4. LABEL DECISION - classify() turns that number plus two safety rules
//               (deadline word, timed appointment) into 'normal' / 'suggested'
//               / 'hidden'. The renderer maps that to a status.
//
// Nothing in this file touches the network except the one-time model download.
// If the local runtime or the model cannot load, every function fails softly so
// the app keeps working with the rule-based pipeline only.
//
// The maths (trainLogistic / predict / classify / shouldTrain) is pure, so it is
// unit-tested in plain Node by test-features.js without Transformers.js.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Tunables (also surfaced in Settings so they are visible, not magic)
// ---------------------------------------------------------------------------
const DEFAULT_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2'; // 384-dim, ~23 MB quantized
const COLD_START_EXAMPLES = 40;   // don't use the model until this many labels
const RETRAIN_EVERY = 10;         // retrain after this many NEW labels
const SCORE_NORMAL = 0.7;         // >= this -> normal event
const SCORE_HIDE = 0.3;           // < this -> hidden (unless protected)
const MAX_TEXT = 600;             // characters of text ever embedded
const EMB_CACHE_MAX = 600;        // cached vectors kept on disk
const VEC_PRECISION = 4;          // decimals kept per vector value (smaller file)

// ---------------------------------------------------------------------------
// Pure helpers: text
// ---------------------------------------------------------------------------
function normalizeText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

// The text of one example: subject + the section text that produced the event.
function buildExampleText({ subject = '', title = '', text = '' } = {}) {
  return normalizeText([subject, title, text].filter(Boolean).join(' | '));
}

function hashText(modelId, text) {
  return crypto.createHash('sha1').update(modelId + '\n' + text).digest('hex').slice(0, 24);
}

// ---------------------------------------------------------------------------
// Pure helpers: maths (logistic regression)
// ---------------------------------------------------------------------------
function sigmoid(z) {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z);
  return e / (1 + e);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Per-dimension mean and standard deviation, so no single feature dominates.
function fitStandardizer(X) {
  const n = X.length;
  const d = X[0] ? X[0].length : 0;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j] / n;
  for (const row of X) for (let j = 0; j < d; j++) { const t = row[j] - mean[j]; std[j] += (t * t) / n; }
  for (let j = 0; j < d; j++) std[j] = Math.max(Math.sqrt(std[j]), 1e-6);
  return { mean, std, dim: d };
}

function standardizeRow(row, stats) {
  const out = new Array(stats.dim);
  for (let j = 0; j < stats.dim; j++) out[j] = (row[j] - stats.mean[j]) / stats.std[j];
  return out;
}

// Full-batch gradient descent with L2 penalty and class weights (so a lopsided
// number of useful / not-useful examples does not skew the fit).
function trainLogistic(X, y, { epochs = 500, lr = 0.6, l2 = 0.01 } = {}) {
  const n = X.length;
  const d = X[0] ? X[0].length : 0;
  if (!n || !d) return null;

  const pos = y.reduce((a, v) => a + (v === 1 ? 1 : 0), 0);
  const neg = n - pos;
  const wPos = pos ? n / (2 * pos) : 1;
  const wNeg = neg ? n / (2 * neg) : 1;

  const w = new Array(d).fill(0);
  let b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(dot(w, X[i]) + b);
      const cw = y[i] === 1 ? wPos : wNeg;
      const err = (p - y[i]) * cw;
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { weights: w, bias: b };
}

// Fit a complete model (standardizer + weights) from raw vectors.
function fit(X, y, opts) {
  if (!X.length || !X[0]) return null;
  const stats = fitStandardizer(X);
  const Xs = X.map((r) => standardizeRow(r, stats));
  const core = trainLogistic(Xs, y, opts);
  if (!core) return null;
  return { dim: stats.dim, mean: stats.mean, std: stats.std, weights: core.weights, bias: core.bias };
}

// Probability that a raw vector belongs to the "useful" class.
function predict(model, x) {
  if (!model || !model.weights || !x) return null;
  const z = dot(model.weights, standardizeRow(x, model)) + model.bias;
  return sigmoid(z);
}

function accuracyOf(model, X, y) {
  if (!X.length) return 0;
  let ok = 0;
  for (let i = 0; i < X.length; i++) {
    const p = predict(model, X[i]);
    if ((p >= 0.5 ? 1 : 0) === y[i]) ok++;
  }
  return ok / X.length;
}

// Tiny deterministic PRNG so a held-out split is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seed) {
  const r = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Train on 80% and measure the accuracy on the held-out 20%, then fit the model
// that will actually be used on ALL the examples. Accuracy is only reported when
// the held-out set contains BOTH classes (otherwise it would be a meaningless
// "always guess the majority" number).
function trainAndEvaluate(X, y, { ratio = 0.2, seed = 42, coldStart = COLD_START_EXAMPLES } = {}) {
  const n = X.length;
  const pos = y.reduce((a, v) => a + (v === 1 ? 1 : 0), 0);
  const neg = n - pos;
  if (n < coldStart || !pos || !neg) {
    return { model: null, accuracy: null, heldOut: 0, testPos: 0, testNeg: 0, reason: 'not-enough' };
  }

  const idx = seededShuffle([...Array(n).keys()], seed);
  const testN = Math.max(1, Math.round(n * ratio));
  const testIdx = idx.slice(0, testN);
  const trainIdx = idx.slice(testN);

  const Xtr = trainIdx.map((i) => X[i]);
  const ytr = trainIdx.map((i) => y[i]);
  const Xte = testIdx.map((i) => X[i]);
  const yte = testIdx.map((i) => y[i]);

  const testPos = yte.reduce((a, v) => a + (v === 1 ? 1 : 0), 0);
  const testNeg = yte.length - testPos;

  let accuracy = null;
  if (trainIdx.length >= 2 && testPos > 0 && testNeg > 0) {
    const mTr = fit(Xtr, ytr);
    if (mTr) accuracy = accuracyOf(mTr, Xte, yte);
  }

  return { model: fit(X, y), accuracy, heldOut: testIdx.length, testPos, testNeg, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Pure helpers: when to train, and how to turn a score into a decision
// ---------------------------------------------------------------------------
// Retrain only when it is worth it: cold start done, both classes seen, and
// either there is no model yet or RETRAIN_EVERY new labels have arrived.
function shouldTrain({ labeled = 0, pos = 0, neg = 0, lastTrained = 0 } = {}, opts = {}) {
  const coldStart = opts.coldStart || COLD_START_EXAMPLES;
  const retrainEvery = opts.retrainEvery || RETRAIN_EVERY;
  if (opts.force) return { train: true, reason: 'forced' };
  if (labeled < coldStart) return { train: false, reason: `cold-start (${labeled}/${coldStart})` };
  if (!pos || !neg) return { train: false, reason: 'need-both-classes' };
  if (!lastTrained) return { train: true, reason: 'first-train' };
  if (labeled - lastTrained >= retrainEvery) return { train: true, reason: 'enough-new-labels' };
  return { train: false, reason: 'not-enough-new' };
}

// Turn a score into a class + a short human reason.
//   >= 0.7            -> 'normal'    (shown as a real event)
//   0.3 .. 0.7        -> 'suggested' (needs your accept/dismiss)
//   < 0.3             -> 'hidden'    (parked in Settings > Filtered out)
// SAFETY: an explicit deadline word, or a timed appointment, is NEVER hidden —
// the worst it can get is 'suggested'.
function classify(score, { deadlineWord = false, timedAppointment = false } = {}) {
  const s = Math.max(0, Math.min(1, Number(score)));
  const pct = Math.round(s * 100);
  if (s >= SCORE_NORMAL) return { cls: 'normal', reason: `looks relevant to you (${pct}%)` };
  if (s >= SCORE_HIDE) return { cls: 'suggested', reason: `uncertain, worth a look (${pct}%)` };
  if (deadlineWord || timedAppointment) {
    const why = deadlineWord ? 'it has a deadline word' : 'it is a timed appointment';
    return { cls: 'suggested', reason: `low score (${pct}%) but kept visible: ${why}` };
  }
  return { cls: 'hidden', reason: `looks like ones you skip (${pct}%)` };
}

// ---------------------------------------------------------------------------
// Model store (weights + cached vectors on disk) and the on-device model
// ---------------------------------------------------------------------------
class RelevanceModel {
  constructor({ dataDir, log = console.log, embedModel = DEFAULT_EMBED_MODEL } = {}) {
    this.dataDir = dataDir;
    this.log = log;
    this.embedModel = embedModel;
    this.modelFile = path.join(dataDir, 'ml-model.json');
    this.vecFile = path.join(dataDir, 'ml-embeddings.json');

    this.weights = null;          // the fitted logistic-regression model
    this.meta = this._emptyMeta();
    this.vecCache = {};           // textHash -> vector
    this.embedder = null;         // the Transformers.js pipeline (loaded lazily)
    this.embedderPromise = null;
    this.embedderState = 'idle';  // idle | loading | ready | error
    this.embedderError = null;
    this.training = false;
    this.lastError = null;
    this.queue = Promise.resolve();

    this.load();
  }

  _emptyMeta() {
    return {
      embedModel: this.embedModel, trainedOn: 0, accuracy: null, heldOut: 0,
      testPos: 0, testNeg: 0, classes: { pos: 0, neg: 0 },
      dim: 0, updatedAt: null, pendingReason: 'cold-start'
    };
  }

  // ---- disk ----
  load() {
    try {
      const m = JSON.parse(fs.readFileSync(this.modelFile, 'utf8'));
      if (m && m.weights && Array.isArray(m.weights.weights)) {
        this.weights = m.weights;
        this.meta = { ...this._emptyMeta(), ...(m.meta || {}) };
      }
    } catch { /* no saved model yet */ }
    try {
      const v = JSON.parse(fs.readFileSync(this.vecFile, 'utf8'));
      if (v && typeof v === 'object') this.vecCache = v;
    } catch { /* no cache yet */ }
  }

  _writeAtomic(file, obj) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log('[ml] could not write ' + file + ': ' + (err && err.message));
    }
  }

  save() {
    this._writeAtomic(this.modelFile, { weights: this.weights, meta: this.meta });
  }

  saveVecCache() {
    this._writeAtomic(this.vecFile, this.vecCache);
  }

  // ---- embedder (Transformers.js, loaded once, cached on disk) ----
  async ensureEmbedder() {
    if (this.embedder) return this.embedder;
    if (this.embedderPromise) return this.embedderPromise;
    this.embedderState = 'loading';
    this.embedderPromise = (async () => {
      // Lazy require: a missing/broken install must not stop the app from starting.
      const tf = require('@huggingface/transformers');
      const cacheDir = path.join(this.dataDir, 'models');
      fs.mkdirSync(cacheDir, { recursive: true });
      tf.env.cacheDir = cacheDir;          // weights cached here after the first download
      tf.env.allowLocalModels = true;
      tf.env.allowRemoteModels = true;     // one-time download from Hugging Face
      this.log('[ml] loading local embedding model ' + this.embedModel + ' (first run downloads ~23 MB)...');
      let extractor;
      try {
        extractor = await tf.pipeline('feature-extraction', this.embedModel, { dtype: 'q8' });
      } catch (err) {
        // Older builds may not understand `dtype`; try the default options.
        extractor = await tf.pipeline('feature-extraction', this.embedModel);
      }
      this.embedder = extractor;
      this.embedderState = 'ready';
      this.log('[ml] embedding model ready');
      return extractor;
    })().catch((err) => {
      this.embedderState = 'error';
      this.embedderError = String((err && err.message) || err);
      this.embedderPromise = null;
      this.log('[ml] embedding model unavailable: ' + this.embedderError);
      throw err;
    });
    return this.embedderPromise;
  }

  // Embed a list of strings into vectors. Batched to keep memory steady.
  async embed(texts) {
    const extractor = await this.ensureEmbedder();
    const out = [];
    const BATCH = 8;
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const res = await extractor(batch, { pooling: 'mean', normalize: true });
      const dims = res.dims || [];
      const dim = dims[dims.length - 1];
      const data = res.data;
      for (let b = 0; b < batch.length; b++) {
        const vec = new Array(dim);
        for (let j = 0; j < dim; j++) {
          const v = data[b * dim + j];
          vec[j] = Number(v.toFixed(VEC_PRECISION));
        }
        out.push(vec);
      }
    }
    return out;
  }

  pruneCache() {
    const keys = Object.keys(this.vecCache);
    if (keys.length <= EMB_CACHE_MAX) return;
    for (const k of keys.slice(0, keys.length - EMB_CACHE_MAX)) delete this.vecCache[k];
  }

  // Vectors for a list of texts, using the on-disk cache when possible.
  async vectorsFor(texts) {
    const result = new Array(texts.length);
    const need = new Map();   // text -> [indices]
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      const h = hashText(this.embedModel, t);
      if (this.vecCache[h]) result[i] = this.vecCache[h];
      else {
        if (!need.has(t)) need.set(t, []);
        need.get(t).push(i);
      }
    }
    if (need.size) {
      const uniq = [...need.keys()];
      const vecs = await this.embed(uniq);
      uniq.forEach((t, k) => {
        const v = vecs[k];
        this.vecCache[hashText(this.embedModel, t)] = v;
        for (const i of need.get(t)) result[i] = v;
      });
      this.pruneCache();
      this.saveVecCache();
    }
    return result;
  }

  // ---- training ----
  // Queue the work so two label actions can never train at the same time.
  train(examples, { force = false } = {}) {
    this.queue = this.queue.then(() => this._train(examples, force)).catch((err) => {
      this.training = false;
      this.lastError = String((err && err.message) || err);
      this.log('[ml] training failed: ' + this.lastError);
      return this.status();
    });
    return this.queue;
  }

  async _train(examples, force) {
    const clean = dedupeExamples(examples);
    const pos = clean.filter((e) => e.label === 1).length;
    const neg = clean.length - pos;

    const decision = shouldTrain(
      { labeled: clean.length, pos, neg, lastTrained: this.meta.trainedOn || 0 },
      { force }
    );
    this.meta.pendingReason = decision.reason;
    if (!decision.train) {
      this.log(`[ml] not training yet: ${decision.reason}`);
      this.save();
      return this.status();
    }

    this.training = true;
    this.lastError = null;
    try {
      this.log(`[ml] training on ${clean.length} examples (${pos} useful / ${neg} not)...`);
      const vectors = await this.vectorsFor(clean.map((e) => e.text));
      const X = vectors;
      const y = clean.map((e) => e.label);
      const { model, accuracy, heldOut, testPos, testNeg } = trainAndEvaluate(X, y, {
        coldStart: COLD_START_EXAMPLES
      });
      if (!model) {
        this.log('[ml] training produced no model (not enough usable data)');
        return this.status();
      }
      this.weights = model;
      this.meta = {
        ...this._emptyMeta(),
        embedModel: this.embedModel,
        dim: model.dim,
        trainedOn: clean.length,
        accuracy,
        heldOut,
        testPos,
        testNeg,
        classes: { pos, neg },
        updatedAt: new Date().toISOString(),
        pendingReason: ''
      };
      this.save();
      const acc = accuracy == null ? 'n/a (held-out set needs both classes)' : (accuracy * 100).toFixed(1) + '%';
      this.log(`[ml] trained on ${clean.length} examples, held-out accuracy ${acc}`);
      return this.status();
    } finally {
      this.training = false;
    }
  }

  // ---- scoring ----
  // Returns an array of probabilities, or null when there is no usable model.
  async scoreTexts(texts) {
    if (!this.weights || !texts || !texts.length) return null;
    const vectors = await this.vectorsFor(texts);
    return vectors.map((v) => predict(this.weights, v));
  }

  warmUp() {
    // Start the one-time model download/load without blocking anything.
    this.ensureEmbedder().catch(() => {});
  }

  reset() {
    this.weights = null;
    this.meta = this._emptyMeta();
    this.vecCache = {};
    this.lastError = null;
    for (const f of [this.modelFile, this.vecFile]) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
    return this.status();
  }

  status() {
    const acc = this.meta.accuracy;
    return {
      embedModel: this.embedModel,
      modelReady: !!this.weights,
      trainedOn: this.meta.trainedOn || 0,
      accuracy: acc == null ? null : acc,
      heldOut: this.meta.heldOut || 0,
      testPos: this.meta.testPos || 0,
      testNeg: this.meta.testNeg || 0,
      classes: this.meta.classes || { pos: 0, neg: 0 },
      updatedAt: this.meta.updatedAt || null,
      pendingReason: this.meta.pendingReason || '',
      embedder: this.embedderState,
      embedderError: this.embedderError,
      training: this.training,
      coldStart: COLD_START_EXAMPLES,
      retrainEvery: RETRAIN_EVERY,
      thresholds: { normal: SCORE_NORMAL, hide: SCORE_HIDE },
      lastError: this.lastError
    };
  }
}

// Keep one example per text (the newest label wins).
function dedupeExamples(examples) {
  const byText = new Map();
  for (const ex of (examples || [])) {
    const text = normalizeText(ex && ex.text);
    if (!text) continue;
    const label = ex.label === 1 || ex.label === true ? 1 : 0;
    byText.set(text, { text, label });
  }
  return [...byText.values()];
}

module.exports = {
  // constants
  DEFAULT_EMBED_MODEL,
  COLD_START_EXAMPLES,
  RETRAIN_EVERY,
  SCORE_NORMAL,
  SCORE_HIDE,
  MAX_TEXT,
  // pure
  normalizeText,
  buildExampleText,
  hashText,
  sigmoid,
  fitStandardizer,
  standardizeRow,
  trainLogistic,
  fit,
  predict,
  accuracyOf,
  seededShuffle,
  trainAndEvaluate,
  shouldTrain,
  classify,
  dedupeExamples,
  // stateful
  RelevanceModel
};
