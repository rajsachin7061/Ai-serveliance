const { app, BrowserWindow, dialog, ipcMain, safeStorage, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { discoverOnvif, stopDiscovery, getOnvifProfiles, isPrivateIpv4 } = require('./camera-discovery.cjs');
const {
  cameraErrorDetails,
  classifyCaptureFailure,
  evaluateVideoHealth,
  probeRtspPort,
  validateRtspEndpoint,
} = require('./camera-compatibility.cjs');

const DEFAULT_SETTINGS = {
  shopName: 'My Shop',
  queueThreshold: 12,
  alertDurationSeconds: 120,
  openingTime: '09:00',
  closingTime: '21:00',
  alertsEnabled: true,
  soundEnabled: false,
  emailNotifications: false,
  retentionDays: 30,
  maxConcurrentCameras: 4,
  cameraReconnectAttempts: 0,
  autoReconnectCameras: true,
  queueZone: { x: 0.2, y: 0.6, width: 0.6, height: 0.35 },
  detectionConfidence: 0.35,
  countingLine: { x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.8, positiveIsEntry: true },
  restrictedZones: [],
  loiteringZones: [],
  crowdZones: [],
  cameras: [
    {
      id: 'demo-camera-01',
      name: 'Front Entrance',
      location: 'Main entrance',
      sourceType: 'Demo feed',
      status: 'Demo mode',
    },
  ],
};

let settingsFile;
let mainWindow;
let workerProcess;
let workerDesired = false;
let workerReady = false;
let workerBusy = false;
let workerStartPromise;
let workerRetryTimer;
let workerFrameTimer;
let workerRestartCount = 0;
let workerOutputBuffer = '';
let cameraSecretsFile;
const cameraSources = new Map();
const cameraStatusRegistry = new Map();
const usbCameraReservations = new Set();
const usbCameraDiagnostics = new Map();

function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid settings payload');
  const clampNumber = (value, min, max, fallback) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : fallback;
  };
  const safeString = (value, fallback, maxLength = 80) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
  const safeTime = (value, fallback) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? value : fallback;
  const defaultZone = DEFAULT_SETTINGS.queueZone;
  const zoneInput = input.queueZone && typeof input.queueZone === 'object' ? input.queueZone : defaultZone;
  const zoneX = clampNumber(Number(zoneInput.x) * 100, 0, 100, defaultZone.x * 100) / 100;
  const zoneY = clampNumber(Number(zoneInput.y) * 100, 0, 100, defaultZone.y * 100) / 100;
  const zoneWidth = clampNumber(Number(zoneInput.width) * 100, 1, 100, defaultZone.width * 100) / 100;
  const zoneHeight = clampNumber(Number(zoneInput.height) * 100, 1, 100, defaultZone.height * 100) / 100;
  const queueZone = {
    x: Math.min(zoneX, 1 - zoneWidth),
    y: Math.min(zoneY, 1 - zoneHeight),
    width: zoneWidth,
    height: zoneHeight,
  };
  const normalizeZones = (zones, key) => Array.isArray(zones) ? zones.slice(0, 12).map((zone, index) => {
    const x = clampNumber(Number(zone?.x) * 100, 0, 100, 20) / 100;
    const y = clampNumber(Number(zone?.y) * 100, 0, 100, 20) / 100;
    const width = Math.min(clampNumber(Number(zone?.width) * 100, 1, 100, 30) / 100, 1 - x);
    const height = Math.min(clampNumber(Number(zone?.height) * 100, 1, 100, 30) / 100, 1 - y);
    return {
      id: safeString(zone?.id, `${key}-${index + 1}`, 60),
      name: safeString(zone?.name, `${key === 'restricted' ? 'Restricted' : key === 'loitering' ? 'Loitering' : 'Crowd'} zone ${index + 1}`, 60),
      x, y, width, height,
      thresholdSeconds: clampNumber(zone?.thresholdSeconds, 5, 3600, 60),
      maxOccupancy: clampNumber(zone?.maxOccupancy, 1, 10000, 10),
    };
  }) : [];
  const lineInput = input.countingLine && typeof input.countingLine === 'object' ? input.countingLine : DEFAULT_SETTINGS.countingLine;
  const countingLine = {
    x1: clampNumber(Number(lineInput.x1) * 100, 0, 100, 50) / 100,
    y1: clampNumber(Number(lineInput.y1) * 100, 0, 100, 20) / 100,
    x2: clampNumber(Number(lineInput.x2) * 100, 0, 100, 50) / 100,
    y2: clampNumber(Number(lineInput.y2) * 100, 0, 100, 80) / 100,
    positiveIsEntry: lineInput.positiveIsEntry !== false,
  };
  if (Math.hypot(countingLine.x2 - countingLine.x1, countingLine.y2 - countingLine.y1) < 0.05) {
    Object.assign(countingLine, DEFAULT_SETTINGS.countingLine);
  }
  const cameraInputs = Array.isArray(input.cameras) ? input.cameras.slice(0, 64).map((camera, index) => {
    let rtspUrl = '';
    let ipAddress = '';
    if (typeof camera?.ipAddress === 'string' && camera.ipAddress.trim()) {
      if (!isPrivateIpv4(camera.ipAddress.trim())) throw new Error('Camera IP addresses must be private local IPv4 addresses.');
      ipAddress = camera.ipAddress.trim();
    }
    if (typeof camera?.rtspUrl === 'string' && camera.rtspUrl.trim()) {
      const parsed = validateRtspEndpoint(camera.rtspUrl, isPrivateIpv4);
      if (ipAddress && ipAddress !== parsed.hostname) {
        throw new Error('RTSP must use a private local IPv4 address without embedded credentials.');
      }
      rtspUrl = parsed.href;
      ipAddress = parsed.hostname;
    }
    return {
      id: safeString(camera?.id, `camera-${index + 1}`, 60),
      name: safeString(camera?.name, `Camera ${index + 1}`, 60),
      location: safeString(camera?.location, 'Not specified', 80),
      sourceType: ['RTSP camera', 'USB webcam', 'HDMI capture card'].includes(camera?.sourceType) ? camera.sourceType : 'Demo feed',
      status: safeString(camera?.status, camera?.sourceType === 'Demo feed' ? 'Demo mode' : 'Discovered', 40),
      deviceId: typeof camera?.deviceId === 'string' ? camera.deviceId.slice(0, 256) : '',
      ipAddress,
      manufacturer: safeString(camera?.manufacturer, '', 80),
      model: safeString(camera?.model, '', 80),
      rtspUrl,
      rtspTransport: camera?.rtspTransport === 'udp' ? 'udp' : 'tcp',
      processingFps: clampNumber(camera?.processingFps, 1, 30, 3),
      authenticationStatus: ['Required', 'Configured', 'Not required', 'Unknown'].includes(camera?.authenticationStatus)
        ? camera.authenticationStatus : 'Unknown',
      configuration: camera?.configuration && typeof camera.configuration === 'object'
        ? camera.configuration : null,
    };
  }) : DEFAULT_SETTINGS.cameras;
  const normalizeQueueZone = value => {
    const zone = value && typeof value === 'object' ? value : defaultZone;
    const x = clampNumber(Number(zone.x) * 100, 0, 100, defaultZone.x * 100) / 100;
    const y = clampNumber(Number(zone.y) * 100, 0, 100, defaultZone.y * 100) / 100;
    const width = clampNumber(Number(zone.width) * 100, 1, 100, defaultZone.width * 100) / 100;
    const height = clampNumber(Number(zone.height) * 100, 1, 100, defaultZone.height * 100) / 100;
    return { x: Math.min(x, 1 - width), y: Math.min(y, 1 - height), width, height };
  };
  const normalizeLine = value => {
    const line = value && typeof value === 'object' ? value : DEFAULT_SETTINGS.countingLine;
    const result = {
      x1: clampNumber(Number(line.x1) * 100, 0, 100, 50) / 100,
      y1: clampNumber(Number(line.y1) * 100, 0, 100, 20) / 100,
      x2: clampNumber(Number(line.x2) * 100, 0, 100, 50) / 100,
      y2: clampNumber(Number(line.y2) * 100, 0, 100, 80) / 100,
      positiveIsEntry: line.positiveIsEntry !== false,
    };
    if (Math.hypot(result.x2 - result.x1, result.y2 - result.y1) < 0.05) {
      return { ...DEFAULT_SETTINGS.countingLine };
    }
    return result;
  };
  const globalConfiguration = {
    queueZone,
    detectionConfidence: clampNumber(Number(input.detectionConfidence) * 100, 10, 95, 35) / 100,
    countingLine,
    restrictedZones: normalizeZones(input.restrictedZones, 'restricted'),
    loiteringZones: normalizeZones(input.loiteringZones, 'loitering'),
    crowdZones: normalizeZones(input.crowdZones, 'crowd'),
  };
  const cameras = cameraInputs.map(camera => {
    const source = camera.configuration || globalConfiguration;
    return {
      ...camera,
      configuration: {
        queueZone: normalizeQueueZone(source.queueZone),
        detectionConfidence: clampNumber(Number(source.detectionConfidence) * 100, 10, 95, 35) / 100,
        countingLine: normalizeLine(source.countingLine),
        restrictedZones: normalizeZones(source.restrictedZones, 'restricted'),
        loiteringZones: normalizeZones(source.loiteringZones, 'loitering'),
        crowdZones: normalizeZones(source.crowdZones, 'crowd'),
      },
    };
  });
  const cameraIds = new Set();
  const deviceIds = new Set();
  const streamUrls = new Set();
  for (const camera of cameras) {
    if (cameraIds.has(camera.id)) throw new Error('Camera IDs must be unique.');
    cameraIds.add(camera.id);
    if (camera.deviceId && deviceIds.has(camera.deviceId)) throw new Error('A Windows video device is already assigned to another camera profile.');
    if (camera.rtspUrl && streamUrls.has(camera.rtspUrl)) throw new Error('This RTSP stream is already assigned to another camera profile.');
    if (camera.deviceId) deviceIds.add(camera.deviceId);
    if (camera.rtspUrl) streamUrls.add(camera.rtspUrl);
  }
  return {
    shopName: safeString(input.shopName, DEFAULT_SETTINGS.shopName, 80),
    queueThreshold: clampNumber(input.queueThreshold, 1, 200, DEFAULT_SETTINGS.queueThreshold),
    alertDurationSeconds: clampNumber(input.alertDurationSeconds, 10, 3600, DEFAULT_SETTINGS.alertDurationSeconds),
    openingTime: safeTime(input.openingTime, DEFAULT_SETTINGS.openingTime),
    closingTime: safeTime(input.closingTime, DEFAULT_SETTINGS.closingTime),
    alertsEnabled: Boolean(input.alertsEnabled),
    soundEnabled: Boolean(input.soundEnabled),
    emailNotifications: Boolean(input.emailNotifications),
    retentionDays: [7, 14, 30, 60, 90].includes(Number(input.retentionDays)) ? Number(input.retentionDays) : 30,
    maxConcurrentCameras: clampNumber(input.maxConcurrentCameras, 1, 16, DEFAULT_SETTINGS.maxConcurrentCameras),
    cameraReconnectAttempts: clampNumber(input.cameraReconnectAttempts, 0, 30, DEFAULT_SETTINGS.cameraReconnectAttempts),
    autoReconnectCameras: input.autoReconnectCameras !== false,
    queueZone,
    detectionConfidence: clampNumber(Number(input.detectionConfidence) * 100, 10, 95, 35) / 100,
    countingLine,
    restrictedZones: normalizeZones(input.restrictedZones, 'restricted'),
    loiteringZones: normalizeZones(input.loiteringZones, 'loitering'),
    crowdZones: normalizeZones(input.crowdZones, 'crowd'),
    cameras,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function createReportHtml(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid report data.');
  const text = (value, limit = 200) => typeof value === 'string' ? value.slice(0, limit) : '';
  const count = value => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error('Report metrics must be valid numbers.');
    return numeric;
  };
  const cameras = Array.isArray(input.cameras) ? input.cameras.slice(0, 64) : [];
  const alerts = Array.isArray(input.alerts) ? input.alerts.slice(0, 500) : [];
  const trafficRows = Array.isArray(input.trafficRows) ? input.trafficRows.slice(0, 120) : [];
  const cameraRows = cameras.map(camera => `<tr><td>${escapeHtml(text(camera.name, 80))}</td><td>${escapeHtml(text(camera.sourceType, 40))}</td><td>${escapeHtml(text(camera.location, 80))}</td><td>${escapeHtml(text(camera.status, 40))}</td></tr>`).join('');
  const trafficTable = trafficRows.length
    ? `<table><thead><tr><th>Time</th><th>Footfall</th><th>Entries</th><th>Exits</th></tr></thead><tbody>${trafficRows.map(row => `<tr><td>${escapeHtml(text(row.time, 80))}</td><td>${count(row.footfall)}</td><td>${count(row.entries)}</td><td>${count(row.exits)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="empty">No visitor events were recorded during this period.</p>';
  const alertTable = alerts.length
    ? `<table><thead><tr><th>Time</th><th>Alert</th><th>Severity</th><th>Camera</th><th>Details</th></tr></thead><tbody>${alerts.map(alert => `<tr><td>${escapeHtml(text(alert.time, 80))}</td><td>${escapeHtml(text(alert.title, 120))}</td><td>${escapeHtml(text(alert.severity, 20))}</td><td>${escapeHtml(text(alert.camera, 80))}</td><td>${escapeHtml(text(alert.detail, 300))}</td></tr>`).join('')}</tbody></table>`
    : '<p class="empty">No alerts were recorded during this period.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(text(input.title, 100))}</title>
    <style>
      *{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#182235;font:14px/1.5 "Segoe UI",Arial,sans-serif}
      main{max-width:900px;margin:32px auto;padding:42px;background:#fff;box-shadow:0 12px 40px #17243a1c}
      header{border-bottom:2px solid #4779e0;padding-bottom:22px;margin-bottom:26px}
      .eyebrow{font-size:10px;font-weight:700;letter-spacing:1.5px;color:#5778b6}
      h1{font-size:28px;line-height:1.2;margin:8px 0}.date{color:#69758a}
      h2{font-size:15px;margin:28px 0 10px}
      .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
      .metric{border:1px solid #e6eaf0;border-radius:8px;padding:13px}.metric span{display:block;color:#69758a;font-size:11px}.metric strong{display:block;font-size:24px;margin-top:3px}
      table{width:100%;border-collapse:collapse;font-size:11px}th{text-align:left;color:#53617a;background:#f3f6fa}th,td{padding:9px 8px;border-bottom:1px solid #e9edf3;vertical-align:top}
      .empty{color:#69758a;padding:14px 0}.footer{margin-top:32px;border-top:1px solid #e9edf3;padding-top:12px;color:#7e899b;font-size:10px}
      @page{size:A4;margin:16mm}
      @media print{body{background:#fff;font-size:11px}main{max-width:none;margin:0;padding:0;box-shadow:none}header{break-after:avoid}.metric{break-inside:avoid}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}th,td{padding:6px}}
    </style></head><body><main>
      <header><div class="eyebrow">QUEUEPULSE AI · ANALYTICS</div><h1>${escapeHtml(text(input.title || 'QueuePulse AI Traffic Report', 100))}</h1><div class="date">${escapeHtml(text(input.dateRange, 120))}</div></header>
      <section><h2>Traffic summary</h2><div class="metrics">
        <div class="metric"><span>Footfall</span><strong>${count(input.footfall)}</strong></div>
        <div class="metric"><span>Entries</span><strong>${count(input.entries)}</strong></div>
        <div class="metric"><span>Exits</span><strong>${count(input.exits)}</strong></div>
        <div class="metric"><span>Current occupancy</span><strong>${count(input.occupancy)}</strong></div>
      </div></section>
      <section><h2>Camera information</h2>${cameraRows ? `<table><thead><tr><th>Name</th><th>Source</th><th>Location</th><th>Status</th></tr></thead><tbody>${cameraRows}</tbody></table>` : '<p class="empty">No cameras are configured.</p>'}</section>
      <section><h2>Footfall by time</h2>${trafficTable}</section>
      <section><h2>Alerts</h2>${alertTable}</section>
      <div class="footer">Generated locally by QueuePulse AI · ${escapeHtml(new Date().toLocaleString())}</div>
    </main></body></html>`;
}

async function readSettings() {
  try {
    const raw = await fs.readFile(settingsFile, 'utf8');
    return validateSettings(JSON.parse(raw));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Could not read saved QueuePulse settings: ${error.message}`);
    }
    return writeSettings(DEFAULT_SETTINGS);
  }
}

async function writeSettings(settings) {
  const safe = validateSettings(settings);
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify(safe, null, 2), { encoding: 'utf8', mode: 0o600 });
  return safe;
}

async function loadCameraSecrets() {
  let encrypted;
  try {
    encrypted = await fs.readFile(cameraSecretsFile);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this Windows account.');
  }
  const secrets = JSON.parse(safeStorage.decryptString(encrypted));
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
    throw new Error('The saved camera credential store is invalid.');
  }
  return secrets;
}

async function saveCameraCredentials(cameraId, username, password) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this Windows account.');
  }
  if (typeof cameraId !== 'string' || !/^[\w.-]{1,60}$/.test(cameraId)
    || typeof username !== 'string' || username.length > 128
    || typeof password !== 'string' || password.length > 256) {
    throw new Error('Invalid camera credentials.');
  }
  const secrets = await loadCameraSecrets();
  secrets[cameraId] = { username, password };
  await fs.mkdir(path.dirname(cameraSecretsFile), { recursive: true });
  await fs.writeFile(cameraSecretsFile, safeStorage.encryptString(JSON.stringify(secrets)), { mode: 0o600 });
}

async function clearCameraCredentials(cameraId) {
  const secrets = await loadCameraSecrets();
  if (!Object.hasOwn(secrets, cameraId)) return;
  delete secrets[cameraId];
  if (Object.keys(secrets).length === 0) {
    await fs.rm(cameraSecretsFile, { force: true });
    return;
  }
  await fs.writeFile(cameraSecretsFile, safeStorage.encryptString(JSON.stringify(secrets)), { mode: 0o600 });
}

function validateRtspUrl(value, expectedIp = '') {
  const url = validateRtspEndpoint(value, isPrivateIpv4);
  if (expectedIp && url.hostname !== expectedIp) {
    throw new Error('RTSP must use a private local IPv4 address and must not contain embedded credentials.');
  }
  return url;
}

function sendCameraStatus(id, status, detail = '', category = '') {
  cameraStatusRegistry.set(id, { status, detail, category, updatedAt: Date.now() });
  const source = cameraSources.get(id);
  if (source) {
    source.status = status;
    source.detail = detail;
    if (category || status === 'connected' || status === 'disconnected') {
      source.errorCategory = category;
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('camera:status', {
      status, detail, category, id, diagnostics: source?.diagnostics || null,
    });
  }
}

async function startCameraSource(cameraId, rtspUrl, username, password, maximum, streamSettings = {}) {
  const options = {
    transport: streamSettings.transport === 'udp' ? 'udp' : 'tcp',
    processingFps: Math.max(1, Math.min(30, Math.round(Number(streamSettings.processingFps) || 3))),
    maxReconnectAttempts: Math.max(0, Math.min(30, Math.round(Number(streamSettings.maxReconnectAttempts) || 0))),
    restartAttempts: Math.max(0, Math.min(30, Math.round(Number(streamSettings.restartAttempts) || 0))),
  };
  const existing = cameraSources.get(cameraId);
  if (existing?.desired && existing.url === rtspUrl
    && existing.username === username && existing.password === password
    && existing.options.transport === options.transport
    && existing.options.processingFps === options.processingFps
    && existing.options.maxReconnectAttempts === options.maxReconnectAttempts) {
    return { connected: existing.status === 'connected', status: existing.status };
  }
  const duplicate = [...cameraSources.entries()].find(([id, source]) =>
    id !== cameraId && source.desired && source.url === rtspUrl);
  if (duplicate) {
    throw new Error(`This RTSP stream is already connected as camera "${duplicate[0]}".`);
  }
  const activeCount = [...cameraSources.values()].filter(source => source.desired).length
    + usbCameraReservations.size - (existing?.desired ? 1 : 0);
  if (activeCount >= maximum) {
    throw new Error(`Camera connection limit reached (${maximum}). Disconnect a camera or increase the limit in Settings.`);
  }
  if (existing) await stopCameraSource(cameraId);
  const { cameraSourceFile } = getWorkerPaths();
  const python = pythonCommand();
  const child = spawn(python.command, [...python.prefix, cameraSourceFile], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const source = {
    child,
    desired: true,
    status: 'connecting',
    detail: 'Connecting to the RTSP camera…',
    buffer: '',
    stderrBuffer: '',
    lastFrameAt: 0,
    lastFrameSentAt: 0,
    diagnostics: null,
    url: rtspUrl,
    username,
    password,
    options,
    maximum,
    restartAttempts: options.restartAttempts,
    errorCategory: '',
    healthTimer: null,
    restartTimer: null,
    restartScheduled: false,
    startedAt: Date.now(),
  };
  cameraSources.set(cameraId, source);
  sendCameraStatus(cameraId, 'connecting', source.detail);
  source.healthTimer = setInterval(() => {
    if (cameraSources.get(cameraId) !== source || source.status !== 'connected') return;
    if (Date.now() - source.lastFrameAt > 12000) {
      const issue = cameraErrorDetails(source.errorCategory || 'no_frames');
      sendCameraStatus(cameraId, 'reconnecting', issue.message, source.errorCategory || 'no_frames');
    }
  }, 5000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    if (cameraSources.get(cameraId) !== source) return;
    source.stderrBuffer = `${source.stderrBuffer}${chunk}`.slice(-8192);
    const category = classifyCaptureFailure(source.stderrBuffer);
    if (category) {
      const issue = cameraErrorDetails(category);
      sendCameraStatus(cameraId, 'error', issue.message, category);
    }
  });
  child.stdin.on('error', () => {
    if (cameraSources.get(cameraId) !== source) return;
    sendCameraStatus(cameraId, 'error', 'Could not provide the RTSP source to the capture worker.', 'worker_disconnected');
    child.kill();
  });
  child.stdout.on('data', chunk => {
    if (cameraSources.get(cameraId) !== source) return;
    source.buffer += chunk;
    if (source.buffer.length > 1_000_000) {
      source.buffer = '';
      sendCameraStatus(cameraId, 'error', 'The camera returned an oversized frame.');
      child.kill();
      return;
    }
    let newline;
    while ((newline = source.buffer.indexOf('\n')) !== -1) {
      const line = source.buffer.slice(0, newline);
      source.buffer = source.buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === 'frame' && typeof message.image === 'string' && message.image.length <= 700000) {
          const now = Date.now();
          source.lastFrameAt = now;
          if (now - source.startedAt >= 60000) source.restartAttempts = 0;
          source.errorCategory = '';
          source.diagnostics = {
            width: Number.isInteger(message.width) && message.width > 0 ? message.width : null,
            height: Number.isInteger(message.height) && message.height > 0 ? message.height : null,
            fps: Number.isFinite(message.fps) && message.fps >= 0 ? message.fps : null,
            codec: typeof message.codec === 'string' ? message.codec.slice(0, 20) : 'Unknown',
            brightness: Number.isFinite(message.brightness) ? message.brightness : null,
          };
          if (source.status !== 'connected') {
            const authentication = source.username ? 'Camera credentials were accepted.' : 'RTSP stream is receiving video.';
            sendCameraStatus(cameraId, 'connected', authentication);
          }
          if (now - source.lastFrameSentAt < 350) continue;
          source.lastFrameSentAt = now;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('camera:frame', {
              id: cameraId, image: message.image, diagnostics: source.diagnostics,
              lastFrameAt: new Date(now).toISOString(),
            });
          }
        } else if (message.type === 'reconnecting' || message.type === 'connecting') {
          const category = source.errorCategory || (typeof message.category === 'string' ? message.category : '');
          sendCameraStatus(cameraId, 'reconnecting',
            category ? cameraErrorDetails(category).message
              : message.message || 'Connecting to the RTSP camera…',
            category);
        } else if (message.type === 'error') {
          const category = typeof message.category === 'string' ? message.category : 'no_frames';
          const issue = cameraErrorDetails(category);
          sendCameraStatus(cameraId, 'error', issue.message, category);
        }
      } catch {
        sendCameraStatus(cameraId, 'error', 'The camera source returned an invalid frame.');
      }
    }
  });
  child.on('error', () => {
    if (cameraSources.get(cameraId) !== source) return;
    scheduleCameraSourceRecovery(cameraId, source);
  });
  child.on('exit', () => {
    if (cameraSources.get(cameraId) !== source) return;
    clearInterval(source.healthTimer);
    if (source.desired && source.errorCategory !== 'no_frames') {
      scheduleCameraSourceRecovery(cameraId, source);
      return;
    }
    cameraSources.delete(cameraId);
    if (source.desired) source.desired = false;
    sendCameraStatus(cameraId, source.errorCategory === 'no_frames' ? 'error' : 'disconnected',
      source.detail || (source.errorCategory === 'no_frames'
        ? cameraErrorDetails('no_frames').message : 'RTSP camera disconnected.'),
      source.errorCategory || '');
  });
  child.stdin.end(`${JSON.stringify({
    url: rtspUrl,
    username,
    password,
    transport: options.transport,
    processingFps: options.processingFps,
    maxReconnectAttempts: options.maxReconnectAttempts,
  })}\n`);
  return { connected: false, status: 'connecting' };
}

function scheduleCameraSourceRecovery(cameraId, source) {
  if (!source.desired || source.restartScheduled || cameraSources.get(cameraId) !== source) return;
  const maximum = source.options.maxReconnectAttempts;
  if (maximum && source.restartAttempts >= maximum) {
    source.desired = false;
    clearInterval(source.healthTimer);
    cameraSources.delete(cameraId);
    const issue = cameraErrorDetails('worker_disconnected');
    sendCameraStatus(cameraId, 'error', issue.message, 'worker_disconnected');
    return;
  }
  source.restartAttempts += 1;
  source.restartScheduled = true;
  const delay = Math.min(30000, 1000 * (2 ** (source.restartAttempts - 1)));
  const issue = cameraErrorDetails('worker_disconnected');
  sendCameraStatus(cameraId, 'reconnecting',
    `Camera capture worker stopped; retrying in ${Math.ceil(delay / 1000)} seconds. ${issue.message}`,
    'worker_disconnected');
  source.restartTimer = setTimeout(async () => {
    source.restartTimer = null;
    if (!source.desired || cameraSources.get(cameraId) !== source) return;
    cameraSources.delete(cameraId);
    try {
      await startCameraSource(cameraId, source.url, source.username, source.password, source.maximum, {
        ...source.options,
        restartAttempts: source.restartAttempts,
      });
    } catch (error) {
      source.desired = false;
      sendCameraStatus(cameraId, 'error', error.message, 'worker_disconnected');
    }
  }, delay);
}

function stopCameraSource(cameraId) {
  const source = cameraSources.get(cameraId);
  if (!source) {
    sendCameraStatus(cameraId, 'disconnected', 'Camera disconnected.');
    return Promise.resolve();
  }
  source.desired = false;
  clearInterval(source.healthTimer);
  if (source.restartTimer) clearTimeout(source.restartTimer);
  cameraSources.delete(cameraId);
  sendCameraStatus(cameraId, 'disconnected', 'RTSP camera disconnected.');
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, 3000);
    source.child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    source.child.kill();
  });
}

function stopCameraSources() {
  return Promise.all([...cameraSources.keys()].map(cameraId => stopCameraSource(cameraId)));
}

function captureCpuTimes() {
  return os.cpus().reduce((total, cpu) => {
    const cpuTotal = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: total.idle + cpu.times.idle, total: total.total + cpuTotal };
  }, { idle: 0, total: 0 });
}

async function getCameraDiagnostics(camera, network = null) {
  const settings = await readSettings();
  const source = cameraSources.get(camera.id);
  const usb = usbCameraDiagnostics.get(camera.id);
  const videoDiagnostics = source?.diagnostics || usb?.diagnostics;
  const lastFrameAt = source?.lastFrameAt || usb?.lastFrameAt || 0;
  const stale = lastFrameAt > 0 && Date.now() - lastFrameAt > 12000;
  const saved = cameraStatusRegistry.get(camera.id);
  const status = stale ? 'reconnecting'
    : source?.status || usb?.status || saved?.status || 'disconnected';
  const measuredHealth = videoDiagnostics ? evaluateVideoHealth({
    hasFrame: lastFrameAt > 0,
    frameAgeMs: lastFrameAt ? Date.now() - lastFrameAt : null,
    decoding: 'Decoded',
    fps: videoDiagnostics.fps > 0 ? videoDiagnostics.fps : null,
    brightness: videoDiagnostics.brightness,
  }) : '';
  const category = stale ? 'no_frames' : source?.errorCategory || measuredHealth || saved?.category || '';
  const issue = category ? cameraErrorDetails(category) : null;
  const before = captureCpuTimes();
  await new Promise(resolve => setTimeout(resolve, 100));
  const after = captureCpuTimes();
  const elapsed = after.total - before.total;
  const cpuPercent = elapsed > 0
    ? Math.max(0, Math.min(100, (1 - (after.idle - before.idle) / elapsed) * 100))
    : null;
  const activeCameras = [...cameraSources.values()].filter(item => item.desired).length
    + usbCameraReservations.size;
  const memory = process.memoryUsage();
  return {
    camera: {
      id: camera.id,
      name: camera.name,
      ipAddress: camera.ipAddress || '',
      manufacturer: camera.manufacturer || 'Unknown',
      model: camera.model || '',
      connectionType: camera.sourceType,
      status,
      rtsp: camera.sourceType === 'RTSP camera' ? {
        configured: Boolean(camera.rtspUrl),
        port: camera.rtspUrl ? Number(new URL(camera.rtspUrl).port || 554) : null,
        transport: source?.options.transport || camera.rtspTransport || 'tcp',
        reachable: (network || source?.network)?.reachable ?? null,
        latencyMs: (network || source?.network)?.latencyMs ?? null,
      } : null,
      authenticationStatus: source?.username
        ? source.status === 'connected' ? 'Verified' : category === 'authentication_failed' ? 'Failed' : 'Configured'
        : source?.status === 'connected' ? 'Not required'
          : camera.authenticationStatus === 'Configured' ? 'Configured'
            : camera.sourceType === 'RTSP camera' ? 'Unknown' : 'Not required',
      video: {
        decoding: videoDiagnostics ? 'Decoded' : status === 'error' ? 'Failed' : 'Waiting for first frame',
        resolution: videoDiagnostics?.width && videoDiagnostics?.height
          ? `${videoDiagnostics.width} × ${videoDiagnostics.height}` : null,
        width: videoDiagnostics?.width || null,
        height: videoDiagnostics?.height || null,
        fps: videoDiagnostics?.fps ?? null,
        codec: videoDiagnostics?.codec || 'Unknown',
        suspectedBlackFrame: videoDiagnostics?.brightness != null && videoDiagnostics.brightness < 2,
        brightness: videoDiagnostics?.brightness ?? null,
        lastFrameAt: lastFrameAt ? new Date(lastFrameAt).toISOString() : null,
        frameAgeMs: lastFrameAt ? Math.max(0, Date.now() - lastFrameAt) : null,
      },
      error: issue ? { category, ...issue } : null,
      detail: stale ? issue?.message : source?.detail || saved?.detail || '',
    },
    aiWorker: {
      status: workerReady ? 'connected' : workerProcess ? 'starting' : 'disconnected',
      detail: workerReady ? 'Local AI worker is ready.' : 'Local AI worker is not processing frames.',
    },
    resources: {
      cpuUsagePercent: cpuPercent == null ? null : Number(cpuPercent.toFixed(1)),
      processMemoryBytes: memory.rss,
      systemMemoryFreeBytes: os.freemem(),
      systemMemoryTotalBytes: os.totalmem(),
      activeCameras,
      cameraLimit: settings.maxConcurrentCameras,
      availableCameraSlots: Math.max(0, settings.maxConcurrentCameras - activeCameras),
      available: os.freemem() > 512 * 1024 * 1024 && activeCameras < settings.maxConcurrentCameras,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function testCameraConnection(input) {
  const settings = await readSettings();
  const camera = settings.cameras.find(item => item.id === input.cameraId);
  if (!camera || camera.sourceType !== 'RTSP camera' || !camera.rtspUrl) {
    throw new Error('The selected profile must contain a configured RTSP camera URL.');
  }
  const endpoint = validateRtspUrl(camera.rtspUrl, camera.ipAddress);
  let credentials = { username: '', password: '' };
  if (Object.hasOwn(input, 'username') || Object.hasOwn(input, 'password')) {
    if (typeof input.username !== 'string' || typeof input.password !== 'string') {
      throw new Error('Provide both an RTSP username and password, or leave both blank.');
    }
  }
  if (typeof input.username === 'string' && typeof input.password === 'string'
    && (input.username.length > 0 || input.password.length > 0)) {
    if (input.username.length > 128 || input.password.length > 256
      || Boolean(input.username) !== Boolean(input.password)) {
      throw new Error('Provide both an RTSP username and password, or leave both blank.');
    }
    credentials = { username: input.username, password: input.password };
    if (input.remember === true) {
      await saveCameraCredentials(camera.id, credentials.username, credentials.password);
    } else {
      await clearCameraCredentials(camera.id);
    }
  } else {
    const secrets = await loadCameraSecrets();
    credentials = secrets[camera.id] || credentials;
  }

  const port = Number(endpoint.port || 554);
  const network = await probeRtspPort(endpoint.hostname, port);
  let source = cameraSources.get(camera.id);
  if (source) source.network = network;
  const hasRecentFrame = source?.lastFrameAt && Date.now() - source.lastFrameAt <= 12000;
  if (!network.reachable && !hasRecentFrame) {
    const issue = cameraErrorDetails(network.category);
    sendCameraStatus(camera.id, 'error', issue.message, network.category);
    return getCameraDiagnostics(camera, network);
  }
  const streamOptions = {
    transport: camera.rtspTransport,
    processingFps: camera.processingFps,
    maxReconnectAttempts: settings.cameraReconnectAttempts,
  };
  const sameConnection = hasRecentFrame && source.url === endpoint.href
    && source.username === credentials.username && source.password === credentials.password
    && source.options.transport === streamOptions.transport
    && source.options.processingFps === streamOptions.processingFps
    && source.options.maxReconnectAttempts === streamOptions.maxReconnectAttempts;
  if (!sameConnection) {
    await startCameraSource(camera.id, endpoint.href, credentials.username, credentials.password,
      settings.maxConcurrentCameras, streamOptions);
    source = cameraSources.get(camera.id);
    if (source) source.network = network;
  }
  const startFrameAt = source?.lastFrameAt || 0;
  const timeoutAt = Date.now() + 15000;
  while (Date.now() < timeoutAt) {
    source = cameraSources.get(camera.id);
    if (!source || (source.status === 'error' && !source.desired)) break;
    if (source?.lastFrameAt && source.lastFrameAt > startFrameAt) break;
    if (source?.lastFrameAt && Date.now() - source.lastFrameAt <= 12000) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (source && !source.lastFrameAt) {
    const category = source.errorCategory || 'no_frames';
    const issue = cameraErrorDetails(category);
    sendCameraStatus(camera.id, source.status === 'reconnecting' ? 'reconnecting' : 'error', issue.message, category);
  }
  return getCameraDiagnostics(camera, network);
}

async function restartCameraSource(cameraId, force = false, input = {}) {
  const settings = await readSettings();
  const camera = settings.cameras.find(item => item.id === cameraId);
  if (!camera || camera.sourceType !== 'RTSP camera' || !camera.rtspUrl) {
    throw new Error('The selected profile must contain a configured RTSP camera URL.');
  }
  const existing = cameraSources.get(cameraId);
  if (!force && existing?.desired && existing.status === 'connected'
    && existing.lastFrameAt && Date.now() - existing.lastFrameAt <= 12000) {
    return { connected: true, status: existing.status };
  }
  let credentials;
  if (Object.hasOwn(input, 'username') || Object.hasOwn(input, 'password')) {
    if (typeof input.username !== 'string' || typeof input.password !== 'string'
      || input.username.length > 128 || input.password.length > 256
      || Boolean(input.username) !== Boolean(input.password)) {
      throw new Error('Provide both an RTSP username and password, or leave both blank.');
    }
  }
  if (input.username || input.password) {
    credentials = { username: input.username, password: input.password };
    if (input.remember === true) await saveCameraCredentials(camera.id, credentials.username, credentials.password);
    else await clearCameraCredentials(camera.id);
  } else {
    const secrets = await loadCameraSecrets();
    credentials = secrets[camera.id] || { username: '', password: '' };
  }
  await stopCameraSource(cameraId);
  return startCameraSource(cameraId, validateRtspUrl(camera.rtspUrl, camera.ipAddress).href,
    credentials.username, credentials.password, settings.maxConcurrentCameras, {
      transport: camera.rtspTransport,
      processingFps: camera.processingFps,
      maxReconnectAttempts: settings.cameraReconnectAttempts,
    });
}

function isTrustedRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  const url = event.senderFrame?.url || '';
  if (app.isPackaged) return url === pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  try {
    return new URL(url).origin === 'http://127.0.0.1:5173';
  } catch {
    return false;
  }
}

function isTrustedWebContents(webContents, origin) {
  if (!mainWindow || webContents !== mainWindow.webContents) return false;
  if (app.isPackaged) {
    const expectedUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
    return webContents.getURL() === expectedUrl && typeof origin === 'string' && origin.startsWith('file://');
  }
  return origin === 'http://127.0.0.1:5173';
}

function sendAiStatus(status, detail = '') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ai:status', { status, detail });
  }
}

function clearWorkerFrameTimer() {
  if (workerFrameTimer) {
    clearTimeout(workerFrameTimer);
    workerFrameTimer = null;
  }
}

function sendWorkerMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'ready') {
    clearWorkerFrameTimer();
    workerReady = true;
    workerBusy = false;
    sendAiStatus('connected', 'AI worker is ready.');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai:totals', message.totals || {});
    }
    return;
  }
  if (message.type === 'frame_error') {
    clearWorkerFrameTimer();
    workerBusy = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai:frame-error', {
        message: typeof message.message === 'string' ? message.message : 'Could not process camera frame.',
      });
    }
    return;
  }
  if (message.type === 'detection') {
    clearWorkerFrameTimer();
    workerBusy = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai:detection', message);
    }
    return;
  }
  if (message.type === 'error') {
    clearWorkerFrameTimer();
    workerReady = false;
    workerBusy = false;
    sendAiStatus('error', typeof message.message === 'string' ? message.message : 'The AI worker reported an error.');
  }
}

function getWorkerPaths() {
  const workerFile = app.isPackaged
    ? path.join(process.resourcesPath, 'worker', 'worker.py')
    : path.join(__dirname, '..', 'worker', 'worker.py');
  const modelFile = path.join(app.getPath('appData'), 'queuepulse-ai', 'models', 'yolov8n.pt');
  const dataDirectory = path.join(app.getPath('appData'), 'queuepulse-ai');
  const databaseFile = path.join(dataDirectory, 'queuepulse.sqlite3');
  const evidenceDirectory = path.join(dataDirectory, 'evidence');
  const cameraSourceFile = app.isPackaged
    ? path.join(process.resourcesPath, 'worker', 'camera_source.py')
    : path.join(__dirname, '..', 'worker', 'camera_source.py');
  return { workerFile, modelFile, databaseFile, evidenceDirectory, cameraSourceFile };
}

function pythonCommand() {
  if (process.env.QUEUEPULSE_PYTHON) return { command: process.env.QUEUEPULSE_PYTHON, prefix: [] };
  return process.platform === 'win32'
    ? { command: 'py', prefix: ['-3'] }
    : { command: 'python3', prefix: [] };
}

async function startWorker() {
  const isNewSession = !workerDesired;
  workerDesired = true;
  if (isNewSession) workerRestartCount = 0;
  if (workerReady && workerProcess) return;
  if (workerStartPromise) return workerStartPromise;
  if (workerProcess) throw new Error('The previous AI worker is still shutting down. Try again in a moment.');

  const { workerFile, modelFile, databaseFile, evidenceDirectory } = getWorkerPaths();
  const python = pythonCommand();
  sendAiStatus('starting', 'Starting the local AI worker…');
  const child = spawn(python.command, [...python.prefix, workerFile, '--model', modelFile, '--database', databaseFile, '--evidence-dir', evidenceDirectory], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  workerProcess = child;
  workerReady = false;
  workerBusy = false;
  workerOutputBuffer = '';

  let resolveStartup;
  let rejectStartup;
  let settled = false;
  const startup = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  workerStartPromise = startup;
  const startupTimeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectStartup(new Error('The AI worker did not become ready in time.'));
    sendAiStatus('error', 'The AI worker did not become ready in time.');
    child.kill();
  }, 45000);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    workerOutputBuffer += chunk;
    if (workerOutputBuffer.length > 1024 * 1024) {
      workerOutputBuffer = '';
      workerBusy = false;
      sendAiStatus('error', 'The AI worker returned an oversized response.');
      child.kill();
      return;
    }
    let newline;
    while ((newline = workerOutputBuffer.indexOf('\n')) !== -1) {
      const line = workerOutputBuffer.slice(0, newline);
      workerOutputBuffer = workerOutputBuffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        sendWorkerMessage(message);
        if (message.type === 'ready' && !settled) {
          settled = true;
          clearTimeout(startupTimeout);
          resolveStartup();
        } else if (message.type === 'error' && !settled) {
          settled = true;
          clearTimeout(startupTimeout);
          rejectStartup(new Error(typeof message.message === 'string' ? message.message : 'The AI worker could not start.'));
        }
      } catch (error) {
        workerBusy = false;
        console.error('Could not parse AI worker response:', error);
        sendAiStatus('error', 'The AI worker returned an invalid response.');
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => console.error(`AI worker: ${data.trim()}`));
  child.stdin.on('error', error => {
    clearWorkerFrameTimer();
    workerBusy = false;
    sendAiStatus('error', `Could not send frames to the AI worker: ${error.message}`);
    child.kill();
  });
  child.on('error', error => {
    clearWorkerFrameTimer();
    workerReady = false;
    workerBusy = false;
    if (workerProcess === child) workerProcess = null;
    workerDesired = false;
    if (!settled) {
      settled = true;
      clearTimeout(startupTimeout);
      rejectStartup(new Error(`Could not start Python (${error.message}). Install Python 3 and the worker dependencies.`));
    }
    sendAiStatus('error', `Could not start Python: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    clearWorkerFrameTimer();
    clearTimeout(startupTimeout);
    const hadBeenReady = workerReady;
    if (workerProcess === child) workerProcess = null;
    workerReady = false;
    workerBusy = false;
    if (!settled) {
      settled = true;
      rejectStartup(new Error(`The AI worker exited before becoming ready (code ${code ?? signal ?? 'unknown'}).`));
    }
    if (!workerDesired) {
      sendAiStatus('disconnected', 'AI worker stopped.');
      return;
    }
    if (hadBeenReady) {
      runWorkerCommand([
        '--system-alert',
        'ai_worker_disconnected',
        `AI worker exited unexpectedly (code ${code ?? signal ?? 'unknown'}).`,
        'Local AI worker',
      ]).then(result => {
        if (result.event && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ai:event', result.event);
        }
      }).catch(error => console.error('Could not persist AI worker alert:', error));
    }
    if (hadBeenReady && workerRestartCount < 5) {
      workerRestartCount += 1;
      const delay = Math.min(30000, 1000 * (2 ** (workerRestartCount - 1)));
      sendAiStatus('starting', `AI worker stopped unexpectedly; retrying in ${Math.ceil(delay / 1000)} seconds (${workerRestartCount}/5)…`);
      workerRetryTimer = setTimeout(() => {
        workerRetryTimer = null;
        startWorker().catch(error => sendAiStatus('error', error.message));
      }, delay);
    } else {
      workerDesired = false;
      sendAiStatus('error', `AI worker exited unexpectedly (code ${code ?? signal ?? 'unknown'}).`);
    }
  });

  try {
    await startup;
  } finally {
    clearTimeout(startupTimeout);
    if (workerStartPromise === startup) workerStartPromise = null;
  }
}

function runWorkerCommand(args) {
  const { workerFile, databaseFile } = getWorkerPaths();
  const python = pythonCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(python.command, [...python.prefix, workerFile, '--database', databaseFile, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 2 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Worker history command exited with code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('The worker returned invalid history data.'));
      }
    });
  });
}

async function stopWorker() {
  workerDesired = false;
  workerReady = false;
  workerBusy = false;
  clearWorkerFrameTimer();
  if (workerRetryTimer) {
    clearTimeout(workerRetryTimer);
    workerRetryTimer = null;
  }
  const child = workerProcess;
  if (!child) {
    sendAiStatus('disconnected', 'AI worker stopped.');
    return;
  }
  sendAiStatus('stopping', 'Stopping the AI worker…');
  await new Promise(resolve => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 1500);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.stdin.end();
  });
}

function registerIpc() {
  ipcMain.handle('settings:load', async (event) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    return readSettings();
  });
  ipcMain.handle('settings:save', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const previousSettings = await readSettings();
    const saved = await writeSettings(input);
    for (const camera of previousSettings.cameras) {
      if (!saved.cameras.some(updated => updated.id === camera.id)) {
        usbCameraReservations.delete(camera.id);
        usbCameraDiagnostics.delete(camera.id);
        cameraStatusRegistry.delete(camera.id);
      }
    }
    for (const [cameraId, source] of [...cameraSources]) {
      const previous = previousSettings.cameras.find(camera => camera.id === cameraId);
      const updated = saved.cameras.find(camera => camera.id === cameraId);
      const sourceSettingsChanged = updated && previous && (
        updated.sourceType !== previous.sourceType
        || updated.rtspUrl !== previous.rtspUrl
        || updated.rtspTransport !== previous.rtspTransport
        || updated.processingFps !== previous.processingFps
      );
      if (!updated || updated.sourceType !== 'RTSP camera' || sourceSettingsChanged) {
        await stopCameraSource(cameraId);
        if (!updated) cameraStatusRegistry.delete(cameraId);
        if (updated?.sourceType === 'RTSP camera' && updated.rtspUrl) {
          try {
            await startCameraSource(cameraId, validateRtspUrl(updated.rtspUrl, updated.ipAddress).href,
              source.username, source.password, saved.maxConcurrentCameras, {
                transport: updated.rtspTransport,
                processingFps: updated.processingFps,
                maxReconnectAttempts: saved.cameraReconnectAttempts,
              });
          } catch (error) {
            sendCameraStatus(cameraId, 'error', error.message);
          }
        }
      }
    }
    return saved;
  });
  ipcMain.handle('settings:reset', async (event) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    await stopCameraSources();
    usbCameraReservations.clear();
    usbCameraDiagnostics.clear();
    cameraStatusRegistry.clear();
    await fs.rm(cameraSecretsFile, { force: true });
    return writeSettings(DEFAULT_SETTINGS);
  });
  ipcMain.handle('camera:discover', async event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    return discoverOnvif();
  });
  ipcMain.handle('camera:discovery-stop', event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    stopDiscovery();
    return true;
  });
  ipcMain.handle('camera:onvif-profiles', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (!input || typeof input.ipAddress !== 'string' || typeof input.xaddr !== 'string'
      || typeof input.username !== 'string' || typeof input.password !== 'string') {
      throw new Error('Invalid ONVIF camera request.');
    }
    return getOnvifProfiles(input);
  });
  ipcMain.handle('camera:save-credentials', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (!input || typeof input.cameraId !== 'string') throw new Error('Invalid camera credentials.');
    if (input.remember === true) {
      await saveCameraCredentials(input.cameraId, input.username, input.password);
    } else {
      await clearCameraCredentials(input.cameraId);
    }
    return { saved: input.remember === true };
  });
  ipcMain.handle('camera:start-stream', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (!input || typeof input.cameraId !== 'string') throw new Error('Invalid camera connection request.');
    const settings = await readSettings();
    const camera = settings.cameras.find(item => item.id === input.cameraId);
    if (!camera || camera.sourceType !== 'RTSP camera' || !camera.rtspUrl) {
      throw new Error('The camera profile does not contain a valid RTSP stream URL.');
    }
    const sourceUrl = validateRtspUrl(camera.rtspUrl, camera.ipAddress);
    let credentials = { username: '', password: '' };
    if (Object.hasOwn(input, 'username') || Object.hasOwn(input, 'password')) {
      if (typeof input.username !== 'string' || typeof input.password !== 'string') {
        throw new Error('Provide both an RTSP username and password, or leave both blank.');
      }
    }
    if (typeof input.username === 'string' && typeof input.password === 'string'
      && (input.username.length > 0 || input.password.length > 0)) {
      if (input.username.length > 128 || input.password.length > 256) throw new Error('Invalid camera credentials.');
      if (Boolean(input.username) !== Boolean(input.password)) {
        throw new Error('Provide both an RTSP username and password, or leave both blank.');
      }
      credentials = { username: input.username, password: input.password };
      if (input.remember === true) {
        await saveCameraCredentials(camera.id, credentials.username, credentials.password);
      } else {
        await clearCameraCredentials(camera.id);
      }
    } else {
      const secrets = await loadCameraSecrets();
      credentials = secrets[camera.id] || credentials;
    }
    const limit = settings.maxConcurrentCameras;
    return startCameraSource(camera.id, sourceUrl.href, credentials.username, credentials.password, limit, {
      transport: camera.rtspTransport,
      processingFps: camera.processingFps,
      maxReconnectAttempts: settings.cameraReconnectAttempts,
    });
  });
  ipcMain.handle('camera:reserve-usb', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (typeof input?.cameraId !== 'string') throw new Error('Invalid USB camera connection request.');
    const settings = await readSettings();
    const camera = settings.cameras.find(item => item.id === input.cameraId);
    if (!camera || !['USB webcam', 'HDMI capture card'].includes(camera.sourceType)) {
      throw new Error('The camera profile is not configured as a Windows video input.');
    }
    if (usbCameraReservations.has(camera.id)) return { connected: true };
    const activeCount = [...cameraSources.values()].filter(source => source.desired).length + usbCameraReservations.size;
    if (activeCount >= settings.maxConcurrentCameras) {
      throw new Error(`Camera connection limit reached (${settings.maxConcurrentCameras}). Disconnect a camera or increase the limit in Settings.`);
    }
    usbCameraReservations.add(camera.id);
    usbCameraDiagnostics.delete(camera.id);
    sendCameraStatus(camera.id, 'connecting', 'Opening the Windows video device…');
    return { connected: true };
  });
  ipcMain.handle('camera:release-usb', (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (typeof input?.cameraId !== 'string') throw new Error('Invalid USB camera disconnect request.');
    usbCameraReservations.delete(input.cameraId);
    usbCameraDiagnostics.delete(input.cameraId);
    sendCameraStatus(input.cameraId, 'disconnected', 'Windows video device disconnected.');
    return { connected: false };
  });
  ipcMain.handle('camera:report-usb-status', (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (typeof input?.cameraId !== 'string' || !usbCameraReservations.has(input.cameraId)) {
      throw new Error('The USB camera does not have an active connection reservation.');
    }
    if (input.status === 'reconnecting') {
      const current = usbCameraDiagnostics.get(input.cameraId);
      usbCameraDiagnostics.set(input.cameraId, { ...current, status: 'reconnecting' });
      sendCameraStatus(input.cameraId, 'reconnecting', 'The Windows video device stopped delivering frames.', 'no_frames');
      return { connected: false };
    }
    if (input.status !== 'connected'
      || !Number.isInteger(input.diagnostics?.width) || input.diagnostics.width < 1
      || !Number.isInteger(input.diagnostics?.height) || input.diagnostics.height < 1
      || !Number.isFinite(input.diagnostics?.fps) || input.diagnostics.fps < 0 || input.diagnostics.fps > 240) {
      throw new Error('A decoded Windows video frame with valid measurements is required.');
    }
    usbCameraDiagnostics.set(input.cameraId, {
      status: 'connected',
      lastFrameAt: Date.now(),
      diagnostics: {
        width: input.diagnostics.width,
        height: input.diagnostics.height,
        fps: input.diagnostics.fps,
        codec: 'Windows media device',
      },
    });
    sendCameraStatus(input.cameraId, 'connected', 'Windows video device is delivering decoded frames.');
    return { connected: true };
  });
  ipcMain.handle('camera:stop-stream', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const cameraId = typeof input?.cameraId === 'string' ? input.cameraId : '';
    if (!cameraId) throw new Error('A camera ID is required to disconnect a camera.');
    await stopCameraSource(cameraId);
    return { connected: false };
  });
  ipcMain.handle('camera:status', (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (!input || typeof input.cameraId !== 'string') throw new Error('Invalid camera status request.');
    const source = cameraSources.get(input.cameraId);
    const usb = usbCameraDiagnostics.get(input.cameraId);
    const savedStatus = cameraStatusRegistry.get(input.cameraId);
    const lastFrameAt = source?.lastFrameAt || usb?.lastFrameAt || 0;
    const status = lastFrameAt > 0 && Date.now() - lastFrameAt > 12000
      ? 'reconnecting' : source?.status || usb?.status || savedStatus?.status || 'disconnected';
    return {
      id: input.cameraId,
      status,
      detail: source?.detail || savedStatus?.detail || '',
      category: source?.errorCategory || savedStatus?.category || '',
      diagnostics: source?.diagnostics || usb?.diagnostics || null,
      lastFrameAt: lastFrameAt ? new Date(lastFrameAt).toISOString() : null,
    };
  });
  ipcMain.handle('camera:diagnostics', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (!input || typeof input.cameraId !== 'string') throw new Error('Invalid camera diagnostics request.');
    const settings = await readSettings();
    const camera = settings.cameras.find(item => item.id === input.cameraId);
    if (!camera) throw new Error('The requested camera profile no longer exists.');
    return getCameraDiagnostics(camera);
  });
  ipcMain.handle('camera:test-connection', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (!input || typeof input.cameraId !== 'string') throw new Error('Invalid camera connection test request.');
    return testCameraConnection(input);
  });
  ipcMain.handle('camera:retry', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (!input || typeof input.cameraId !== 'string') throw new Error('Invalid camera retry request.');
    return restartCameraSource(input.cameraId, false, input);
  });
  ipcMain.handle('camera:reconnect', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (!input || typeof input.cameraId !== 'string') throw new Error('Invalid camera reconnect request.');
    return restartCameraSource(input.cameraId, true, input);
  });
  ipcMain.handle('ai:start', async event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    await startWorker();
    return { connected: workerReady };
  });
  ipcMain.handle('ai:stop', async event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    await stopWorker();
    return { connected: false };
  });
  ipcMain.handle('ai:history', async event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const result = await runWorkerCommand(['--history']);
    const evidenceDirectory = getWorkerPaths().evidenceDirectory;
    await Promise.all((result.alerts || []).slice(0, 8).map(async alert => {
      if (typeof alert.evidencePath !== 'string' || path.dirname(alert.evidencePath) !== evidenceDirectory) return;
      try {
        const image = await fs.readFile(alert.evidencePath);
        if (image.length <= 1_000_000) alert.evidence = `data:image/jpeg;base64,${image.toString('base64')}`;
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('Could not read alert evidence:', error);
      }
    }));
    return result;
  });
  ipcMain.handle('report:print', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const html = createReportHtml(input);
    const reportWindow = new BrowserWindow({
      width: 900,
      height: 800,
      parent: mainWindow || undefined,
      show: false,
      title: 'QueuePulse AI report',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    try {
      await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      reportWindow.show();
      return await new Promise((resolve, reject) => {
        reportWindow.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
          if (success) resolve({ printed: true });
          else if (/cancel/i.test(failureReason || '')) resolve({ printed: false, canceled: true });
          else reject(new Error(failureReason || 'The system print dialog could not print this report.'));
        });
      });
    } catch (error) {
      throw new Error(`Could not open the report print dialog: ${error.message}`);
    } finally {
      if (!reportWindow.isDestroyed()) reportWindow.close();
    }
  });
  ipcMain.handle('report:save-pdf', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const html = createReportHtml(input);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save QueuePulse AI report as PDF',
      defaultPath: `QueuePulse-Traffic-Report-${new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false, canceled: true };
    const reportWindow = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    try {
      await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdf = await reportWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      });
      await fs.writeFile(result.filePath, pdf);
      return { saved: true, filePath: result.filePath };
    } catch (error) {
      throw new Error(`Could not save the report as PDF: ${error.message}`);
    } finally {
      if (!reportWindow.isDestroyed()) reportWindow.close();
    }
  });
  ipcMain.handle('ai:update-alert', async (event, update) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (!update || typeof update.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(update.id)) {
      throw new Error('Invalid alert identifier.');
    }
    const action = update.action === 'resolve' ? '--resolve' : update.action === 'acknowledge' ? '--acknowledge' : '';
    if (!action) throw new Error('Invalid alert action.');
    return runWorkerCommand([action, update.id]);
  });
  ipcMain.handle('ai:system-alert', async (event, input) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const allowed = ['camera_disconnected', 'detection_failure'];
    if (!input || !allowed.includes(input.type) || typeof input.detail !== 'string' || input.detail.length > 300) {
      throw new Error('Invalid system alert.');
    }
    const result = await runWorkerCommand([
      '--system-alert', input.type, input.detail, typeof input.camera === 'string' ? input.camera.slice(0, 80) : 'Camera',
      '--camera-id', typeof input.cameraId === 'string' ? input.cameraId.slice(0, 60) : '',
    ]);
    if (result.event && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai:event', result.event);
    }
    return result.event;
  });
  ipcMain.handle('ai:frame', (event, frame) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    if (!workerReady || !workerProcess || workerBusy) return false;
    if (!frame || typeof frame.image !== 'string' || frame.image.length > 700000) {
      throw new Error('Invalid camera frame.');
    }
    if (!frame.config || typeof frame.config !== 'object' || Array.isArray(frame.config)) {
      throw new Error('Invalid detection configuration.');
    }
    if (JSON.stringify(frame.config).length > 12000) {
      throw new Error('Detection configuration is too large.');
    }
    workerBusy = true;
    try {
      const canContinue = workerProcess.stdin.write(`${JSON.stringify({ image: frame.image, config: frame.config })}\n`);
      clearWorkerFrameTimer();
      workerFrameTimer = setTimeout(() => {
        if (!workerProcess || !workerReady || !workerBusy) return;
        workerBusy = false;
        sendAiStatus('error', 'The AI worker stopped responding to camera frames.');
        workerProcess.kill();
      }, 30000);
      return canContinue;
    } catch (error) {
      clearWorkerFrameTimer();
      workerBusy = false;
      throw error;
    }
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#101521',
    title: 'QueuePulse AI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const trusted = app.isPackaged
      ? url === require('node:url').pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href
      : (() => {
        try { return new URL(url).origin === 'http://127.0.0.1:5173'; } catch { return false; }
      })();
    if (!trusted) event.preventDefault();
  });
  window.webContents.on('render-process-gone', () => {
    for (const cameraId of usbCameraReservations) {
      usbCameraReservations.delete(cameraId);
      usbCameraDiagnostics.delete(cameraId);
      sendCameraStatus(cameraId, 'disconnected', 'Windows video renderer stopped.');
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
    stopWorker();
  });
  if (app.isPackaged) {
    window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    window.loadURL('http://127.0.0.1:5173');
  }
}

async function restoreCameraSources() {
  const settings = await readSettings();
  if (!settings.autoReconnectCameras) return;
  for (const camera of settings.cameras) {
    if (camera.sourceType !== 'RTSP camera' || !camera.rtspUrl) continue;
    try {
      const secrets = await loadCameraSecrets();
      const credentials = secrets[camera.id] || { username: '', password: '' };
      await startCameraSource(camera.id, validateRtspUrl(camera.rtspUrl, camera.ipAddress).href,
        credentials.username, credentials.password, settings.maxConcurrentCameras, {
          transport: camera.rtspTransport,
          processingFps: camera.processingFps,
          maxReconnectAttempts: settings.cameraReconnectAttempts,
        });
    } catch (error) {
      sendCameraStatus(camera.id, 'error', error.message);
    }
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL() || '';
    const origin = app.isPackaged ? 'file://' : (() => {
      try { return new URL(url).origin; } catch { return ''; }
    })();
    callback(permission === 'media' && isTrustedWebContents(webContents, origin));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const url = webContents?.getURL?.() || '';
    const origin = app.isPackaged ? requestingOrigin : (() => {
      try { return new URL(url).origin; } catch { return ''; }
    })();
    return permission === 'media' && isTrustedWebContents(webContents, origin);
  });
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  cameraSecretsFile = path.join(app.getPath('userData'), 'camera-secrets.bin');
  registerIpc();
  createWindow();
  restoreCameraSources().catch(error => console.error('Could not restore saved camera connections:', error));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', event => {
  if (app.isQuitting) return;
  event.preventDefault();
  app.isQuitting = true;
  Promise.all([stopWorker(), stopCameraSources()]).finally(() => app.quit());
});
