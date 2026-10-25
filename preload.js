// preload.js
// ---------------------------------------------------------------------------
// The SECURE BRIDGE between the page and the main process.
// We expose ONLY a small, safe set of functions as window.widgetAPI.
// Notice: the raw Canvas URL is never exposed — the page only sends it once to
// be stored, and receives back sync results. Secrets stay in the main process.
// ---------------------------------------------------------------------------

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  // data storage
  loadStore: () => ipcRenderer.invoke('store-load'),
  saveStore: (data) => ipcRenderer.invoke('store-save', data),
  exportStore: () => ipcRenderer.invoke('export-store'),

  // window behaviour
  setView: (mode) => ipcRenderer.send('set-view', mode),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('set-always-on-top', value),
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),

  // Canvas
  canvasStatus: () => ipcRenderer.invoke('canvas-status'),
  canvasSetUrl: (url) => ipcRenderer.invoke('canvas-set-url', url),
  canvasSync: () => ipcRenderer.invoke('canvas-sync'),
  canvasDisconnect: () => ipcRenderer.invoke('canvas-disconnect'),

  // Gmail
  gmailStatus: () => ipcRenderer.invoke('gmail-status'),
  gmailSetCredentials: (clientId, clientSecret) => ipcRenderer.invoke('gmail-set-credentials', clientId, clientSecret),
  gmailConnect: () => ipcRenderer.invoke('gmail-connect'),
  gmailDisconnect: () => ipcRenderer.invoke('gmail-disconnect'),
  gmailFetch: (filters, cache, llm, ml) => ipcRenderer.invoke('gmail-fetch', filters, cache, llm, ml),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Optional AI sorting (Gemini). The key is set but never read back.
  llmStatus: () => ipcRenderer.invoke('llm-status'),
  llmSetKey: (apiKey) => ipcRenderer.invoke('llm-set-key', apiKey),
  llmTest: (messageId, model) => ipcRenderer.invoke('llm-test', messageId, model),

  // Learned relevance filter (on-device). You label examples via the UI; the
  // vectors, classifier and model all stay in the main process.
  mlStatus: () => ipcRenderer.invoke('ml-status'),
  mlTrain: (examples, force) => ipcRenderer.invoke('ml-train', examples, !!force),
  mlReset: () => ipcRenderer.invoke('ml-reset'),

  // Discord
  discordStatus: () => ipcRenderer.invoke('discord-status'),
  discordSetConfig: (token, channelId) => ipcRenderer.invoke('discord-set-config', token, channelId),
  discordFetch: (limit) => ipcRenderer.invoke('discord-fetch', limit),
  discordDisconnect: () => ipcRenderer.invoke('discord-disconnect'),

  // Agent team. State only — no keys, no App IDs.
  teamState: () => ipcRenderer.invoke('team-state'),
  teamRun: () => ipcRenderer.invoke('team-run'),
  onTeamUpdate: (fn) => {
    const handler = (_e, state) => fn(state);
    ipcRenderer.on('team-update', handler);
    return () => ipcRenderer.removeListener('team-update', handler);
  }
});
