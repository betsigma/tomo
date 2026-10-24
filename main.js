// main.js
// ---------------------------------------------------------------------------
// MAIN process = the "brain". It creates the desktop window and does the jobs
// the page is not allowed to do: files, network, OS window control.
//
// Stage 3 adds Canvas sync:
//   - your Canvas iCal feed URL is a SECRET (it contains a private token), so it
//     is encrypted with the OS keystore (via Electron's safeStorage) and kept in
//     a separate data/secrets.json that ONLY this file touches.
//   - we download the .ics feed and parse it with node-ical, then hand the page
//     a clean, normalized list of items.
// ---------------------------------------------------------------------------

const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron');
const path = require('path');
require('./env').loadEnv(path.join(__dirname, '.env'));   // CREAO_* settings; values never logged
const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');
const { normalizeCalendar, fetchText } = require('./canvas');
const { fetchPreview, isTrusted, extractBodyText } = require('./gmail');
const { isJunkTitle } = require('./titles');
const { normalizeDiscordMessage } = require('./discord');
const llm = require('./llm');
const { RelevanceModel } = require('./ml');

let mainWindow = null;

// ---------------------------------------------------------------------------
// Local storage paths
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');       // app data (not secret)
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');   // encrypted secrets
const EXCLUDED_LOG = path.join(DATA_DIR, 'excluded-emails.log'); // review list for false positives

// The learned relevance filter. Everything it needs lives in data/ (ml-model.json,
// ml-embeddings.json and the cached embedding model under data/models). It is
// created here and only ever touched from this main process.
const mlModel = new RelevanceModel({ dataDir: DATA_DIR, log: (m) => console.log(m) });

const DEFAULT_STORE = {
  version: 1,
  events: [],
  todos: [],
  links: [],
  overrides: {},
  llmCache: {},
  settings: {
    theme: 'auto',
    refreshMinutes: 15,
    alwaysOnTop: true,
    viewMode: 'compact',
    deadlineWindowDays: 2,
    canvas: { lastSync: null, count: 0 },
    ml: { enabled: false, seeded: false }
  }
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Write JSON safely (temp file, then rename) so a crash can't corrupt it.
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// --------------------------- app data (public) -----------------------------
function loadStore() {
  ensureDataDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return {
      ...DEFAULT_STORE,
      ...parsed,
      settings: { ...DEFAULT_STORE.settings, ...(parsed.settings || {}) },
      events: Array.isArray(parsed.events) ? parsed.events : [],
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      links: Array.isArray(parsed.links) ? parsed.links : [],
      overrides: (parsed.overrides && typeof parsed.overrides === 'object') ? parsed.overrides : {},
      llmCache: (parsed.llmCache && typeof parsed.llmCache === 'object') ? parsed.llmCache : {}
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STORE));
  }
}
function saveStore(data) {
  ensureDataDir();
  writeJsonAtomic(STORE_FILE, data);
  return true;
}

// --------------------------- secrets (encrypted) ---------------------------
function loadSecrets() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSecrets(obj) {
  ensureDataDir();
  writeJsonAtomic(SECRETS_FILE, obj);
}

// Encrypt a string with the OS keystore when available; otherwise fall back to
// base64 (still not plain text, but weaker). The "enc:"/"plain:" prefix tells
// us later how it was stored.
function encryptSecret(plain) {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  }
  return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
}
function decryptSecret(stored) {
  if (!stored) return null;
  if (stored.startsWith('enc:')) {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
  }
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice(5), 'base64').toString('utf8');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

// (Downloading + iCalendar parsing now live in canvas.js.)

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 560,
    minWidth: 320,
    minHeight: 360,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: '#fff3f7',
    title: 'Schedule',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Forward page logs/errors to this terminal (handles both event shapes).
  mainWindow.webContents.on('console-message', (...args) => {
    const message = typeof args[2] === 'string' ? args[2] : (args[0] && args[0].message);
    if (message) console.log('[renderer]', message);
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

const VIEW_SIZES = {
  compact:  { width: 380, height: 560 },
  expanded: { width: 820, height: 660 },
  links:    { width: 820, height: 660 },
  focus:    { width: 820, height: 660 }
};

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

// --- data ---
ipcMain.handle('store-load', () => loadStore());
ipcMain.handle('store-save', (_e, data) => saveStore(data));

// --- window ---
ipcMain.on('set-view', (_e, mode) => {
  if (!mainWindow) return;
  const size = VIEW_SIZES[mode] || VIEW_SIZES.compact;
  mainWindow.setSize(size.width, size.height, true);
});
ipcMain.handle('toggle-always-on-top', () => {
  if (!mainWindow) return false;
  const isNowOnTop = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(isNowOnTop);
  return isNowOnTop;
});
ipcMain.handle('set-always-on-top', (_e, value) => {
  if (!mainWindow) return false;
  mainWindow.setAlwaysOnTop(!!value);
  return mainWindow.isAlwaysOnTop();
});
ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });

// --- Canvas ---

// Is a Canvas feed saved?
ipcMain.handle('canvas-status', () => {
  const secrets = loadSecrets();
  return { connected: !!secrets.canvasFeed };
});

// Turn a feed failure into a clear, specific message (never a generic one).
function canvasError(err) {
  if (err && err.status) return `HTTP ${err.status}${err.statusText ? ' ' + err.statusText : ''}`;
  if (err && err.code === 'ENETWORK') return err.message;
  return String((err && err.message) || err);
}

const CANVAS_HELP = 'Paste your Canvas Calendar Feed link (it ends in .ics)';

// Save (and test) a Canvas feed URL. We test-fetch before storing so typos are
// caught immediately.
ipcMain.handle('canvas-set-url', async (_e, url) => {
  // Trim whitespace and accept a copied "webcal://" link.
  const clean = String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
  // Must be an https iCalendar feed.
  if (!/^https:\/\//i.test(clean) || !/\.ics(\b|$)/i.test(clean)) {
    return { ok: false, error: CANVAS_HELP };
  }
  try {
    const text = await fetchText(clean);        // canvas.js (was undefined before)
    const items = normalizeCalendar(text);
    const secrets = loadSecrets();
    secrets.canvasFeed = encryptSecret(clean);
    saveSecrets(secrets);
    return { ok: true, count: items.length };
  } catch (err) {
    return { ok: false, error: canvasError(err) };
  }
});

// Fetch + parse the saved feed.
ipcMain.handle('canvas-sync', async () => {
  const secrets = loadSecrets();
  const url = decryptSecret(secrets.canvasFeed);
  if (!url) return { ok: false, error: 'Canvas is not connected' };
  try {
    const text = await fetchText(url);
    return { ok: true, items: normalizeCalendar(text) };
  } catch (err) {
    return { ok: false, error: canvasError(err) };
  }
});

// Forget the saved feed.
ipcMain.handle('canvas-disconnect', () => {
  const secrets = loadSecrets();
  delete secrets.canvasFeed;
  saveSecrets(secrets);
  return true;
});

// ---------------------------------------------------------------------------
// Gmail (read-only OAuth)
// ---------------------------------------------------------------------------

// We ONLY ask for read access. The app literally cannot send, delete, or edit.
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// Read the stored Google client + tokens out of the encrypted secrets file.
function getGmailSecrets() {
  const s = loadSecrets();
  return {
    clientId: decryptSecret(s.gmailClientId),
    clientSecret: decryptSecret(s.gmailClientSecret),
    tokens: s.gmailTokens ? JSON.parse(decryptSecret(s.gmailTokens) || 'null') : null,
    email: s.gmailEmail || null
  };
}

// Build an authorized OAuth2 client from stored tokens.
function buildGmailClient() {
  const { clientId, clientSecret, tokens } = getGmailSecrets();
  if (!clientId || !clientSecret || !tokens) return null;
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials(tokens);

  // When Google silently refreshes the access token, save the new one.
  oauth2.on('tokens', (fresh) => {
    const sec = loadSecrets();
    const merged = { ...tokens, ...fresh };
    sec.gmailTokens = encryptSecret(JSON.stringify(merged));
    saveSecrets(sec);
  });

  return oauth2;
}

// The OAuth "loopback" flow:
//   1. start a tiny web server on a random localhost port
//   2. open Google's consent page in your real browser
//   3. Google redirects back to localhost with a one-time code
//   4. swap that code for tokens, then shut the server down
// (Google forbids embedded webviews for sign-in, so we use your browser.)
function runGmailOAuth(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    let redirectUri = '';
    let oauth2Client = null;
    let settled = false;
    let timer = null;

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        if (reqUrl.pathname !== '/') { res.writeHead(404); res.end(); return; }

        const err = reqUrl.searchParams.get('error');
        const code = reqUrl.searchParams.get('code');

        if (err) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<h2>Sign-in failed</h2><p>${err}</p>`);
          finish(); reject(new Error(err)); return;
        }
        if (!code) { res.writeHead(400); res.end('Missing code'); return; }

        const { tokens } = await oauth2Client.getToken({ code, redirect_uri: redirectUri });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Google connected!</h2><p>You can close this tab and return to the widget.</p>');
        finish();
        resolve(tokens);
      } catch (e) {
        try { res.end('Error'); } catch {}
        finish(); reject(e);
      }
    });

    function finish() {
      if (settled) return;
      settled = true;
      try { server.close(); } catch {}
      if (timer) clearTimeout(timer);
    }

    // Give up after 5 minutes.
    timer = setTimeout(() => { finish(); reject(new Error('Timed out waiting for Google sign-in.')); }, 5 * 60 * 1000);

    server.on('error', (e) => { finish(); reject(e); });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}`;
      oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',   // so we get a refresh_token
        prompt: 'consent',        // force the consent screen (needed for refresh_token)
        scope: GMAIL_SCOPES
      });
      shell.openExternal(authUrl); // open in the default browser
    });
  });
}

// Is Gmail connected? (and which address)
ipcMain.handle('gmail-status', () => {
  const { tokens, email, clientId } = getGmailSecrets();
  return { connected: !!tokens, hasCreds: !!clientId, email };
});

// Save the Google Client ID + Secret (encrypted). Changing them clears old tokens.
ipcMain.handle('gmail-set-credentials', (_e, clientId, clientSecret) => {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!id || !secret) return { ok: false, error: 'Both Client ID and Client Secret are required.' };
  const s = loadSecrets();
  s.gmailClientId = encryptSecret(id);
  s.gmailClientSecret = encryptSecret(secret);
  delete s.gmailTokens;   // force a fresh sign-in with the new credentials
  delete s.gmailEmail;
  saveSecrets(s);
  return { ok: true };
});

// Start sign-in.
ipcMain.handle('gmail-connect', async () => {
  const { clientId, clientSecret } = getGmailSecrets();
  if (!clientId || !clientSecret) return { ok: false, error: 'Add your Google Client ID and Secret first.' };
  try {
    const tokens = await runGmailOAuth(clientId, clientSecret);
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress || null;

    const s = loadSecrets();
    s.gmailTokens = encryptSecret(JSON.stringify(tokens));
    s.gmailEmail = email;
    saveSecrets(s);
    return { ok: true, email };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Forget tokens (keeps the client credentials).
ipcMain.handle('gmail-disconnect', () => {
  const s = loadSecrets();
  delete s.gmailTokens;
  delete s.gmailEmail;
  saveSecrets(s);
  return true;
});

// Fetch messages matching the filters. Returns short email objects.
// `llm` = { enabled, model, cache } from the renderer. The API key is read here
// from encrypted secrets and never returned to the page.
ipcMain.handle('gmail-fetch', async (_e, filters = {}, cache = null, llmReq = null, mlReq = null) => {
  const oauth2 = buildGmailClient();
  if (!oauth2) return { ok: false, error: 'Gmail is not connected' };
  try {
    // The renderer keeps the cache (settings.processedMessageIds) and sends it
    // back each time, so only new messages are fetched in full.
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });

    const apiKey = decryptSecret(loadSecrets().geminiApiKey);
    const ai = {
      enabled: !!(llmReq && llmReq.enabled) && !!apiKey,
      model: (llmReq && llmReq.model) || llm.DEFAULT_MODEL,
      apiKey,
      cache: (llmReq && llmReq.cache) || {},
      callModel: llm.callModel
    };

    // The learned filter runs in THIS process. The renderer only says whether it
    // is on; the examples and the model itself never leave the main process.
    const ml = (mlReq && mlReq.enabled)
      ? { enabled: true, score: (texts) => mlModel.scoreTexts(texts) }
      : null;

    const res = await fetchPreview(gmail, filters, cache, ai, ml);
    logExcluded(res.excluded);
    return {
      ok: true, emails: res.emails, query: res.query, preview: res.preview,
      cache: res.cache, stats: res.stats,
      llmCache: res.llmCache, aiStats: res.aiStats,
      aiEnabled: ai.enabled, aiHasKey: !!apiKey,
      mlStats: res.mlStats
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Append each keyword-excluded email (subject + sender only, never the body)
// to data/excluded-emails.log, one JSON line each, so false positives can be
// reviewed and the keyword list tuned in Settings.
function logExcluded(list) {
  if (!Array.isArray(list) || !list.length) return;
  const at = new Date().toISOString();
  const lines = list.map((x) => JSON.stringify({ at, keyword: x.keyword, sender: x.sender, subject: x.subject }));
  try {
    ensureDataDir();
    fs.appendFileSync(EXCLUDED_LOG, lines.join('
') + '
', 'utf8');
  } catch (err) {
    console.log('[gmail] could not write excluded log:', err.message);
  }
  for (const x of list) console.log(`[gmail] excluded (${x.keyword}): "${x.subject}" from ${x.sender}`);
}

// ---------------------------------------------------------------------------
// Learned relevance filter (on-device). The renderer owns the labelled examples
// (store.mlExamples, saved by the renderer via store-save); this process owns the
// vectors, the classifier and the cached embedding model.
// ---------------------------------------------------------------------------
ipcMain.handle('ml-status', () => mlModel.status());

// Called after a label is added. Trains only when it is worth it (cold start
// passed, both classes present, and enough new examples) unless force is true.
ipcMain.handle('ml-train', (_e, examples, force) => mlModel.train(examples || [], { force: !!force }));

ipcMain.handle('ml-reset', () => mlModel.reset());

// ---------------------------------------------------------------------------
// Optional AI sorting (Gemini). Key is encrypted with safeStorage and stays in
// the main process; the renderer only ever learns whether a key exists.
// ---------------------------------------------------------------------------
ipcMain.handle('llm-status', () => {
  const s = loadSecrets();
  return { hasKey: !!decryptSecret(s.geminiApiKey), defaultModel: llm.DEFAULT_MODEL };
});

ipcMain.handle('llm-set-key', (_e, apiKey) => {
  const key = String(apiKey || '').trim();
  const s = loadSecrets();
  if (!key) { delete s.geminiApiKey; saveSecrets(s); return { ok: true, cleared: true }; }
  s.geminiApiKey = encryptSecret(key);
  saveSecrets(s);
  return { ok: true };
});

// Test the AI on ONE saved sample email. `messageId` is optional; if given we
// re-fetch that message's body, otherwise we fall back to a cached sample text.
ipcMain.handle('llm-test', async (_e, messageId, model) => {
  const apiKey = decryptSecret(loadSecrets().geminiApiKey);
  if (!apiKey) return { ok: false, error: 'Add your Gemini API key first.' };
  const useModel = model || llm.DEFAULT_MODEL;

  try {
    let text = '';
    let subject = '';
    let receivedDate = '';
    let urls = [];

    const oauth2 = buildGmailClient();
    if (messageId && oauth2) {
      const gmail = google.gmail({ version: 'v1', auth: oauth2 });
      const data = (await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })).data;
      const headers = {};
      for (const h of ((data.payload && data.payload.headers) || [])) headers[String(h.name).toLowerCase()] = h.value;
      subject = headers.subject || '';
      receivedDate = headers.date || '';
      text = extractBodyText(data.payload).slice(0, 30000);
      const { extractUrls } = require('./titles');
      urls = extractUrls(text, 8);
    }

    if (!text) {
      // Fall back to a cached sample (no Gmail call needed).
      const store = loadStore();
      const cache = store.llmCache || {};
      const entry = Object.values(cache).sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
      if (entry && entry.text) { text = entry.text; subject = '(cached sample)'; }
    }
    if (!text) return { ok: false, error: 'No sample email available. Connect Gmail and sync first.' };

    const clean = llm.cleanForAI(text, urls);
    const today = new Date().toISOString().slice(0, 10);
    const prompt = llm.buildPrompt({ text: clean, subject, receivedDate, today });
    const raw = await llm.callModel({ prompt, model: useModel, apiKey });
    const validated = llm.validateResult(raw, { text: clean, now: new Date(), allowedUrls: urls });
    // Log counts only — never the key or the email text.
    console.log(`[llm] test: model=${useModel} events=${validated.events.length} links=${validated.links.length} dropped=${validated.dropped}`);
    return { ok: true, model: useModel, raw: String(raw || '').slice(0, 4000), validated };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------------------------------------------------------------------
// One-time cleanup review for OLD Gmail events already in store.json.
// The renderer sends its stored gmail events + the current filters; we re-run
// the new rules and report which ones would be dismissed (count + list) so the
// user can review BEFORE anything is applied.
// ---------------------------------------------------------------------------
ipcMain.handle('gmail-cleanup-preview', (_e, events, filters = {}) => {
  const items = [];
  for (const ev of (events || [])) {
    if (ev.source !== 'gmail') continue;
    if (ev.status === 'dismissed') continue;

    const reasons = [];

    // c) allowlist: only trusted senders may stay on the calendar
    const sender = ev.sender || ev.course || '';
    if (!isTrusted(sender, filters.trustedSenders)) reasons.push('sender not trusted');

    // b) junk titles
    if (isJunkTitle(ev.title || '')) reasons.push('junk title');

    // f) date window: -7 days .. +90 days
    const t = ev.start ? new Date(ev.start + 'T' + (ev.time || '00:00')).getTime() : NaN;
    const now = Date.now();
    if (isNaN(t) || t < now - 7 * 86400000 || t > now + 90 * 86400000) {
      reasons.push('date outside 90-day window');
    }

    if (reasons.length) {
      items.push({ id: ev.id, title: ev.title, start: ev.start, reason: reasons.join('; ') });
    }
  }
  return { ok: true, items, count: items.length };
});

// Open an http(s) link in the default browser (used for "open email in Gmail"
// and for Links items). Anything that is not http/https is refused.
ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) {
    shell.openExternal(url.trim());
    return true;
  }
  return false;
});

// Write the whole store (events, todos, links, overrides, settings) to a JSON
// file the user picks. This is the backup/export, and links ride along in it.
ipcMain.handle('export-store', async () => {
  if (!mainWindow) return { ok: false, error: 'No window' };
  const data = loadStore();
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export schedule data',
    defaultPath: `schedule-backup-${stamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false, error: 'cancelled' };
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, filePath, events: data.events.length, todos: data.todos.length, links: data.links.length };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------------------------------------------------------------------
// Discord (read a server channel using a bot token)
// ---------------------------------------------------------------------------

// Small helper for the Discord REST API with helpful error messages.
async function discordGet(apiPath, token) {
  const res = await fetch('https://discord.com/api/v10' + apiPath, {
    headers: { Authorization: 'Bot ' + token }
  });
  if (res.status === 401) throw new Error('Invalid bot token (401). Copy a fresh token.');
  if (res.status === 403) throw new Error('Bot lacks access (403). Invite the bot to the server and allow "Read Message History".');
  if (res.status === 404) throw new Error('Channel not found (404). Double-check the channel ID.');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

ipcMain.handle('discord-status', () => {
  const s = loadSecrets();
  return { connected: !!s.discordToken, channelName: s.discordChannelName || null };
});

// Save + test the bot token and channel id. The token is encrypted.
ipcMain.handle('discord-set-config', async (_e, token, channelId) => {
  const tok = String(token || '').trim();
  const ch = String(channelId || '').trim();
  if (!tok || !ch) return { ok: false, error: 'Bot token and channel ID are both required.' };
  try {
    const info = await discordGet(`/channels/${ch}`, tok);   // test call
    const secrets = loadSecrets();
    secrets.discordToken = encryptSecret(tok);
    secrets.discordChannelId = encryptSecret(ch);
    secrets.discordChannelName = info.name || ch;
    saveSecrets(secrets);
    return { ok: true, channelName: info.name || ch };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Read the most recent messages from the channel.
ipcMain.handle('discord-fetch', async (_e, limit) => {
  const s = loadSecrets();
  const token = decryptSecret(s.discordToken);
  const channelId = decryptSecret(s.discordChannelId);
  const channelName = s.discordChannelName || '';
  if (!token || !channelId) return { ok: false, error: 'Discord is not connected' };
  try {
    const n = Math.min(50, Math.max(1, Number(limit) || 25));
    const raw = await discordGet(`/channels/${channelId}/messages?limit=${n}`, token);
    const messages = raw
      .map((m) => normalizeDiscordMessage(m, channelName))
      .filter((m) => m.content);
    return { ok: true, messages, channelName, emptyCount: raw.length - messages.length };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('discord-disconnect', () => {
  const s = loadSecrets();
  delete s.discordToken;
  delete s.discordChannelId;
  delete s.discordChannelName;
  saveSecrets(s);
  return true;
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
