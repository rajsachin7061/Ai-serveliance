import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TRAFFIC_PERIODS, summarizeTrafficPeriod } from './analytics.mjs';
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Bell, Camera,
  Check, ChevronDown, CircleHelp, Clock3, Command, Download, Eye,
  FileChartColumn, LayoutDashboard, LifeBuoy, MapPin, Menu, MoreHorizontal,
  Plus, Radio, RefreshCw, Search, Settings, ShieldCheck, ShoppingBag,
  SlidersHorizontal, Sparkles, Store, Video, Wifi, WifiOff, X, Zap,
} from 'lucide-react';

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
  cameras: [{ id: 'demo-camera-01', name: 'Front Entrance', location: 'Main entrance', sourceType: 'Demo feed', status: 'Demo mode' }],
};

const usbCameraStreams = new Map();
const usbCameraMonitors = new Map();

function stopUsbCameraMonitor(cameraId) {
  const monitor = usbCameraMonitors.get(cameraId);
  if (!monitor) return;
  monitor.active = false;
  clearInterval(monitor.healthTimer);
  if (monitor.frameCallbackId != null && typeof monitor.video.cancelVideoFrameCallback === 'function') {
    monitor.video.cancelVideoFrameCallback(monitor.frameCallbackId);
  }
  monitor.video.pause();
  monitor.video.srcObject = null;
  usbCameraMonitors.delete(cameraId);
}

function monitorUsbCamera(cameraId, stream) {
  stopUsbCameraMonitor(cameraId);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const monitor = {
    video,
    active: true,
    frameCallbackId: null,
    healthTimer: null,
    lastFrameAt: performance.now(),
    lastReportAt: 0,
    fpsStartedAt: performance.now(),
    fpsFrames: 0,
    reportedStatus: 'connecting',
    reportPending: false,
  };
  usbCameraMonitors.set(cameraId, monitor);
  const report = async (status, diagnostics) => {
    if (!window.queuePulse?.reportUsbCameraStatus || monitor.reportPending) return;
    monitor.reportPending = true;
    try {
      await window.queuePulse.reportUsbCameraStatus(cameraId, status, diagnostics);
      monitor.reportedStatus = status;
    } catch (error) {
      console.error('Could not update Windows camera health:', error);
    } finally {
      monitor.reportPending = false;
    }
  };
  const onFrame = timestamp => {
    if (!monitor.active) return;
    monitor.lastFrameAt = timestamp;
    monitor.fpsFrames += 1;
    const elapsed = timestamp - monitor.fpsStartedAt;
    if (elapsed >= 1000) {
      const fps = Number(((monitor.fpsFrames * 1000) / elapsed).toFixed(2));
      monitor.fpsFrames = 0;
      monitor.fpsStartedAt = timestamp;
      if (timestamp - monitor.lastReportAt >= 1000) {
        monitor.lastReportAt = timestamp;
        report('connected', {
          width: video.videoWidth,
          height: video.videoHeight,
          fps,
          codec: 'Windows media device',
        });
      }
    }
    monitor.frameCallbackId = video.requestVideoFrameCallback(onFrame);
  };
  video.play().then(() => {
    if (monitor.active && typeof video.requestVideoFrameCallback === 'function') {
      monitor.frameCallbackId = video.requestVideoFrameCallback(onFrame);
    }
  }).catch(error => {
    if (monitor.active) {
      console.error('Could not monitor Windows camera frames:', error);
      report('reconnecting');
    }
  });
  monitor.healthTimer = setInterval(() => {
    if (!monitor.active || performance.now() - monitor.lastFrameAt <= 5000
      || monitor.reportedStatus === 'reconnecting') return;
    report('reconnecting');
  }, 1000);
}

function stopUsbCamera(cameraId) {
  const stream = usbCameraStreams.get(cameraId);
  stopUsbCameraMonitor(cameraId);
  if (!stream) return;
  stream.getTracks().forEach(track => track.stop());
  usbCameraStreams.delete(cameraId);
}

const NAV = [
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard, section: 'WORKSPACE' },
  { id: 'discovery', label: 'Camera discovery', icon: Search },
  { id: 'cameras', label: 'Cameras', icon: Video },
  { id: 'diagnostics', label: 'Camera diagnostics', icon: Activity },
  { id: 'monitor', label: 'Live monitor', icon: Eye },
  { id: 'analytics', label: 'Analytics', icon: FileChartColumn },
  { id: 'alerts', label: 'Alerts & events', icon: Bell, count: '3' },
  { id: 'settings', label: 'Settings', icon: Settings, section: 'CONFIGURATION' },
];

function loadInitialSettings() {
  if (window.queuePulse?.loadSettings) return window.queuePulse.loadSettings();
  try {
    const stored = localStorage.getItem('queuepulse-settings');
    return Promise.resolve(stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS);
  } catch {
    return Promise.resolve(DEFAULT_SETTINGS);
  }
}

function persistSettings(next) {
  if (window.queuePulse?.saveSettings) return window.queuePulse.saveSettings(next);
  localStorage.setItem('queuepulse-settings', JSON.stringify(next));
  return Promise.resolve(next);
}

function cx(...parts) { return parts.filter(Boolean).join(' '); }

function App() {
  const [page, setPage] = useState('dashboard');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [aiHistory, setAiHistory] = useState(null);
  const [aiHistoryError, setAiHistoryError] = useState('');
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [cameraStatuses, setCameraStatuses] = useState({});
  const alertSoundsPlayed = useRef(new Set());

  useEffect(() => {
    let active = true;
    loadInitialSettings().then(value => {
      if (!active) return;
      setSettings(value);
      setDraft(value);
      setReady(true);
      if (window.queuePulse?.getCameraStatus) {
        Promise.all(value.cameras.filter(camera => camera.sourceType === 'RTSP camera').map(async camera => {
          const status = await window.queuePulse.getCameraStatus(camera.id);
          return [camera.id, status.status];
        })).then(statuses => setCameraStatuses(previous => ({
          ...previous,
          ...Object.fromEntries(statuses.map(([id, status]) => [id, status === 'connected' ? 'Connected'
            : status === 'reconnecting' ? 'Reconnecting'
              : status === 'connecting' ? 'Connecting'
              : status === 'error' ? 'Error' : 'Not connected'])),
        }))).catch(error => console.error('Could not restore camera statuses:', error));
      }
    }).catch(error => {
      if (active) {
        setToast(`Could not load saved settings: ${error.message}`);
        setReady(true);
      }
    });
    return () => { active = false; };
  }, []);

  const refreshAiHistory = async () => {
    if (!window.queuePulse?.loadAiHistory) return;
    try {
      const history = await window.queuePulse.loadAiHistory();
      setAiHistory(history);
      setAiHistoryError('');
    } catch (error) {
      setAiHistoryError(error.message || 'Could not load local analytics.');
    }
  };

  useEffect(() => {
    refreshAiHistory();
    const interval = setInterval(refreshAiHistory, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(timeout);
  }, [toast]);

  const changeDraft = (key, value) => setDraft(prev => ({ ...prev, [key]: value }));

  const saveSettings = async () => {
    setSaving(true);
    try {
      const saved = await persistSettings(draft);
      for (const camera of settings.cameras) {
        const updated = saved.cameras.find(item => item.id === camera.id);
        if (!updated || updated.sourceType !== camera.sourceType || updated.deviceId !== camera.deviceId) {
          stopUsbCamera(camera.id);
          if (['USB webcam', 'HDMI capture card'].includes(camera.sourceType)) {
            await window.queuePulse?.releaseUsbCamera?.(camera.id);
          }
          updateCameraConnectionStatus(camera.id, 'Not connected');
        }
      }
      setSettings(saved);
      setDraft(saved);
      setToast('Settings saved on this device');
    } catch (error) {
      setToast(`Could not save settings: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const resetSettings = async () => {
    const confirmed = window.confirm('Reset QueuePulse settings to their defaults? Camera entries will also return to the demo camera.');
    if (!confirmed) return;
    try {
      let reset;
      if (window.queuePulse?.resetSettings) reset = await window.queuePulse.resetSettings();
      else {
        reset = DEFAULT_SETTINGS;
        localStorage.setItem('queuepulse-settings', JSON.stringify(reset));
      }
      settings.cameras.forEach(camera => {
        stopUsbCamera(camera.id);
        updateCameraConnectionStatus(camera.id, 'Not connected');
      });
      setSettings(reset);
      setDraft(reset);
      setToast('Settings reset to defaults');
    } catch (error) {
      setToast(`Could not reset settings: ${error.message}`);
    }
  };

  const saveDetectionSettings = async (cameraId, detectionSettings) => {
    const next = {
      ...settings,
      cameras: settings.cameras.map(camera => camera.id === cameraId
        ? { ...camera, configuration: detectionSettings }
        : camera),
    };
    const saved = await persistSettings(next);
    setSettings(saved);
    setDraft(saved);
    setToast('Selected camera configuration saved on this device');
    return saved;
  };

  const applyDetection = result => {
    if (settings.soundEnabled && Array.isArray(result.events)) {
      result.events.filter(alert => alert.type !== 'entry_exit').forEach(alert => {
        if (alertSoundsPlayed.current.has(alert.id)) return;
        alertSoundsPlayed.current.add(alert.id);
        try {
          const AudioContext = window.AudioContext || window.webkitAudioContext;
          if (!AudioContext) return;
          const audio = new AudioContext();
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.value = alert.severity === 'critical' ? 880 : 660;
          gain.gain.value = 0.08;
          oscillator.connect(gain);
          gain.connect(audio.destination);
          oscillator.onended = () => audio.close();
          oscillator.start();
          oscillator.stop(audio.currentTime + 0.16);
        } catch (error) {
          console.error('Could not play alert sound:', error);
        }
      });
    }
    setAiHistory(previous => {
      const base = previous || { alerts: [], traffic: [], totals: {} };
      const events = Array.isArray(result.events) ? result.events : [];
      const alerts = [...events, ...(base.alerts || [])]
        .filter((alert, index, list) => list.findIndex(item => item.id === alert.id) === index)
        .slice(0, 100);
      return {
        ...base,
        totals: {
          ...(base.totals || {}),
          footfall: result.footfall ?? base.totals?.footfall ?? 0,
          entries: result.entries ?? base.totals?.entries ?? 0,
          exits: result.exits ?? base.totals?.exits ?? 0,
        },
        alerts,
        traffic: base.traffic || [],
        latest: result,
      };
    });
  };

  const updateAiAlert = async (id, action) => {
    try {
      await window.queuePulse.updateAiAlert({ id, action });
      await refreshAiHistory();
    } catch (error) {
      setToast(`Could not ${action} alert: ${error.message}`);
    }
  };

  const removeCamera = async id => {
    const next = { ...settings, cameras: settings.cameras.filter(camera => camera.id !== id) };
    try {
      await window.queuePulse?.stopCameraStream?.(id);
      stopUsbCamera(id);
      if (['USB webcam', 'HDMI capture card'].includes(settings.cameras.find(camera => camera.id === id)?.sourceType)) {
        await window.queuePulse?.releaseUsbCamera?.(id);
      }
      await window.queuePulse?.saveCameraCredentials?.({
        cameraId: id, username: '', password: '', remember: false,
      });
      const saved = await persistSettings(next);
      setSettings(saved);
      setDraft(saved);
      setCameraStatuses(previous => {
        const updated = { ...previous };
        delete updated[id];
        return updated;
      });
      if (selectedCameraId === id) setSelectedCameraId(saved.cameras[0]?.id || '');
      setToast('Camera profile removed');
    } catch (error) {
      setToast(`Could not remove camera: ${error.message}`);
    }
  };

  const updateCamera = (id, field, value) => {
    let changes = { [field]: value };
    if (field === 'sourceType') {
      changes = value === 'RTSP camera'
        ? { sourceType: value, deviceId: '', ipAddress: '' }
        : { sourceType: value, rtspUrl: '', ipAddress: '' };
    } else if (field === 'rtspUrl') {
      changes.ipAddress = '';
    }
    setDraft(previous => ({
      ...previous,
      cameras: previous.cameras.map(camera => camera.id === id ? { ...camera, ...changes } : camera),
    }));
  };

  const saveDiscoveredCamera = async (camera, credentials, rememberCredentials) => {
    if (settings.cameras.length >= 64) throw new Error('You can save up to 64 camera profiles on this device.');
    const duplicate = settings.cameras.find(existing =>
      (camera.deviceId && existing.deviceId === camera.deviceId)
      || (!camera.deviceId && existing.name === camera.name && existing.sourceType === camera.sourceType)
      || (camera.rtspUrl && existing.rtspUrl === camera.rtspUrl));
    if (duplicate) {
      setToast(`${duplicate.name} is already in your camera list`);
      return duplicate;
    }
    const profile = { ...camera, id: `camera-${crypto.randomUUID()}`, location: camera.location || 'Not specified' };
    if (credentials && rememberCredentials && window.queuePulse?.saveCameraCredentials) {
      await window.queuePulse.saveCameraCredentials({
        cameraId: profile.id,
        username: credentials.username,
        password: credentials.password,
        remember: true,
      });
    }
    const next = { ...settings, cameras: [...settings.cameras, profile] };
    const saved = await persistSettings(next);
    setSettings(saved);
    setDraft(saved);
    setToast(`${profile.name} added`);
    return profile;
  };

  const connectDiscoveredCamera = camera => {
    setSelectedCameraId(camera.id);
    setPage('monitor');
  };

  const updateCameraConnectionStatus = (id, status) => {
    setCameraStatuses(previous => previous[id] === status ? previous : { ...previous, [id]: status });
  };

  useEffect(() => {
    const unsubscribe = window.queuePulse?.onCameraStatus?.(status => {
      updateCameraConnectionStatus(status.id, status.status === 'connected' ? 'Connected'
        : status.status === 'reconnecting' ? 'Reconnecting'
          : status.status === 'connecting' ? 'Connecting'
          : status.status === 'error' ? 'Error' : 'Not connected');
    });
    return () => unsubscribe?.();
  }, []);

  const updateCameraAuthenticationStatus = async (id, authenticationStatus) => {
    try {
      const next = {
        ...settings,
        cameras: settings.cameras.map(camera => camera.id === id ? { ...camera, authenticationStatus } : camera),
      };
      const saved = await persistSettings(next);
      setSettings(saved);
      setDraft(saved);
    } catch (error) {
      setToast(`Could not update camera authentication status: ${error.message}`);
    }
  };

  if (!ready) return <div className="loading-screen"><div className="brand-mark"><Activity size={22}/></div><p>Starting QueuePulse AI…</p></div>;

  return (
    <div className="app-shell">
      <aside className={cx('sidebar', sidebarOpen && 'sidebar-open')}>
        <div className="brand-row">
          <div className="brand-mark"><Activity size={21} strokeWidth={2.5}/></div>
          <div className="brand-text"><span className="brand-name">QueuePulse <b>AI</b></span><span className="brand-subtitle">SHOP INTELLIGENCE</span></div>
          <button className="icon-button close-sidebar" aria-label="Close menu" onClick={() => setSidebarOpen(false)}><X size={17}/></button>
        </div>
        <button className="workspace-switcher" onClick={() => setPage('settings')}>
          <div className="workspace-avatar"><Store size={16}/></div>
          <div className="workspace-copy"><strong>{settings.shopName || 'My Shop'}</strong><span>Local workspace</span></div>
          <ChevronDown size={15} className="muted-icon"/>
        </button>
        <nav className="nav-list">
          {NAV.map(item => {
            const Icon = item.icon;
            return <React.Fragment key={item.id}>
              {item.section && <div className="nav-section-label">{item.section}</div>}
              <button className={cx('nav-item', page === item.id && 'active')} onClick={() => { setPage(item.id); setSidebarOpen(false); }}>
                <Icon size={17} strokeWidth={1.8}/><span>{item.label}</span>
                {item.count && <span className={cx('nav-count', item.count === 'DEMO' && 'demo-count')}>{item.count}</span>}
              </button>
            </React.Fragment>;
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-card"><span className="online-dot"/><div><strong>Local app</strong><span>Settings stored on device</span></div><ShieldCheck size={16} className="connection-shield"/></div>
          <button className="nav-item support-link" onClick={() => setToast('Help guide will be added in a future version.')}><LifeBuoy size={17}/><span>Help & support</span><CircleHelp size={15} className="muted-icon"/></button>
          <div className="user-profile"><div className="user-avatar">QP</div><div className="user-copy"><strong>Shop administrator</strong><span>Local administrator</span></div><MoreHorizontal size={18} className="muted-icon"/></div>
        </div>
      </aside>
      {sidebarOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}/>}

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open menu"><Menu size={19}/></button><span>QueuePulse AI</span><span className="crumb-divider">/</span><strong>{NAV.find(n => n.id === page)?.label || 'Overview'}</strong></div>
          <div className="topbar-actions">
            <div className="demo-pill"><span className="pulse-dot"/> Local AI processing</div>
            <button className="icon-button search-button" title="Search" onClick={() => document.getElementById('global-search')?.focus()}><Search size={17}/></button>
            <button className="icon-button notification-button" title="Alerts" onClick={() => setPage('alerts')}><Bell size={17}/><span/></button>
            <div className="top-avatar">SA</div>
          </div>
        </header>

        <div className="page-content">
          {page === 'dashboard' && <Dashboard settings={settings} setPage={setPage} aiHistory={aiHistory} />}
          {page === 'discovery' && <CameraDiscovery cameras={settings.cameras} cameraStatuses={cameraStatuses} onAddCamera={saveDiscoveredCamera} onConnectCamera={connectDiscoveredCamera} />}
          {page === 'cameras' && <Cameras settings={settings} draft={draft} setDraft={setDraft} cameraStatuses={cameraStatuses} updateCamera={updateCamera} onAdd={() => setPage('discovery')} onConnect={connectDiscoveredCamera} onRemove={removeCamera} onSave={saveSettings} saving={saving} />}
          {page === 'diagnostics' && <CameraDiagnostics cameras={settings.cameras} onConnectionStatus={updateCameraConnectionStatus} />}
          {page === 'monitor' && <LiveMonitor cameras={settings.cameras} selectedCameraId={selectedCameraId} cameraStatuses={cameraStatuses} settings={settings} aiHistory={aiHistory} onSaveSettings={saveDetectionSettings} onDetection={applyDetection} onRefreshHistory={refreshAiHistory} onUpdateAlert={updateAiAlert} onConnectionStatus={updateCameraConnectionStatus} onAuthenticationStatus={updateCameraAuthenticationStatus} onSelectCamera={setSelectedCameraId} onAddCamera={() => setPage('discovery')} onManageCameras={cameraId => { if (cameraId) setSelectedCameraId(cameraId); setPage('cameras'); }} onRemoveCamera={removeCamera} />}
          {page === 'analytics' && <Analytics settings={settings} cameraStatuses={cameraStatuses} aiHistory={aiHistory} error={aiHistoryError} />}
          {page === 'alerts' && <Alerts settings={settings} aiHistory={aiHistory} onUpdateAlert={updateAiAlert} error={aiHistoryError} />}
          {page === 'settings' && <SettingsPage draft={draft} changeDraft={changeDraft} onSave={saveSettings} onReset={resetSettings} saving={saving} />}
          <footer className="app-footer"><span><span className="footer-dot"/> All settings are stored locally in this MVP</span><span>QueuePulse AI <b>v0.1.0</b></span></footer>
        </div>
      </main>


      {toast && <div className="toast"><Check size={17}/><span>{toast}</span><button onClick={() => setToast('')} aria-label="Dismiss"><X size={15}/></button></div>}
    </div>
  );
}

function PageHeading({ eyebrow, title, subtitle, action }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;
}

function Dashboard({ settings, setPage, aiHistory }) {
  const latest = aiHistory?.latest || aiHistory?.traffic?.at(-1);
  const totals = aiHistory?.totals || {};
  const alerts = aiHistory?.alerts || [];
  const openAlerts = alerts.filter(alert => !alert.resolved);
  return <>
    <PageHeading eyebrow="SHOP OVERVIEW" title={`Good afternoon, ${settings.shopName || 'Shop owner'}`} subtitle="Live metrics from locally processed camera detections." action={<button className="button secondary" onClick={() => setPage('analytics')}><FileChartColumn size={16}/> View reports</button>} />
    <div className="demo-notice"><div className="notice-icon"><Activity size={18}/></div><div><strong>{latest ? 'Live AI metrics' : 'No camera analytics yet'}</strong><span>{latest ? 'Counts reflect persisted local detections. Connect a camera in Live Monitor to update them.' : 'No detections are stored yet. Connect a camera in Live Monitor to begin local analysis.'}</span></div><button onClick={() => setPage('monitor')}>Open Live Monitor <ArrowUpRight size={14}/></button></div>
    <div className="section-title-row"><h2>Live overview</h2><span className="updated-label"><span className="pulse-dot"/> Local analytics</span></div>
    <div className="metric-grid">
      <MetricCard title="People in scene" value={latest?.peopleCount ?? latest?.people ?? '—'} change={latest ? 'Latest camera frame' : 'Waiting for camera'} changeType="neutral" icon={UsersIcon} iconTone="blue" footer="Actual person detections" />
      <MetricCard title="Queue estimate" value={latest?.queueCount ?? latest?.queue ?? '—'} change="Zone intersection estimate" changeType="neutral" icon={ShoppingBag} iconTone="orange" footer="Only detected people in queue zone" />
      <MetricCard title="Total footfall" value={totals.footfall ?? 0} change="Persisted local total" changeType="neutral" icon={Camera} iconTone="purple" footer="Unique tracked people crossing line" />
      <MetricCard title="Open alerts" value={openAlerts.length} change={openAlerts.length ? 'Needs review' : 'No active alerts'} changeType={openAlerts.length ? 'danger' : 'good'} icon={Bell} iconTone="green" footer="Events from camera analysis" />
    </div>
    <div className="dashboard-grid">
      <section className="panel traffic-panel">
        <div className="panel-heading"><div><h3>Camera activity</h3><p>Persisted per-minute detection samples</p></div><button className="select-like" onClick={() => setPage('analytics')}>Reports <ArrowUpRight size={14}/></button></div>
        <TrafficChart traffic={aiHistory?.traffic || []}/>
        <div className="chart-legend"><span><i className="legend-blue"/> People detected</span><span><i className="legend-gray"/> Queue estimate</span></div>
      </section>
      <section className="panel activity-panel">
        <div className="panel-heading"><div><h3>Recent alerts</h3><p>Events generated from camera detections</p></div><button className="text-link" onClick={() => setPage('alerts')}>View all <ArrowUpRight size={14}/></button></div>
        <div className="activity-list">{alerts.slice(0, 3).map(alert => <div className="activity-item" key={alert.id}><div className="activity-icon orange"><AlertTriangle size={16}/></div><div className="activity-copy"><strong>{alert.title}</strong><span>{alert.camera} · {new Date(alert.timestamp).toLocaleString()}</span></div><span className={`status-tag ${alert.resolved ? 'green' : 'orange'}`}>{alert.resolved ? 'RESOLVED' : alert.severity.toUpperCase()}</span></div>)}{alerts.length === 0 && <div className="empty-analytics">No events recorded.</div>}</div>
        <div className="panel-bottom-link"><button onClick={() => setPage('alerts')}>Open event history <ArrowUpRight size={14}/></button></div>
      </section>
    </div>
    <div className="section-title-row lower-section"><h2>Camera profiles</h2><button className="text-link" onClick={() => setPage('cameras')}>Manage cameras <ArrowUpRight size={14}/></button></div>
    <div className="camera-mini-grid">{settings.cameras.slice(0, 3).map(camera => <div className="camera-mini-card" key={camera.id}><div className="camera-mini-preview"><div className="mini-preview-grid"/><Camera size={28} className="mini-camera-icon"/><span className="mini-preview-stamp">LOCAL PROFILE</span></div><div className="camera-mini-info"><div><strong>{camera.name}</strong><span><MapPin size={12}/>{camera.location}</span></div><span className="status-chip neutral"><span/> Not connected</span></div></div>)}</div>
  </>;
}

function UsersIcon(props) { return <Activity {...props}/>; }

function MetricCard({ title, value, change, changeType, icon: Icon, iconTone, footer }) {
  return <div className="metric-card"><div className="metric-top"><span>{title}</span><div className={`metric-icon ${iconTone}`}><Icon size={18}/></div></div><div className="metric-value">{value}</div><div className={`metric-change ${changeType}`}>{changeType === 'good' ? <ArrowDownRight size={13}/> : changeType === 'danger' ? <AlertTriangle size={13}/> : <Activity size={13}/>}<span>{change}</span></div><div className="metric-footer">{footer}</div></div>;
}

function TrafficChart({ traffic }) {
  const samples = traffic.slice(-12);
  if (!samples.length) return <div className="empty-analytics chart-empty">No camera samples recorded yet.</div>;
  const max = Math.max(1, ...samples.flatMap(row => [row.people || 0, row.queue || 0]));
  const x = index => samples.length === 1 ? 231 : index * 462 / (samples.length - 1);
  const y = value => 122 - value / max * 110;
  const peoplePoints = samples.map((row, index) => `${x(index)},${y(row.people || 0)}`).join(' ');
  const queuePoints = samples.map((row, index) => `${x(index)},${y(row.queue || 0)}`).join(' ');
  return <div className="chart-wrap real-traffic-chart"><svg viewBox="0 0 462 132" preserveAspectRatio="none" className="traffic-svg" aria-label="Stored live camera detections"><polyline points={peoplePoints} fill="none" stroke="#5b8def" strokeWidth="2.5"/><polyline points={queuePoints} fill="none" stroke="#9ca9bb" strokeWidth="2" strokeDasharray="5 4"/></svg><div className="chart-x-labels">{samples.map(row => <span key={row.minute}>{new Date(`${row.minute}:00Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>)}</div></div>;
}

function CameraDiscovery({ cameras, cameraStatuses, onAddCamera, onConnectCamera }) {
  const [localDevices, setLocalDevices] = useState([]);
  const [networkDevices, setNetworkDevices] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [error, setError] = useState('');
  const [credentialsDevice, setCredentialsDevice] = useState(null);
  const [credentials, setCredentials] = useState({ username: '', password: '', remember: true });
  const [profiles, setProfiles] = useState([]);
  const [profilesDevice, setProfilesDevice] = useState('');
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [manual, setManual] = useState({ name: '', rtspUrl: '', username: '', password: '', remember: true });
  const [manualSaving, setManualSaving] = useState(false);
  const bridge = window.queuePulse;

  const refreshLocalDevices = async () => {
    setLoadingLocal(true);
    setError('');
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        throw new Error('Windows video device enumeration is unavailable in this app.');
      }
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
      setLocalDevices(inputs);
      return inputs;
    } catch (deviceError) {
      setError(deviceError.message || 'Could not enumerate Windows video devices.');
      return [];
    } finally {
      setLoadingLocal(false);
    }
  };

  useEffect(() => {
    refreshLocalDevices();
    return () => {
      bridge?.stopCameraDiscovery?.().catch(error => console.error('Could not stop camera discovery:', error));
    };
  }, []);

  const startDiscovery = async () => {
    setScanning(true);
    setError('');
    try {
      if (!bridge?.discoverCameras) throw new Error('Network camera discovery is available in the Electron desktop app.');
      const [devices] = await Promise.all([
        bridge.discoverCameras(),
        refreshLocalDevices(),
      ]);
      setNetworkDevices(devices);
    } catch (scanError) {
      setError(scanError.message || 'ONVIF discovery failed.');
    } finally {
      setScanning(false);
    }
  };

  const stopDiscovery = async () => {
    try {
      await bridge?.stopCameraDiscovery?.();
    } catch (stopError) {
      setError(stopError.message || 'Could not stop camera discovery.');
    }
    setScanning(false);
  };

  const savedWindowsCamera = device => cameras.find(camera => device.deviceId && camera.deviceId === device.deviceId);
  const addWindowsCamera = async device => {
    const detectedName = device.label || `Windows video device ${localDevices.indexOf(device) + 1}`;
    const sourceType = /hdmi|capture/i.test(detectedName) ? 'HDMI capture card' : 'USB webcam';
    const existing = savedWindowsCamera(device);
    if (existing) {
      onConnectCamera(existing);
      return;
    }
    try {
      const added = await onAddCamera({
        name: detectedName,
        sourceType,
        deviceId: device.deviceId || '',
        manufacturer: '',
        model: '',
        authenticationStatus: 'Not required',
        status: 'Not connected',
      });
      onConnectCamera(added);
    } catch (addError) {
      setError(addError.message || 'Could not add this Windows camera.');
    }
  };

  const loadOnvifProfiles = async event => {
    event.preventDefault();
    if (!credentialsDevice) return;
    setProfilesLoading(true);
    setError('');
    try {
      if (!bridge?.getOnvifProfiles) throw new Error('ONVIF stream discovery is available in the Electron desktop app.');
      const result = await bridge.getOnvifProfiles({
        ipAddress: credentialsDevice.ipAddress,
        xaddr: credentialsDevice.xaddr,
        username: credentials.username,
        password: credentials.password,
      });
      setProfiles(result.profiles || []);
      setProfilesDevice(credentialsDevice.id);
      setNetworkDevices(previous => previous.map(device => device.id === credentialsDevice.id ? {
        ...device,
        manufacturer: result.manufacturer || device.manufacturer,
        model: result.model || device.model,
        authenticationStatus: credentials.username || credentials.password
          ? (credentials.remember ? 'Configured' : 'Required') : 'Not required',
      } : device));
      if (!(result.profiles || []).length) {
        setError('The device returned no compatible RTSP profiles. Check its ONVIF permissions or add its RTSP URL manually.');
      } else if (result.failedProfiles) {
        setError(`${result.failedProfiles} ONVIF channel${result.failedProfiles === 1 ? '' : 's'} could not provide an RTSP stream URI.`);
      }
      setCredentialsDevice(null);
    } catch (profileError) {
      setError(profileError.message || 'Could not read ONVIF stream profiles.');
    } finally {
      setProfilesLoading(false);
    }
  };

  const addOnvifProfile = async (device, profile) => {
    try {
      const idSuffix = `${device.id}-${profiles.indexOf(profile) + 1}`.replace(/[^\w.-]/g, '-').slice(0, 60);
      const added = await onAddCamera({
        id: idSuffix,
        name: profile.name,
        sourceType: 'RTSP camera',
        ipAddress: device.ipAddress,
        manufacturer: device.manufacturer,
        model: device.model,
        rtspUrl: profile.streamUrl,
        authenticationStatus: credentials.username || credentials.password
          ? (credentials.remember ? 'Configured' : 'Required') : 'Not required',
        status: 'Not connected',
      }, credentials.username || credentials.password ? credentials : null, credentials.remember);
      if (added) {
        setToastMessage(`${profile.name} added from ${device.name}`);
      }
    } catch (addError) {
      setError(addError.message || 'Could not add the ONVIF stream.');
    }
  };

  const [toastMessage, setToastMessage] = useState('');
  const addManualRtsp = async event => {
    event.preventDefault();
    setManualSaving(true);
    setError('');
    try {
      const parsed = new URL(manual.rtspUrl);
      if (parsed.protocol !== 'rtsp:' || parsed.username || parsed.password || !parsed.hostname) {
        throw new Error('Enter an RTSP URL without embedded credentials; provide credentials in the separate fields.');
      }
      if (Boolean(manual.username) !== Boolean(manual.password)) {
        throw new Error('Provide both an RTSP username and password, or leave both blank.');
      }
      const octets = parsed.hostname.split('.').map(Number);
      const privateAddress = octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
        && (octets[0] === 127
          || octets[0] === 10
          || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
          || (octets[0] === 192 && octets[1] === 168)
          || (octets[0] === 169 && octets[1] === 254));
      if (!privateAddress) throw new Error("Use the camera's private local IPv4 address in its RTSP URL.");
      const added = await onAddCamera({
        name: manual.name.trim() || `RTSP camera at ${parsed.hostname}`,
        sourceType: 'RTSP camera',
        ipAddress: parsed.hostname,
        manufacturer: '',
        model: '',
        rtspUrl: parsed.href,
        authenticationStatus: manual.username || manual.password
          ? (manual.remember ? 'Configured' : 'Required') : 'Unknown',
        status: 'Not connected',
      }, manual.username || manual.password ? manual : null, manual.remember);
      if (added) setManual({ name: '', rtspUrl: '', username: '', password: '', remember: true });
    } catch (addError) {
      setError(addError.message || 'Could not save this RTSP camera.');
    } finally {
      setManualSaving(false);
    }
  };

  return <>
    <PageHeading eyebrow="CAMERA DISCOVERY" title="Find and connect cameras" subtitle="Discovery runs only when requested. Video streams are processed by QueuePulse AI on this computer." action={<div className="discovery-actions">{scanning ? <button className="button secondary" onClick={stopDiscovery}><WifiOff size={15}/> Stop discovery</button> : <button className="button primary" onClick={startDiscovery}><Search size={15}/> Start discovery</button>}<button className="button secondary" onClick={startDiscovery} disabled={scanning || loadingLocal}><RefreshCw size={14}/> Refresh</button></div>} />
    <div className="demo-notice compact"><div className="notice-icon"><ShieldCheck size={17}/></div><div><strong>Authorized, bounded device discovery</strong><span>Windows cameras are listed locally. Network discovery sends one ONVIF WS-Discovery probe and stops automatically after 3.5 seconds; it does not scan ports or try passwords. Multiple profiles can be saved; the current AI worker processes one live camera at a time.</span></div></div>
    {error && <div className="info-callout" role="alert"><AlertTriangle size={16}/><span>{error}</span></div>}
    {toastMessage && <div className="info-callout"><Check size={16}/><span>{toastMessage}</span></div>}
    <div className="panel discovery-panel">
      <div className="panel-heading"><div><h3>Windows video devices <span className="count-pill">{localDevices.length}</span></h3><p>USB webcams, DroidCam, built-in cameras, and HDMI capture cards exposed as Windows video inputs.</p></div><button className="button secondary small" onClick={refreshLocalDevices} disabled={loadingLocal}><RefreshCw size={13}/> Refresh devices</button></div>
      {localDevices.length ? <div className="discovery-list">{localDevices.map((device, index) => {
        const existing = savedWindowsCamera(device);
        const label = device.label || `Windows video device ${index + 1}`;
        const captureCard = /hdmi|capture/i.test(label);
        return <div className="discovery-row" key={device.deviceId || `${label}-${index}`}>
          <div className="discovery-icon"><Camera size={18}/></div>
          <div className="discovery-device"><strong>{label}</strong><span>{captureCard ? 'HDMI capture device · Windows video input' : 'Windows video input'}{device.deviceId ? ` · ${device.deviceId.slice(0, 12)}` : ''}</span></div>
          <div className="discovery-metadata"><small>WINDOWS DEVICE NAME</small><span>{label}</span><small>CONNECTION</small><span>{cameraStatuses[existing?.id] || existing?.status || 'Not connected'}</span></div>
          <div className="discovery-metadata"><small>AUTHENTICATION</small><span>Not required</span></div>
          <button className="button primary small" onClick={() => addWindowsCamera(device)}>{existing ? 'Connect' : 'Add & connect'}</button>
        </div>;
      })}</div> : <div className="discovery-empty"><Camera size={23}/><strong>{loadingLocal ? 'Checking Windows devices…' : 'No Windows video inputs found'}</strong><span>Connect the camera, start DroidCam, or check Windows camera privacy permissions, then refresh.</span></div>}
    </div>
    <div className="panel discovery-panel">
      <div className="panel-heading"><div><h3>ONVIF network cameras and recorders <span className="count-pill">{networkDevices.length}</span></h3><p>Compatible IP cameras and NVR/DVR devices appear when they answer ONVIF WS-Discovery on the local network.</p></div>{scanning && <span className="status-chip neutral"><span/> Searching local network…</span>}</div>
      {networkDevices.length ? <div className="discovery-list">{networkDevices.map(device => <React.Fragment key={device.id}>
        <div className="discovery-row">
          <div className="discovery-icon network"><Wifi size={18}/></div>
          <div className="discovery-device"><strong>{device.name}</strong><span>{device.ipAddress} · ONVIF device</span></div>
          <div className="discovery-metadata"><small>MANUFACTURER / MODEL</small><span>{device.manufacturer || 'Unknown'}{device.model ? ` / ${device.model}` : ''}</span></div>
          <div className="discovery-metadata"><small>AUTHENTICATION</small><span>{device.authenticationStatus}</span></div>
          <button className="button secondary small" onClick={() => { setCredentialsDevice(device); setProfiles([]); setCredentials({ username: '', password: '', remember: true }); }}>Get streams / channels</button>
        </div>
        {profilesDevice === device.id && profiles.map((profile, index) => {
          const saved = cameras.find(camera => camera.rtspUrl === profile.streamUrl);
          return <div className="discovery-channel" key={`${device.id}-${index}`}><span><Video size={14}/>{profile.name}</span><code>{profile.streamUrl}</code>{saved ? <button className="button secondary small" onClick={() => onConnectCamera(saved)}>Connect</button> : <button className="button primary small" onClick={() => addOnvifProfile(device, profile)}>Add channel</button>}</div>;
        })}
      </React.Fragment>)}</div> : <div className="discovery-empty"><Wifi size={23}/><strong>{scanning ? 'Waiting for ONVIF responses…' : 'No network cameras discovered yet'}</strong><span>Make sure the camera/NVR is on this LAN and has ONVIF enabled. Non-ONVIF devices can be added below with their vendor-provided RTSP URL.</span></div>}
    </div>
    <div className="panel manual-rtsp-panel">
      <div className="panel-heading"><div><h3>Manual RTSP configuration</h3><p>Fallback for non-ONVIF cameras or systems that do not advertise with WS-Discovery.</p></div><Radio size={18} className="muted-icon"/></div>
      <form className="manual-rtsp-form" onSubmit={addManualRtsp}>
        <label className="field-label">Camera name<input maxLength="60" value={manual.name} onChange={event => setManual(previous => ({ ...previous, name: event.target.value }))} placeholder="e.g. Front entrance"/></label>
        <label className="field-label">RTSP stream URL<input required value={manual.rtspUrl} onChange={event => setManual(previous => ({ ...previous, rtspUrl: event.target.value }))} placeholder="rtsp://192.168.1.40:554/stream1" autoComplete="url"/></label>
        <label className="field-label">Username<input value={manual.username} onChange={event => setManual(previous => ({ ...previous, username: event.target.value }))} autoComplete="username"/></label>
        <label className="field-label">Password<input type="password" value={manual.password} onChange={event => setManual(previous => ({ ...previous, password: event.target.value }))} autoComplete="new-password"/></label>
        <label className="credential-remember"><input type="checkbox" checked={manual.remember} onChange={event => setManual(previous => ({ ...previous, remember: event.target.checked }))}/> Remember credentials encrypted by Windows</label>
        <button className="button primary" type="submit" disabled={manualSaving}>{manualSaving ? 'Saving…' : 'Add RTSP camera'}</button>
      </form>
    </div>
    {credentialsDevice && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setCredentialsDevice(null); }}>
      <form className="modal-card" onSubmit={loadOnvifProfiles}>
        <div className="modal-heading"><div><span className="eyebrow">ONVIF AUTHENTICATION</span><h2>{credentialsDevice.name}</h2><p>{credentialsDevice.ipAddress} · Credentials are sent only to this discovered camera.</p></div><button type="button" className="icon-button" onClick={() => setCredentialsDevice(null)} aria-label="Close"><X size={18}/></button></div>
        <label className="field-label">Username<input autoFocus autoComplete="username" value={credentials.username} onChange={event => setCredentials(previous => ({ ...previous, username: event.target.value }))}/></label>
        <label className="field-label">Password<input type="password" autoComplete="current-password" value={credentials.password} onChange={event => setCredentials(previous => ({ ...previous, password: event.target.value }))}/></label>
        <label className="credential-remember"><input type="checkbox" checked={credentials.remember} onChange={event => setCredentials(previous => ({ ...previous, remember: event.target.checked }))}/> Remember credentials encrypted by Windows when adding a stream</label>
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setCredentialsDevice(null)}>Cancel</button><button type="submit" className="button primary" disabled={profilesLoading}>{profilesLoading ? 'Reading channels…' : 'Read ONVIF streams'}</button></div>
      </form>
    </div>}
  </>;
}

function Cameras({ settings, draft, cameraStatuses, setDraft, updateCamera, onAdd, onConnect, onRemove, onSave, saving }) {
  return <>
    <PageHeading eyebrow="DEVICE MANAGEMENT" title="Camera profiles" subtitle="Manage discovered Windows video inputs and network camera streams." action={<button className="button primary" onClick={onAdd}><Search size={16}/> Discover cameras</button>} />
    <div className="demo-notice compact"><div className="notice-icon"><Camera size={17}/></div><div><strong>Need to add or find a camera?</strong><span>Open Camera discovery to find Windows cameras, scan ONVIF devices on demand, or enter an RTSP URL.</span></div></div>
    <div className="camera-table panel"><div className="panel-heading"><div><h3>Camera profiles <span className="count-pill">{settings.cameras.length}</span></h3><p>Saved on this computer</p></div><button className="button secondary small" onClick={() => setDraft(settings)}><RefreshCw size={14}/> Discard edits</button></div>
      {draft.cameras.length === 0 ? <div className="empty-state"><div className="empty-icon"><Camera size={24}/></div><strong>No camera profiles yet</strong><span>Discover local devices or add an RTSP stream.</span><button className="button primary" onClick={onAdd}><Search size={15}/> Discover cameras</button></div> : <div className="camera-list">{draft.cameras.map(camera => <div className="camera-row" key={camera.id}>
        <div className="camera-row-icon"><Video size={19}/></div>
        <div className="camera-edit-fields">
          <label>Camera name<input aria-label={`${camera.name} name`} maxLength="60" value={camera.name} onChange={event => updateCamera(camera.id, 'name', event.target.value)}/></label>
          <label>Location<input aria-label={`${camera.name} location`} maxLength="80" value={camera.location} onChange={event => updateCamera(camera.id, 'location', event.target.value)}/></label>
          <label>Video source<select aria-label={`${camera.name} video source`} value={camera.sourceType} onChange={event => updateCamera(camera.id, 'sourceType', event.target.value)}><option>RTSP camera</option><option>USB webcam</option><option>HDMI capture card</option><option>Demo feed</option></select></label>
          {camera.sourceType === 'RTSP camera'
            ? <>
              <label className="camera-source-field">RTSP URL<input aria-label={`${camera.name} RTSP URL`} value={camera.rtspUrl || ''} onChange={event => updateCamera(camera.id, 'rtspUrl', event.target.value)} placeholder="rtsp://192.168.1.20/stream"/></label>
              <label>RTSP transport<select aria-label={`${camera.name} RTSP transport`} value={camera.rtspTransport || 'tcp'} onChange={event => updateCamera(camera.id, 'rtspTransport', event.target.value)}><option value="tcp">TCP (recommended)</option><option value="udp">UDP</option></select></label>
              <label>Processing FPS<select aria-label={`${camera.name} processing FPS`} value={camera.processingFps || 3} onChange={event => updateCamera(camera.id, 'processingFps', Number(event.target.value))}>{[1, 2, 3, 5, 10, 15, 20, 30].map(fps => <option key={fps} value={fps}>{fps} FPS</option>)}</select></label>
            </>
            : <label className="camera-source-field">Device identifier<input aria-label={`${camera.name} device identifier`} maxLength="256" value={camera.deviceId || ''} onChange={event => updateCamera(camera.id, 'deviceId', event.target.value)} placeholder="Windows video device identifier"/></label>}
          <span className="camera-id">Camera ID: {camera.id}</span>
        </div>
        <div className="camera-row-actions">
          <span className={`status-chip ${cameraStatuses[camera.id] === 'Connected' ? 'positive' : 'neutral'}`}><span/>{cameraStatuses[camera.id] || (['Connected', 'Connecting', 'Reconnecting', 'Error'].includes(camera.status) ? camera.status : 'Not connected')}</span>
          <small>{[camera.manufacturer, camera.model].filter(Boolean).join(' ') || 'Camera details unavailable'}</small>
          {camera.sourceType === 'RTSP camera' && <small>The vendor’s URL path selects main/sub-stream; ONVIF may expose multiple profiles.</small>}
          <button className="button secondary small" onClick={() => onConnect(camera)}><Wifi size={13}/> Select camera</button>
          <button className="icon-button remove-camera" aria-label={`Remove ${camera.name}`} title="Remove camera profile" onClick={() => onRemove(camera.id)}><X size={16}/></button>
        </div>
      </div>)}</div>}
      <div className="table-footer"><span>Camera profiles: <b>{draft.cameras.length}</b></span><button className="button primary" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save camera changes'}</button></div>
    </div>
    <div className="two-column-notes"><div className="panel note-panel"><div className="note-icon blue"><Wifi size={18}/></div><div><h3>Local centralized AI</h3><p>USB and RTSP frames are sent to the same local QueuePulse AI worker. Camera devices do not run their own QueuePulse analytics.</p></div></div><div className="panel note-panel"><div className="note-icon green"><ShieldCheck size={18}/></div><div><h3>Privacy by design</h3><p>Video analysis stays on this computer. The app stores event summaries and evidence snapshots locally; it does not use facial recognition.</p></div></div></div>
  </>;
}

async function measureWindowsCameraStream(stream) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    let playTimeout;
    try {
      await Promise.race([
        video.play(),
        new Promise((_, reject) => {
          playTimeout = setTimeout(() => reject(new Error('The Windows camera did not start video playback within five seconds.')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(playTimeout);
    }
    const fps = await new Promise(resolve => {
      if (typeof video.requestVideoFrameCallback !== 'function') {
        resolve(null);
        return;
      }
      let firstFrame;
      let frameCount = 0;
      const timeout = setTimeout(() => resolve(null), 3000);
      const measure = timestamp => {
        if (firstFrame == null) firstFrame = timestamp;
        frameCount += 1;
        if (timestamp - firstFrame >= 1000) {
          clearTimeout(timeout);
          resolve(Number((((frameCount - 1) * 1000) / (timestamp - firstFrame)).toFixed(2)));
          return;
        }
        video.requestVideoFrameCallback(measure);
      };
      video.requestVideoFrameCallback(measure);
    });
    if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
      throw new Error('The Windows camera opened but has not delivered a decodable video frame.');
    }
    return { width: video.videoWidth, height: video.videoHeight, fps };
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

function usbDiagnosticsResult(camera, measurements) {
  return {
    camera: {
      id: camera.id,
      name: camera.name,
      ipAddress: '',
      manufacturer: camera.manufacturer || 'Unknown',
      model: camera.model || '',
      connectionType: camera.sourceType,
      status: 'connected',
      rtsp: null,
      authenticationStatus: 'Not required',
      video: {
        decoding: 'Decoded',
        resolution: `${measurements.width} × ${measurements.height}`,
        width: measurements.width,
        height: measurements.height,
        fps: measurements.fps,
        codec: 'Windows media device',
        suspectedBlackFrame: false,
        lastFrameAt: new Date().toISOString(),
        frameAgeMs: 0,
      },
      error: null,
      detail: 'Windows video device delivered a decodable frame.',
    },
    generatedAt: new Date().toISOString(),
  };
}

async function reconnectWindowsCamera(camera, bridge) {
  stopUsbCamera(camera.id);
  await bridge?.releaseUsbCamera?.(camera.id);
  await bridge?.reserveUsbCamera?.(camera.id);
  let stream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Windows camera access is unavailable. Check Windows camera privacy permissions.');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: camera.deviceId ? { deviceId: { exact: camera.deviceId } } : true,
      audio: false,
    });
    const measurements = await measureWindowsCameraStream(stream);
    usbCameraStreams.set(camera.id, stream);
    monitorUsbCamera(camera.id, stream);
    stream.getVideoTracks().forEach(track => {
      track.addEventListener('ended', () => {
        if (usbCameraStreams.get(camera.id) !== stream) return;
        stopUsbCameraMonitor(camera.id);
        usbCameraStreams.delete(camera.id);
        Promise.resolve(bridge?.releaseUsbCamera?.(camera.id))
          .catch(error => console.error('Could not release disconnected USB camera:', error));
        Promise.resolve(bridge?.recordAiSystemAlert?.({
          type: 'camera_disconnected',
          detail: 'The Windows video input stopped delivering frames.',
          camera: camera.name || 'Webcam',
          cameraId: camera.id,
        })).catch(error => console.error('Could not record USB camera disconnect alert:', error));
      }, { once: true });
    });
    return usbDiagnosticsResult(camera, measurements);
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    await Promise.resolve(bridge?.releaseUsbCamera?.(camera.id))
      .catch(releaseError => console.error('Could not release failed USB camera reconnect:', releaseError));
    throw error;
  }
}

async function testWindowsCamera(camera, bridge) {
  let stream = usbCameraStreams.get(camera.id);
  let ownedStream = false;
  let reservationCreated = false;
  if (!stream?.getVideoTracks().some(track => track.readyState === 'live')) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Windows camera access is unavailable. Check Windows camera privacy permissions.');
    }
    await bridge?.reserveUsbCamera?.(camera.id);
    reservationCreated = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: camera.deviceId ? { deviceId: { exact: camera.deviceId } } : true,
        audio: false,
      });
    } catch (error) {
      await Promise.resolve(bridge?.releaseUsbCamera?.(camera.id))
        .catch(releaseError => console.error('Could not release failed camera test reservation:', releaseError));
      throw error;
    }
    ownedStream = true;
  }
  if (!stream) throw new Error('The Windows camera did not provide a video stream.');

  try {
    const measurements = await measureWindowsCameraStream(stream);
    return usbDiagnosticsResult(camera, measurements);
  } finally {
    if (ownedStream) stream.getTracks().forEach(track => track.stop());
    if (reservationCreated) {
      await Promise.resolve(bridge?.releaseUsbCamera?.(camera.id))
        .catch(error => console.error('Could not release temporary camera test reservation:', error));
    }
  }
}

function CameraDiagnostics({ cameras, onConnectionStatus }) {
  const [cameraId, setCameraId] = useState(cameras[0]?.id || '');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [credentials, setCredentials] = useState({ username: '', password: '', remember: true });
  const bridge = window.queuePulse;
  const camera = cameras.find(item => item.id === cameraId);

  useEffect(() => {
    if (cameras.length && !cameras.some(item => item.id === cameraId)) setCameraId(cameras[0].id);
  }, [cameras, cameraId]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (!cameraId || !bridge?.getCameraDiagnostics) return;
      try {
        const diagnostics = await bridge.getCameraDiagnostics(cameraId);
        if (!active) return;
        setReport(diagnostics);
        setError('');
        const status = diagnostics.camera.status;
        onConnectionStatus(cameraId, status === 'connected' ? 'Connected'
          : status === 'connecting' ? 'Connecting'
            : status === 'reconnecting' ? 'Reconnecting'
              : status === 'error' ? 'Error' : 'Not connected');
      } catch (refreshError) {
        if (active) setError(`Could not load camera diagnostics: ${refreshError.message}`);
      }
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [cameraId, bridge, onConnectionStatus]);

  const runAction = async nextAction => {
    if (!camera) return;
    setAction(nextAction);
    setError('');
    try {
      let result;
      if (['USB webcam', 'HDMI capture card'].includes(camera.sourceType)) {
        result = nextAction === 'test'
          ? await testWindowsCamera(camera, bridge)
          : await reconnectWindowsCamera(camera, bridge);
        const base = await bridge?.getCameraDiagnostics?.(camera.id);
        result.aiWorker = base?.aiWorker || { status: 'disconnected', detail: 'Local AI worker is not processing frames.' };
        result.resources = base?.resources || null;
      } else if (nextAction === 'test') {
        result = await bridge.testCameraConnection({
          cameraId: camera.id,
          username: credentials.username,
          password: credentials.password,
          remember: credentials.remember,
        });
      } else {
        const request = {
          cameraId: camera.id,
          username: credentials.username,
          password: credentials.password,
          remember: credentials.remember,
        };
        if (nextAction === 'retry') await bridge.retryCameraConnection(request);
        else await bridge.reconnectCamera(request);
        result = await bridge.getCameraDiagnostics(camera.id);
      }
      setReport(result);
      const status = result.camera.status;
      onConnectionStatus(camera.id, status === 'connected' ? 'Connected'
        : status === 'connecting' ? 'Connecting'
          : status === 'reconnecting' ? 'Reconnecting'
            : status === 'error' ? 'Error' : 'Not connected');
      setShowErrorDetails(Boolean(result.camera.error));
      setCredentials({ username: '', password: '', remember: true });
    } catch (actionError) {
      setError(actionError.message || 'The camera action failed.');
      setShowErrorDetails(true);
    } finally {
      setAction('');
    }
  };

  const exportReport = () => {
    if (!report || !camera) return;
    const payload = JSON.stringify({
      product: 'QueuePulse AI',
      reportType: 'camera-diagnostics',
      generatedAt: report.generatedAt,
      camera: report.camera,
      aiWorker: report.aiWorker,
      resources: report.resources,
    }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `queuepulse-camera-diagnostics-${camera.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const value = report?.camera;
  const errorDetails = value?.error;
  const resource = report?.resources;
  const frame = value?.video;
  const memoryMiB = bytes => Number.isFinite(bytes) ? `${(bytes / (1024 * 1024)).toFixed(0)} MiB` : 'Unavailable';

  return <>
    <PageHeading eyebrow="CAMERA HEALTH" title="Camera diagnostics" subtitle="Run a real local network and decoded-frame check. Testing one profile does not stop other cameras." action={<button className="button secondary" onClick={exportReport} disabled={!report}><Download size={15}/> Export diagnostics</button>} />
    <div className="panel diagnostic-panel">
      <div className="diagnostic-toolbar">
        <label className="field-label">Camera profile<select value={cameraId} onChange={event => { setCameraId(event.target.value); setReport(null); }}><option value="">Select a camera</option>{cameras.map(item => <option key={item.id} value={item.id}>{item.name} · {item.sourceType}</option>)}</select></label>
        <span className={`status-chip ${value?.status === 'connected' ? 'positive' : 'neutral'}`}><span/>{value?.status || 'Not checked'}</span>
      </div>
      {!camera && <div className="discovery-empty"><Camera size={22}/><strong>No camera profiles available</strong><span>Add a camera profile before running diagnostics.</span></div>}
      {camera && <>
        <div className="diagnostic-actions">
          <button className="button primary small" disabled={Boolean(action)} onClick={() => runAction('test')}><Wifi size={14}/>{action === 'test' ? 'Testing…' : 'Test connection'}</button>
          <button className="button secondary small" disabled={Boolean(action)} onClick={() => runAction('retry')}><RefreshCw size={14}/>{action === 'retry' ? 'Retrying…' : 'Retry connection'}</button>
          <button className="button secondary small" disabled={Boolean(action)} onClick={() => runAction('reconnect')}><RefreshCw size={14}/>{action === 'reconnect' ? 'Reconnecting…' : 'Reconnect camera'}</button>
        </div>
        {camera.sourceType === 'RTSP camera' && <div className="diagnostic-credentials">
          <label className="field-label">RTSP username<input autoComplete="username" value={credentials.username} onChange={event => setCredentials(previous => ({ ...previous, username: event.target.value }))}/></label>
          <label className="field-label">RTSP password<input type="password" autoComplete="current-password" value={credentials.password} onChange={event => setCredentials(previous => ({ ...previous, password: event.target.value }))}/></label>
          <label className="credential-remember"><input type="checkbox" checked={credentials.remember} onChange={event => setCredentials(previous => ({ ...previous, remember: event.target.checked }))}/> Remember credentials encrypted by Windows</label>
        </div>}
        {error && <div className="info-callout" role="alert"><AlertTriangle size={16}/><span>{error}</span></div>}
        {value && <>
          <div className="diagnostic-grid">
            <section className="panel diagnostic-card"><h3>Camera and stream</h3>
              <DiagnosticRow label="Name" value={value.name}/>
              <DiagnosticRow label="IP address" value={value.ipAddress || 'Not applicable'}/>
              <DiagnosticRow label="Manufacturer / model" value={[value.manufacturer, value.model].filter(item => item && item !== 'Unknown').join(' / ') || 'Unknown'}/>
              <DiagnosticRow label="Connection type" value={value.connectionType}/>
              <DiagnosticRow label="RTSP port" value={value.rtsp ? `${value.rtsp.port} · ${value.rtsp.reachable == null ? 'Not tested' : value.rtsp.reachable ? `Reachable (${value.rtsp.latencyMs} ms)` : 'Not reachable'}` : 'Not applicable'}/>
              <DiagnosticRow label="Transport" value={value.rtsp?.transport?.toUpperCase() || 'Windows media device'}/>
              <DiagnosticRow label="Authentication" value={value.authenticationStatus}/>
            </section>
            <section className="panel diagnostic-card"><h3>Decoded video health</h3>
              <DiagnosticRow label="Video decoding" value={frame?.decoding || 'Not tested'}/>
              <DiagnosticRow label="Resolution" value={frame?.resolution || 'No frame received'}/>
              <DiagnosticRow label="Actual received FPS" value={frame?.fps == null ? 'Measuring / unavailable' : `${frame.fps.toFixed(2)} FPS`}/>
              <DiagnosticRow label="Codec" value={frame?.codec || 'Unknown'}/>
              <DiagnosticRow label="Last received frame" value={frame?.lastFrameAt ? new Date(frame.lastFrameAt).toLocaleString() : 'No frame received'}/>
              {frame?.suspectedBlackFrame && <p className="diagnostic-warning"><AlertTriangle size={14}/> This frame appears nearly black. Check camera exposure, lens cover, and night mode.</p>}
              {frame?.fps != null && frame.fps < 1 && <p className="diagnostic-warning"><AlertTriangle size={14}/> Low frame delivery rate detected.</p>}
              <DiagnosticRow label="AI worker" value={report?.aiWorker?.status || 'Unavailable'}/>
            </section>
            <section className="panel diagnostic-card"><h3>System resources</h3>
              <DiagnosticRow label="System CPU usage" value={resource?.cpuUsagePercent == null ? 'Unavailable' : `${resource.cpuUsagePercent}%`}/>
              <DiagnosticRow label="QueuePulse process memory" value={memoryMiB(resource?.processMemoryBytes)}/>
              <DiagnosticRow label="Available system memory" value={`${memoryMiB(resource?.systemMemoryFreeBytes)} / ${memoryMiB(resource?.systemMemoryTotalBytes)}`}/>
              <DiagnosticRow label="Camera capacity" value={resource ? `${resource.activeCameras} active / ${resource.cameraLimit} maximum (${resource.availableCameraSlots} slots free)` : 'Unavailable'}/>
              <DiagnosticRow label="Resource status" value={resource ? resource.available ? 'Available' : 'Low memory or camera limit reached' : 'Unavailable'}/>
            </section>
          </div>
          {(errorDetails || value.detail) && <section className="diagnostic-error panel">
            <div><h3>{errorDetails?.message || value.detail}</h3><p>{errorDetails ? 'Review these steps before reconnecting.' : 'No current camera failure has been reported.'}</p></div>
            {errorDetails && <button className="button secondary small" onClick={() => setShowErrorDetails(previous => !previous)}>{showErrorDetails ? 'Hide error details' : 'View error details'}</button>}
            {showErrorDetails && errorDetails && <ul>{errorDetails.troubleshooting.map(step => <li key={step}>{step}</li>)}</ul>}
          </section>}
        </>}
        <p className="diagnostic-footnote">Diagnostic export excludes camera credentials and RTSP URLs. Windows Firewall may block camera traffic; permit QueuePulse on the appropriate private network and confirm RTSP is enabled on the camera/NVR.</p>
      </>}
    </div>
  </>;
}

function DiagnosticRow({ label, value }) {
  return <div className="diagnostic-row"><span>{label}</span><strong>{value || 'Unavailable'}</strong></div>;
}

function LiveMonitor({ cameras, selectedCameraId, cameraStatuses, settings, aiHistory, onSaveSettings, onDetection, onRefreshHistory, onUpdateAlert, onConnectionStatus, onAuthenticationStatus, onSelectCamera, onAddCamera, onManageCameras, onRemoveCamera }) {
  const initialCameraId = selectedCameraId || cameras.find(camera => camera.sourceType === 'USB webcam')?.id || cameras[0]?.id || '';
  const initialCamera = cameras.find(camera => camera.id === initialCameraId);
  const defaultConfiguration = {
    queueZone: settings.queueZone,
    detectionConfidence: settings.detectionConfidence,
    countingLine: settings.countingLine,
    restrictedZones: settings.restrictedZones,
    loiteringZones: settings.loiteringZones,
    crowdZones: settings.crowdZones,
  };
  const [activeCamera, setActiveCamera] = useState(initialCameraId);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [localVideoHealth, setLocalVideoHealth] = useState('waiting');
  const [connecting, setConnecting] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [remoteFrame, setRemoteFrame] = useState('');
  const [remoteStatus, setRemoteStatus] = useState('disconnected');
  const [remoteCredentialsOpen, setRemoteCredentialsOpen] = useState(false);
  const [remoteCredentials, setRemoteCredentials] = useState({ username: '', password: '', remember: true });
  const [workerStatus, setWorkerStatus] = useState({ status: 'disconnected', detail: '' });
  const [workerError, setWorkerError] = useState('');
  const [detection, setDetection] = useState(null);
  const [configDraft, setConfigDraft] = useState(initialCamera?.configuration || defaultConfiguration);
  const [savingConfig, setSavingConfig] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const streamRef = useRef(null);
  const localVideoHealthRef = useRef('waiting');
  const localLastVideoTimeRef = useRef(0);
  const lastAiVideoTimeRef = useRef(-1);
  const connectingRef = useRef(false);
  const cameraRequestRef = useRef(0);
  const frameBusyRef = useRef(false);
  const aiStopTimerRef = useRef(null);
  const remoteLastSentRef = useRef('');
  const remoteAuthStatusRef = useRef('Unknown');
  const remoteAuthStatusReportedRef = useRef(false);
  const detectionFailureRef = useRef(false);
  const dragRef = useRef(null);
  const onDetectionRef = useRef(onDetection);
  const onConnectionStatusRef = useRef(onConnectionStatus);
  const onAuthenticationStatusRef = useRef(onAuthenticationStatus);
  const camera = cameras.find(item => item.id === activeCamera) || cameras[0];
  const bridge = window.queuePulse;
  const isRemoteCamera = camera?.sourceType === 'RTSP camera';
  const activeCameraRef = useRef(camera);
  activeCameraRef.current = camera;
  const workerConnected = workerStatus.status === 'connected';
  const savedConfiguration = camera?.configuration || defaultConfiguration;
  const zoneDraft = configDraft.queueZone;
  const zoneIsDirty = JSON.stringify(configDraft) !== JSON.stringify(savedConfiguration);

  const stopTracks = () => {
    cameraRequestRef.current += 1;
    if (isRemoteCamera) {
      Promise.resolve(bridge?.stopCameraStream?.(camera?.id))
        .then(() => onConnectionStatusRef.current?.(camera.id, 'Not connected'))
        .catch(error => setCameraError(`Could not disconnect camera: ${error.message}`));
    }
    if (!isRemoteCamera && camera?.id) {
      stopUsbCamera(camera.id);
      Promise.resolve(bridge?.releaseUsbCamera?.(camera.id))
        .then(() => onConnectionStatusRef.current?.(camera.id, 'Not connected'))
        .catch(error => setCameraError(`Could not disconnect camera: ${error.message}`));
    }
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreaming(false);
    setVideoReady(false);
    setConnecting(false);
    localVideoHealthRef.current = 'waiting';
    setLocalVideoHealth('waiting');
    localLastVideoTimeRef.current = 0;
    lastAiVideoTimeRef.current = -1;
    connectingRef.current = false;
    setDetection(null);
    setWorkerError('');
    setRemoteFrame('');
    setRemoteStatus('disconnected');
    remoteLastSentRef.current = '';
  };

  const loadDevices = async () => {
    setCameraError('');
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        throw new Error('Camera access is unavailable in this app. Restart it and check Windows camera privacy settings.');
      }
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
      setDevices(inputs);
      if (inputs.length) {
        if (!inputs.some(device => device.deviceId === deviceId)) setDeviceId(inputs[0].deviceId);
      } else {
        setCameraError('No webcam is currently available. Start DroidCam, check Windows camera privacy settings, then refresh devices.');
      }
      return inputs;
    } catch (error) {
      setCameraError(error.message || 'Could not enumerate camera devices.');
      return [];
    }
  };

  const formatCameraError = error => {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Camera permission was denied. Allow camera access for desktop apps in Windows Settings → Privacy & security → Camera, then reconnect.';
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return 'The selected camera is unavailable. Reconnect DroidCam or choose another device, then refresh the camera list.';
    }
    if (error.name === 'NotReadableError' || error.name === 'AbortError') {
      return 'Windows could not open this camera. It may be in use by another app; close other camera apps and try again.';
    }
    return `${error.name || 'Camera error'}: ${error.message || 'Unable to open the selected webcam.'}`;
  };

  const startRemoteCamera = async (event) => {
    event?.preventDefault();
    if (!camera?.rtspUrl || !bridge?.startCameraStream) {
      setCameraError('This camera does not have a valid RTSP stream profile.');
      return;
    }
    const activeConnections = Object.entries(cameraStatuses)
      .filter(([id, status]) => id !== camera.id && ['Connected', 'Connecting', 'Reconnecting'].includes(status)).length;
    if (activeConnections >= settings.maxConcurrentCameras) {
      setCameraError(`Camera connection limit reached (${settings.maxConcurrentCameras}). Disconnect a camera or increase the limit in Settings.`);
      return;
    }
    setConnecting(true);
    setCameraError('');
    setWorkerError('');
    setDetection(null);
    setRemoteFrame('');
    setRemoteStatus('connecting');
    setVideoReady(false);
    setStreaming(true);
    setRemoteCredentialsOpen(false);
    remoteAuthStatusReportedRef.current = false;
    remoteAuthStatusRef.current = remoteCredentials.username || remoteCredentials.password
      ? remoteCredentials.remember ? 'Configured' : 'Required'
      : camera.authenticationStatus === 'Configured' ? 'Configured' : 'Not required';
    try {
      await bridge.startCameraStream({
        cameraId: camera.id,
        username: remoteCredentials.username,
        password: remoteCredentials.password,
        remember: remoteCredentials.remember,
      });
      onConnectionStatusRef.current?.(camera.id, 'Connecting');
      setRemoteCredentials({ username: '', password: '', remember: true });
    } catch (error) {
      setCameraError(error.message || 'Could not start the RTSP camera.');
      setStreaming(false);
      setConnecting(false);
      setRemoteStatus('error');
    }
  };

  const startCamera = async (selectedDeviceId = deviceId) => {
    if (isRemoteCamera) {
      if (camera.authenticationStatus === 'Configured' || camera.authenticationStatus === 'Not required') {
        startRemoteCamera();
      } else {
        setRemoteCredentials({ username: '', password: '', remember: true });
        setRemoteCredentialsOpen(true);
      }
      return;
    }
    if (connectingRef.current) return;
    const existingStream = usbCameraStreams.get(camera.id);
    if (existingStream?.getVideoTracks().some(track => track.readyState === 'live')
      && (existingStream.getVideoTracks()[0]?.getSettings?.().deviceId === selectedDeviceId || !selectedDeviceId)) {
      streamRef.current = existingStream;
      setStreaming(true);
      setConnecting(false);
      setVideoReady(false);
      onConnectionStatusRef.current?.(camera.id, 'Connected');
      return;
    }
    const activeConnections = Object.entries(cameraStatuses)
      .filter(([id, status]) => id !== camera.id && ['Connected', 'Connecting', 'Reconnecting'].includes(status)).length;
    if (activeConnections >= settings.maxConcurrentCameras) {
      setCameraError(`Camera connection limit reached (${settings.maxConcurrentCameras}). Disconnect a camera or increase the limit in Settings.`);
      return;
    }
    const requestId = cameraRequestRef.current + 1;
    cameraRequestRef.current = requestId;
    connectingRef.current = true;
    setConnecting(true);
    setCameraError('');
    setWorkerError('');
    setDetection(null);
    stopUsbCamera(camera.id);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreaming(false);
    setVideoReady(false);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This app cannot access the camera API. Restart the desktop app and check Windows camera permissions.');
      }
      await bridge?.reserveUsbCamera?.(camera.id);
      const constraints = {
        video: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
        audio: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (cameraRequestRef.current !== requestId) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      usbCameraStreams.set(camera.id, stream);
      monitorUsbCamera(camera.id, stream);
      if (camera.id === activeCameraRef.current?.id) streamRef.current = stream;
      stream.getVideoTracks().forEach(track => {
        track.addEventListener('ended', () => {
          if (usbCameraStreams.get(camera.id) !== stream) return;
          stopUsbCameraMonitor(camera.id);
          usbCameraStreams.delete(camera.id);
          Promise.resolve(bridge?.releaseUsbCamera?.(camera.id))
            .catch(error => console.error('Could not release disconnected USB camera:', error));
          onConnectionStatusRef.current?.(camera.id, 'Not connected');
          Promise.resolve(bridge?.recordAiSystemAlert?.({
            type: 'camera_disconnected',
            detail: 'The selected camera stream ended unexpectedly.',
            camera: devices.find(device => device.deviceId === selectedDeviceId)?.label || camera?.name || 'Webcam',
            cameraId: camera?.id || '',
          })).catch(error => console.error('Could not record camera disconnect alert:', error));
          if (activeCameraRef.current?.id === camera.id) {
            streamRef.current = null;
            setStreaming(false);
            setVideoReady(false);
            setConnecting(false);
            setCameraError('The selected camera disconnected. Reconnect the device and refresh the camera list.');
          }
        }, { once: true });
      });
      if (camera.id === activeCameraRef.current?.id) setStreaming(true);
      setConnecting(false);
      connectingRef.current = false;
      setDeviceId(selectedDeviceId);
      await loadDevices();

    } catch (error) {
      if (cameraRequestRef.current !== requestId) return;
      stopUsbCamera(camera.id);
      if (camera.id === activeCameraRef.current?.id) {
        streamRef.current = null;
        setStreaming(false);
        setVideoReady(false);
      }
      await Promise.resolve(bridge?.releaseUsbCamera?.(camera.id)).catch(releaseError => {
        console.error('Could not release USB camera connection slot:', releaseError);
      });
      setCameraError(formatCameraError(error));
      setConnecting(false);
      connectingRef.current = false;
    }
  };

  const changeDevice = event => {
    const nextDeviceId = event.target.value;
    setDeviceId(nextDeviceId);
    if (streaming) startCamera(nextDeviceId);
    else if (connecting) {
      cameraRequestRef.current += 1;
      connectingRef.current = false;
      setConnecting(false);
      startCamera(nextDeviceId);
    }
  };

  const selectCamera = cameraId => {
    const nextCamera = cameras.find(item => item.id === cameraId);
    setActiveCamera(cameraId);
    onSelectCamera(cameraId);
    setDeviceId(nextCamera?.deviceId || '');
    setCameraError('');
    localVideoHealthRef.current = 'waiting';
    setLocalVideoHealth('waiting');
    localLastVideoTimeRef.current = 0;
    lastAiVideoTimeRef.current = -1;
    setRemoteFrame('');
    setConfigDraft(nextCamera?.configuration || defaultConfiguration);
    const existingStream = usbCameraStreams.get(cameraId);
    const hasLiveUsbStream = existingStream?.getVideoTracks().some(track => track.readyState === 'live');
    streamRef.current = hasLiveUsbStream ? existingStream : null;
    setStreaming(Boolean(hasLiveUsbStream));
    setVideoReady(false);
    setConnecting(false);
    if (nextCamera?.sourceType === 'RTSP camera') {
      setRemoteStatus('disconnected');
      bridge?.getCameraStatus?.(cameraId).then(status => {
        onConnectionStatusRef.current?.(cameraId, status.status === 'connected' ? 'Connected'
          : status.status === 'reconnecting' ? 'Reconnecting'
            : status.status === 'connecting' ? 'Connecting'
            : status.status === 'error' ? 'Error' : 'Not connected');
        if (activeCameraRef.current?.id !== cameraId) return;
        setRemoteStatus(status.status);
        setConnecting(status.status === 'connecting' || status.status === 'reconnecting');
        if (status.status === 'error' || status.status === 'disconnected') {
          setStreaming(false);
          setVideoReady(false);
        }
      }).catch(error => setCameraError(`Could not refresh camera status: ${error.message}`));
    } else {
      onConnectionStatusRef.current?.(cameraId, hasLiveUsbStream ? 'Connected' : 'Not connected');
    }
  };
  const changeCamera = event => selectCamera(event.target.value);

  const updateZone = (key, value) => {
    const numeric = Number(value) / 100;
    setConfigDraft(previous => {
      const next = { ...previous.queueZone, [key]: numeric };
      next.x = Math.min(next.x, 1 - next.width);
      next.y = Math.min(next.y, 1 - next.height);
      next.width = Math.min(next.width, 1 - next.x);
      next.height = Math.min(next.height, 1 - next.y);
      return { ...previous, queueZone: next };
    });
  };

  const beginZoneDrag = event => {
    if (event.button !== 0 || !stageRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      zone: zoneDraft,
    };
  };

  const moveZone = event => {
    const drag = dragRef.current;
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !bounds?.width || !bounds.height) return;
    setConfigDraft(previous => ({
      ...previous,
      queueZone: {
        ...drag.zone,
        x: Math.max(0, Math.min(1 - drag.zone.width, drag.zone.x + (event.clientX - drag.startX) / bounds.width)),
        y: Math.max(0, Math.min(1 - drag.zone.height, drag.zone.y + (event.clientY - drag.startY) / bounds.height)),
      },
    }));
  };

  const updateZoneCollection = (key, zones) => {
    setConfigDraft(previous => ({ ...previous, [key]: zones }));
  };

  const updateZoneField = (collection, zoneId, field, value) => {
    updateZoneCollection(collection, (configDraft[collection] || []).map(zone => {
      if (zone.id !== zoneId) return zone;
      if (field === 'name') return { ...zone, name: value };
      if (field === 'thresholdSeconds' || field === 'maxOccupancy') return { ...zone, [field]: Number(value) };
      const next = { ...zone, [field]: Number(value) / 100 };
      next.x = Math.min(next.x, 1 - next.width);
      next.y = Math.min(next.y, 1 - next.height);
      next.width = Math.min(next.width, 1 - next.x);
      next.height = Math.min(next.height, 1 - next.y);
      return next;
    }));
  };

  const addZone = key => {
    const names = { restrictedZones: 'Restricted', loiteringZones: 'Loitering', crowdZones: 'Crowd' };
    const zone = {
      id: `${key}-${Date.now()}`,
      name: `${names[key]} zone ${(configDraft[key] || []).length + 1}`,
      x: 0.1, y: 0.1, width: 0.3, height: 0.3,
      thresholdSeconds: 60, maxOccupancy: 10,
    };
    updateZoneCollection(key, [...(configDraft[key] || []), zone]);
  };

  const updateLine = (key, value) => {
    setConfigDraft(previous => ({
      ...previous,
      countingLine: { ...previous.countingLine, [key]: key === 'positiveIsEntry' ? value : Number(value) / 100 },
    }));
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      await onSaveSettings(camera.id, configDraft);
      await onRefreshHistory();
    } catch (error) {
      setWorkerError(`Could not save monitor settings: ${error.message}`);
    } finally {
      setSavingConfig(false);
    }
  };

  const resetConfigDraft = () => setConfigDraft(camera?.configuration || defaultConfiguration);

  const configForWorker = {
    ...configDraft,
    cameraId: camera?.id || '',
    confidence: configDraft.detectionConfidence,
    alertsEnabled: settings.alertsEnabled,
    cameraName: isRemoteCamera ? camera?.name || 'Camera'
      : devices.find(device => device.deviceId === deviceId)?.label || camera?.name || 'Webcam',
  };

  useEffect(() => {
    if (selectedCameraId && cameras.some(item => item.id === selectedCameraId)) {
      setActiveCamera(selectedCameraId);
      const selected = cameras.find(item => item.id === selectedCameraId);
      setDeviceId(selected?.deviceId || '');
      setConfigDraft(selected?.configuration || defaultConfiguration);
    }
  }, [selectedCameraId]);

  useEffect(() => {
    const unsubscriptions = [];
    if (bridge?.onAiStatus) {
      unsubscriptions.push(bridge.onAiStatus(status => {
        setWorkerStatus(status);
        if (status.status === 'connected') setWorkerError('');
        else if (status.status === 'error') setWorkerError(status.detail);
        if (status.status !== 'connected') setDetection(null);
      }));
    }
    if (bridge?.onAiDetection) {
      unsubscriptions.push(bridge.onAiDetection(result => {
        if (!Number.isInteger(result.peopleCount) || !Number.isInteger(result.queueCount) || !Array.isArray(result.detections)) return;
        setDetection(result);
        setWorkerError('');
        detectionFailureRef.current = false;
      }));
    }
    if (bridge?.onAiFrameError) {
      unsubscriptions.push(bridge.onAiFrameError(error => {
        setDetection(null);
        setWorkerError(error.message);
        if (!detectionFailureRef.current) {
          detectionFailureRef.current = true;
          Promise.resolve(bridge.recordAiSystemAlert?.({
            type: 'detection_failure',
            detail: error.message,
            camera: camera?.name || 'Webcam',
            cameraId: camera?.id || '',
          })).catch(recordError => console.error('Could not record detection failure alert:', recordError));
        }
      }));
    }
    if (bridge?.onAiEvent) {
      unsubscriptions.push(bridge.onAiEvent(() => onRefreshHistory()));
    }
    if (bridge?.onCameraFrame) {
      unsubscriptions.push(bridge.onCameraFrame(frame => {
        onConnectionStatusRef.current?.(frame.id, 'Connected');
        if (frame.id !== activeCameraRef.current?.id || typeof frame.image !== 'string') return;
        setRemoteFrame(frame.image);
        setRemoteStatus('connected');
        setConnecting(false);
        setStreaming(true);
        setVideoReady(true);
        setCameraError('');
        if (!remoteAuthStatusReportedRef.current) {
          remoteAuthStatusReportedRef.current = true;
          onAuthenticationStatusRef.current?.(frame.id, remoteAuthStatusRef.current);
        }
      }));
    }
    if (bridge?.onCameraStatus) {
      unsubscriptions.push(bridge.onCameraStatus(status => {
        onConnectionStatusRef.current?.(status.id, status.status === 'connected' ? 'Connected'
          : status.status === 'reconnecting' ? 'Reconnecting'
            : status.status === 'connecting' ? 'Connecting'
            : status.status === 'error' ? 'Error' : 'Not connected');
        if (status.id !== activeCameraRef.current?.id) return;
        setRemoteStatus(status.status);
        if (status.status === 'connected') {
          setConnecting(false);
          setCameraError('');
        } else if (status.status === 'reconnecting' || status.status === 'connecting') {
          setConnecting(true);
          setCameraError(status.detail || '');
          if (status.status === 'reconnecting') {
            setDetection(null);
            setRemoteFrame('');
            remoteLastSentRef.current = '';
          }
        } else if (status.status === 'error' || status.status === 'disconnected') {
          setStreaming(false);
          setVideoReady(false);
          setConnecting(false);
          if (status.status === 'error') setCameraError(status.detail || 'The RTSP camera could not connect.');
        }
      }));
    }
    loadDevices();
    return () => {
      unsubscriptions.forEach(unsubscribe => unsubscribe());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      if (aiStopTimerRef.current) clearTimeout(aiStopTimerRef.current);
      bridge?.stopAi?.().catch(error => console.error('Could not stop AI worker:', error));
    };
  }, []);

  useEffect(() => {
    resetConfigDraft();
  }, [camera?.id, camera?.configuration, settings.queueZone, settings.detectionConfidence, settings.countingLine, settings.restrictedZones, settings.loiteringZones, settings.crowdZones]);

  useEffect(() => {
    onDetectionRef.current = onDetection;
  }, [onDetection]);

  useEffect(() => {
    onConnectionStatusRef.current = onConnectionStatus;
  }, [onConnectionStatus]);

  useEffect(() => {
    onAuthenticationStatusRef.current = onAuthenticationStatus;
  }, [onAuthenticationStatus]);

  useEffect(() => {
    const status = isRemoteCamera
      ? remoteStatus === 'connected' && streaming && videoReady ? 'Connected'
        : remoteStatus === 'reconnecting' ? 'Reconnecting'
          : remoteStatus === 'connecting' || connecting ? 'Connecting' : 'Not connected'
      : localVideoHealth === 'reconnecting' ? 'Reconnecting'
        : localVideoHealth === 'healthy' && streaming && videoReady ? 'Connected'
          : connecting ? 'Connecting' : 'Not connected';
    if (camera?.id) onConnectionStatusRef.current?.(camera.id, status);
  }, [camera?.id, isRemoteCamera, streaming, videoReady, connecting, remoteStatus, localVideoHealth]);

  useEffect(() => {
    if (detection) onDetectionRef.current?.(detection);
  }, [detection]);

  useEffect(() => {
    if (isRemoteCamera || !streaming || !videoRef.current || !streamRef.current) return;
    let active = true;
    const video = videoRef.current;
    video.srcObject = streamRef.current;
    video.onloadedmetadata = () => {
      if (stageRef.current && video.videoWidth && video.videoHeight) {
        stageRef.current.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      }
    };
    video.play().then(() => {
      if (active) setVideoReady(true);
    }).catch(error => {
      if (active) {
        stopTracks();
        setCameraError(`The camera opened but video playback failed: ${error.message}`);
      }
    });
    return () => {
      active = false;
      video.onloadedmetadata = null;
    };
  }, [streaming, isRemoteCamera]);

  useEffect(() => {
    if (isRemoteCamera || !streaming || !videoReady || !videoRef.current) return undefined;
    const video = videoRef.current;
    let active = true;
    let frameCallbackId = null;
    let lastFrameAt = performance.now();
    localLastVideoTimeRef.current = video.currentTime;
    const setHealth = health => {
      if (localVideoHealthRef.current === health) return;
      localVideoHealthRef.current = health;
      setLocalVideoHealth(health);
      if (health === 'healthy') {
        setCameraError('');
        onConnectionStatusRef.current?.(camera?.id, 'Connected');
      } else if (health === 'reconnecting') {
        setDetection(null);
        setCameraError('The Windows camera stopped delivering video frames. Check the camera connection and privacy permissions.');
        onConnectionStatusRef.current?.(camera?.id, 'Reconnecting');
      }
    };
    localVideoHealthRef.current = 'waiting';
    setLocalVideoHealth('waiting');
    const onVideoFrame = () => {
      if (!active) return;
      lastFrameAt = performance.now();
      localLastVideoTimeRef.current = video.currentTime;
      setHealth('healthy');
      frameCallbackId = video.requestVideoFrameCallback(onVideoFrame);
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      frameCallbackId = video.requestVideoFrameCallback(onVideoFrame);
    }
    const timer = setInterval(() => {
      if (typeof video.requestVideoFrameCallback !== 'function' && video.currentTime > localLastVideoTimeRef.current) {
        localLastVideoTimeRef.current = video.currentTime;
        lastFrameAt = performance.now();
        setHealth('healthy');
      }
      if (performance.now() - lastFrameAt > 5000) setHealth('reconnecting');
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
      if (frameCallbackId != null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameCallbackId);
      }
    };
  }, [camera?.id, isRemoteCamera, streaming, videoReady]);

  useEffect(() => {
    if (!bridge?.startAi) {
      if (!streaming || !videoReady) return undefined;
      setWorkerStatus({ status: 'error', detail: 'The secure Electron AI bridge is unavailable. Run this app with npm run dev or start.' });
      setWorkerError('AI detection is available only in the Electron desktop app.');
      return undefined;
    }
    if (!streaming || !videoReady) {
      aiStopTimerRef.current = setTimeout(() => {
        aiStopTimerRef.current = null;
        bridge.stopAi().catch(error => console.error('Could not stop AI worker:', error));
      }, 5000);
      return () => {
        if (aiStopTimerRef.current) clearTimeout(aiStopTimerRef.current);
        aiStopTimerRef.current = null;
      };
    }
    if (aiStopTimerRef.current) clearTimeout(aiStopTimerRef.current);
    aiStopTimerRef.current = null;
    bridge.startAi().catch(error => setWorkerError(error.message || 'The AI worker could not start.'));
    return undefined;
  }, [streaming, videoReady]);

  useEffect(() => {
    if (isRemoteCamera || !streaming || !workerConnected || !bridge?.sendAiFrame) return undefined;
    let cancelled = false;
    let timer;
    const captureFrame = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!cancelled && video && canvas && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0
        && video.currentTime > lastAiVideoTimeRef.current && !frameBusyRef.current) {
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        if (context) {
          lastAiVideoTimeRef.current = video.currentTime;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          frameBusyRef.current = true;
          try {
            const image = canvas.toDataURL('image/jpeg', 0.72).split(',')[1];
            await bridge.sendAiFrame({ image, config: configForWorker });
          } catch (error) {
            setWorkerError(`Could not send camera frame to AI worker: ${error.message}`);
          } finally {
            frameBusyRef.current = false;
          }
        }
      }
      if (!cancelled) timer = setTimeout(captureFrame, 700);
    };
    captureFrame();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [streaming, workerConnected, configDraft, camera?.name, deviceId, devices, isRemoteCamera]);

  useEffect(() => {
    if (!isRemoteCamera || !streaming || !workerConnected || !remoteFrame || !bridge?.sendAiFrame
      || remoteLastSentRef.current === remoteFrame || frameBusyRef.current) return;
    remoteLastSentRef.current = remoteFrame;
    frameBusyRef.current = true;
    bridge.sendAiFrame({ image: remoteFrame, config: configForWorker })
      .catch(error => setWorkerError(`Could not send RTSP frame to AI worker: ${error.message}`))
      .finally(() => { frameBusyRef.current = false; });
  }, [isRemoteCamera, streaming, workerConnected, remoteFrame, configDraft, settings.alertsEnabled, camera?.name]);

  const statusLabel = workerStatus.status === 'connected'
    ? 'Connected'
    : workerStatus.status === 'starting' || workerStatus.status === 'stopping'
      ? 'Starting…'
      : workerStatus.status === 'error'
        ? 'Error'
        : 'Not connected';
  const cameraLabel = isRemoteCamera ? camera?.name || 'RTSP camera'
    : devices.find(device => device.deviceId === deviceId)?.label || camera?.name || 'Webcam';
  const refreshCameraStatus = async () => {
    if (!camera) {
      setCameraError('Add a camera profile before refreshing camera status.');
      return;
    }
    setCameraError('');
    try {
      if (isRemoteCamera) {
        if (!bridge?.getCameraStatus) throw new Error('Camera status refresh is available in the Electron desktop app.');
        const status = await bridge.getCameraStatus(camera.id);
        setRemoteStatus(status.status);
        onConnectionStatus(camera.id, status.status === 'connected' ? 'Connected'
          : status.status === 'reconnecting' ? 'Reconnecting'
            : status.status === 'connecting' ? 'Connecting' : 'Not connected');
        if (status.status === 'error' || status.status === 'disconnected') {
          if (streaming || connecting) stopTracks();
          if (status.status === 'error') setCameraError('The RTSP connection reported an error. Review its settings and reconnect.');
        }
      } else {
        const inputs = await loadDevices();
        const selectedDevice = camera?.deviceId || deviceId || inputs[0]?.deviceId;
        const available = inputs.some(device => device.deviceId === selectedDevice);
        if (!available) setCameraError('The selected Windows camera is unavailable. Reconnect it or select another device.');
        const stream = usbCameraStreams.get(camera.id);
        const live = stream?.getVideoTracks().some(track => track.readyState === 'live');
        onConnectionStatus(camera.id, live ? 'Connected' : 'Not connected');
      }
    } catch (error) {
      setCameraError(`Could not refresh camera status: ${error.message}`);
    }
  };

  return <>
    <PageHeading eyebrow="LIVE MONITOR" title="Camera monitor" subtitle={isRemoteCamera ? 'Connect an ONVIF-discovered or manually configured RTSP stream.' : 'Connect a Windows webcam, DroidCam device, or HDMI capture card.'} action={<div className={`status-chip ${cameraStatuses[camera?.id] === 'Connected' ? 'positive' : 'neutral'}`}><span/>{cameraStatuses[camera?.id] || (connecting ? 'Connecting…' : 'Not connected')}</div>} />
    <div className="demo-notice"><div className="notice-icon"><Camera size={18}/></div><div><strong>{streaming && videoReady ? 'Live video connected' : isRemoteCamera ? 'RTSP camera connection' : 'Windows video device'}</strong><span>{streaming && videoReady ? 'Video is previewed locally and sent to the centralized QueuePulse AI worker.' : isRemoteCamera ? 'The RTSP stream reconnects after short network interruptions. Credentials stay on this device.' : 'Start DroidCam or attach the capture card, select its Windows video input, then connect.'}</span></div></div>
    <div className="monitor-toolbar panel"><div className="monitor-camera-select"><Camera size={16}/><select aria-label="Choose camera profile" value={camera?.id || ''} onChange={changeCamera}>{cameras.length ? cameras.map(item => <option key={item.id} value={item.id}>{item.name} ({item.sourceType})</option>) : <option value="">No cameras configured</option>}</select></div><div className="monitor-right">{!isRemoteCamera && <><select aria-label="Choose Windows webcam" value={deviceId} onChange={changeDevice}><option value="">Default webcam</option>{devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select><button className="button secondary small" onClick={loadDevices}><RefreshCw size={14}/> Refresh devices</button></>}<button className="button secondary small" onClick={refreshCameraStatus}><RefreshCw size={14}/> Refresh status</button>{streaming || connecting ? <button className="button secondary small" onClick={stopTracks}><WifiOff size={14}/> Disconnect</button> : <button className="button primary small" onClick={() => startCamera()} disabled={!camera}><Wifi size={14}/> {isRemoteCamera ? 'Connect RTSP' : 'Connect webcam'}</button>}</div></div>
    <div className="monitor-camera-list panel">
      <div className="monitor-camera-list-heading"><div><h3>Configured cameras</h3><p>Choose a camera to monitor or manage its profile.</p></div><div><button className="button secondary small" onClick={() => onManageCameras()}><Settings size={13}/> Manage profiles</button><button className="button primary small" onClick={onAddCamera}><Plus size={13}/> Add camera</button></div></div>
      {cameras.length ? <div className="monitor-camera-rows">{cameras.map(item => {
        const source = item.sourceType === 'RTSP camera' ? 'RTSP stream' : item.deviceId || 'Windows camera';
        const status = cameraStatuses[item.id] || 'Not connected';
        return <div className={`monitor-camera-row ${item.id === camera?.id ? 'selected' : ''}`} key={item.id}>
          <div className="monitor-camera-row-main"><strong>{item.name}</strong><span>{item.sourceType} · {source || 'Source not configured'} · {item.location || 'Location not set'}</span></div>
          <span className={`camera-profile-status ${status === 'Connected' ? 'connected' : ''}`}><i/>{status}</span>
          <div className="monitor-camera-row-actions">
            <button className="button secondary small" onClick={() => selectCamera(item.id)} disabled={item.id === camera?.id}>Select</button>
            <button className="button secondary small" onClick={() => onManageCameras(item.id)}>Edit</button>
            <button className="button secondary small remove-camera" onClick={() => { if (window.confirm(`Remove ${item.name}?`)) onRemoveCamera(item.id); }}>Remove</button>
          </div>
        </div>;
      })}</div> : <p className="monitor-camera-empty">No cameras are configured. Add a camera profile to begin.</p>}
    </div>
    {cameraError && <div className="info-callout" role="alert"><AlertTriangle size={16}/><span>{cameraError}</span></div>}
    {workerError && <div className="info-callout" role="alert"><AlertTriangle size={16}/><span>{workerError}</span></div>}
    <div className="monitor-layout">
      <div className="monitor-video panel">
        <div className="live-video-stage" ref={stageRef}>
          {streaming && isRemoteCamera && remoteFrame
            ? <img src={`data:image/jpeg;base64,${remoteFrame}`} alt={`${cameraLabel} live preview`} className="live-video"/>
            : streaming && !isRemoteCamera
              ? <video ref={videoRef} autoPlay playsInline muted className="live-video"/>
            : <div className="camera-idle"><Camera size={34}/><strong>{connecting ? 'Connecting to camera…' : 'No live camera connected'}</strong><span>{isRemoteCamera ? 'Connect an RTSP stream to see its live preview.' : 'Connect a Windows video input to see its live preview.'}</span></div>}
          {streaming && <svg className="monitor-guides" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
            <line x1={configDraft.countingLine.x1 * 1000} y1={configDraft.countingLine.y1 * 1000} x2={configDraft.countingLine.x2 * 1000} y2={configDraft.countingLine.y2 * 1000} className="counting-line"/>
            {configDraft.restrictedZones.map(zone => <rect key={zone.id} x={zone.x * 1000} y={zone.y * 1000} width={zone.width * 1000} height={zone.height * 1000} className="restricted-zone-guide"/>)}
            {configDraft.loiteringZones.map(zone => <rect key={zone.id} x={zone.x * 1000} y={zone.y * 1000} width={zone.width * 1000} height={zone.height * 1000} className="loitering-zone-guide"/>)}
            {configDraft.crowdZones.map(zone => <rect key={zone.id} x={zone.x * 1000} y={zone.y * 1000} width={zone.width * 1000} height={zone.height * 1000} className="crowd-zone-guide"/>)}
          </svg>}
          {streaming && <div className="detection-overlay">
            {detection?.detections.map((person, index) => <div className="detected-person" key={`${person.trackingId ?? index}-${index}`} style={{ left: `${person.x * 100}%`, top: `${person.y * 100}%`, width: `${person.width * 100}%`, height: `${person.height * 100}%` }}><span>#{person.trackingId ?? '—'} · {Math.round(person.confidence * 100)}%</span></div>)}
          </div>}
          {streaming && <div className="queue-zone-live" style={{ left: `${zoneDraft.x * 100}%`, top: `${zoneDraft.y * 100}%`, width: `${zoneDraft.width * 100}%`, height: `${zoneDraft.height * 100}%` }} onPointerDown={beginZoneDrag} onPointerMove={moveZone} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}><span>QUEUE ZONE · DRAG TO MOVE</span></div>}
          <div className="video-caption"><span><Video size={14}/>{cameraLabel}</span><span>{streaming ? 'LIVE CAMERA · LOCAL AI' : 'NO LIVE CAMERA'}</span></div>
        </div>
        <canvas ref={canvasRef} className="frame-canvas" aria-hidden="true"/>
      </div>
      <div className="monitor-sidebar">
        <div className="panel small-stat-panel">
          <div className="panel-heading"><div><h3>Detection summary</h3><p>AI worker: {statusLabel}</p></div><Activity size={17} className="muted-icon"/></div>
          <div className="mini-stat"><span>People in scene</span><strong>{detection ? detection.peopleCount : '—'}</strong></div>
          <div className="mini-stat"><span>Queue estimate</span><strong>{detection ? detection.queueCount : '—'}</strong></div>
          <div className="mini-stat"><span>Current occupancy</span><strong>{detection ? detection.occupancy : '—'}</strong></div>
          <div className="mini-stat"><span>Total footfall</span><strong>{detection ? detection.footfall : '—'}</strong></div>
          <div className="mini-stat"><span>Entries / exits</span><strong>{detection ? `${detection.entries} / ${detection.exits}` : '—'}</strong></div>
          <div className="mini-stat"><span>Crowd in zone</span><strong>{detection ? detection.crowdCount : '—'}</strong></div>
          <div className="mini-stat"><span>Crowd capacity</span><strong>{detection ? `${detection.crowdPercent}% · ${detection.crowdStatus}` : '—'}</strong></div>
          <div className="mini-stat"><span>Detection FPS</span><strong>{detection ? detection.fps : '—'}</strong></div>
          <div className="mini-stat"><span>Detection status</span><strong className="value-muted">{!workerConnected ? (workerStatus.status === 'error' ? 'Unavailable' : 'Not connected') : detection ? 'Active' : 'Waiting for frame'}</strong></div>
          <p className="zone-count-note">Queue estimate counts detected people whose bounding boxes intersect the current zone.</p>
        </div>
        <div className="panel overlay-settings">
          <h3>Latest alerts</h3>
          {(aiHistory?.alerts || []).slice(0, 3).map(alert => <div className="monitor-alert" key={alert.id}><span className={`severity-chip ${alert.severity}`}>{alert.severity}</span><div><strong>{alert.title}</strong><small>{alert.camera} · {new Date(alert.timestamp).toLocaleTimeString()}</small></div>{!alert.resolved && <button className="text-link" onClick={() => onUpdateAlert(alert.id, alert.acknowledged ? 'resolve' : 'acknowledge')}>{alert.acknowledged ? 'Resolve' : 'Acknowledge'}</button>}</div>)}
          {!(aiHistory?.alerts || []).length && <p>No alerts have been generated.</p>}
        </div>
        <div className="panel overlay-settings">
          <h3>Queue zone</h3>
          <p>Drag the zone on the preview, or adjust its position and size. Counts update with the next detection.</p>
          {[
            ['x', 'Left', 0, 100 - zoneDraft.width * 100],
            ['y', 'Top', 0, 100 - zoneDraft.height * 100],
            ['width', 'Width', 10, 100 - zoneDraft.x * 100],
            ['height', 'Height', 10, 100 - zoneDraft.y * 100],
          ].map(([key, label, min, max]) => <label className="zone-control" key={key}><span>{label}</span><input type="range" min={min} max={Math.max(min, max)} value={Math.round(zoneDraft[key] * 100)} onChange={event => updateZone(key, event.target.value)}/><output>{Math.round(zoneDraft[key] * 100)}%</output></label>)}
          <label className="zone-control"><span>Confidence</span><input type="range" min="10" max="95" value={Math.round(configDraft.detectionConfidence * 100)} onChange={event => setConfigDraft(previous => ({ ...previous, detectionConfidence: Number(event.target.value) / 100 }))}/><output>{Math.round(configDraft.detectionConfidence * 100)}%</output></label>
          <label className="zone-control"><span>Line start X</span><input type="range" min="0" max="100" value={Math.round(configDraft.countingLine.x1 * 100)} onChange={event => updateLine('x1', event.target.value)}/><output>{Math.round(configDraft.countingLine.x1 * 100)}%</output></label>
          <label className="zone-control"><span>Line end X</span><input type="range" min="0" max="100" value={Math.round(configDraft.countingLine.x2 * 100)} onChange={event => updateLine('x2', event.target.value)}/><output>{Math.round(configDraft.countingLine.x2 * 100)}%</output></label>
          <label className="zone-control"><span>Line top</span><input type="range" min="0" max="100" value={Math.round(configDraft.countingLine.y1 * 100)} onChange={event => updateLine('y1', event.target.value)}/><output>{Math.round(configDraft.countingLine.y1 * 100)}%</output></label>
          <label className="zone-control"><span>Line bottom</span><input type="range" min="0" max="100" value={Math.round(configDraft.countingLine.y2 * 100)} onChange={event => updateLine('y2', event.target.value)}/><output>{Math.round(configDraft.countingLine.y2 * 100)}%</output></label>
          <label className="zone-direction"><input type="checkbox" checked={configDraft.countingLine.positiveIsEntry} onChange={event => updateLine('positiveIsEntry', event.target.checked)}/>Positive direction counts as entry</label>
        </div>
        <div className="panel overlay-settings">
          <h3>Detection zones</h3>
          <p>Rectangles are drawn on the live preview. Intrusion alerts fire on entry; loitering alerts wait for the configured duration.</p>
          {[
            ['restrictedZones', 'Restricted areas', 'restricted'],
            ['loiteringZones', 'Loitering zones', 'loitering'],
            ['crowdZones', 'Crowd limits', 'crowd'],
          ].map(([key, title, type]) => <ZoneConfiguration key={key} collection={key} title={title} type={type} zones={configDraft[key]} onAdd={addZone} onChange={updateZoneField} onRemove={(id) => updateZoneCollection(key, configDraft[key].filter(zone => zone.id !== id))}/>)}
          <div className="monitor-config-actions"><button className="button secondary small" onClick={resetConfigDraft} disabled={!zoneIsDirty}>Discard</button><button className="button primary small" onClick={saveConfig} disabled={!zoneIsDirty || savingConfig}>{savingConfig ? 'Saving…' : 'Save configuration'}</button></div>
        </div>
      </div>
    </div>
    {remoteCredentialsOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setRemoteCredentialsOpen(false); }}>
      <form className="modal-card" onSubmit={startRemoteCamera}>
        <div className="modal-heading"><div><span className="eyebrow">RTSP AUTHENTICATION</span><h2>{camera?.name || 'Camera'}</h2><p>Enter authorized credentials. QueuePulse will not test alternate passwords.</p></div><button type="button" className="icon-button" onClick={() => setRemoteCredentialsOpen(false)} aria-label="Close"><X size={18}/></button></div>
        <label className="field-label">Username<input autoFocus autoComplete="username" value={remoteCredentials.username} onChange={event => setRemoteCredentials(previous => ({ ...previous, username: event.target.value }))}/></label>
        <label className="field-label">Password<input type="password" autoComplete="current-password" value={remoteCredentials.password} onChange={event => setRemoteCredentials(previous => ({ ...previous, password: event.target.value }))}/></label>
        <label className="credential-remember"><input type="checkbox" checked={remoteCredentials.remember} onChange={event => setRemoteCredentials(previous => ({ ...previous, remember: event.target.checked }))}/> Remember credentials encrypted by Windows</label>
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setRemoteCredentialsOpen(false)}>Cancel</button><button type="submit" className="button primary">Connect camera</button></div>
      </form>
    </div>}
  </>;
}

function ZoneConfiguration({ collection, title, type, zones, onAdd, onChange, onRemove }) {
  const isLoitering = type === 'loitering';
  const isCrowd = type === 'crowd';
  return <section className={`zone-config-section ${type}`}>
    <div className="zone-config-heading"><strong>{title}</strong><button className="text-link" onClick={() => onAdd(collection)}><Plus size={12}/> Add</button></div>
    {!zones.length && <span className="zone-empty">No zones configured.</span>}
    {zones.map((zone, index) => <div className="zone-config-card" key={zone.id}>
      <label className="zone-name-label"><span>Zone {index + 1}</span><input aria-label={`${title} name`} maxLength="60" value={zone.name} onChange={event => onChange(collection, zone.id, 'name', event.target.value)}/><button className="icon-button" aria-label={`Remove ${zone.name}`} onClick={() => onRemove(zone.id)}><X size={14}/></button></label>
      <div className="zone-coordinates">
        {[
          ['x', 'X'], ['y', 'Y'], ['width', 'W'], ['height', 'H'],
        ].map(([field, label]) => <label key={field}><span>{label}</span><input type="number" min={field === 'width' || field === 'height' ? 1 : 0} max="100" value={Math.round(zone[field] * 100)} onChange={event => onChange(collection, zone.id, field, event.target.value)}/></label>)}
      </div>
      {isLoitering && <label className="zone-threshold">Loiter threshold (seconds)<input type="number" min="5" max="3600" value={zone.thresholdSeconds} onChange={event => onChange(collection, zone.id, 'thresholdSeconds', event.target.value)}/></label>}
      {isCrowd && <label className="zone-threshold">Maximum people<input type="number" min="1" max="10000" value={zone.maxOccupancy} onChange={event => onChange(collection, zone.id, 'maxOccupancy', event.target.value)}/></label>}
    </div>)}
  </section>;
}

function DemoScene({ large = false }) {
  return <div className={cx('demo-scene', large && 'large-scene')}><div className="scene-timestamp">2026/10/12&nbsp; 12:37:08</div><div className="scene-top-label">FRONT ENTRANCE · DEMO</div><div className="scene-shelves shelf-a"/><div className="scene-shelves shelf-b"/><div className="scene-counter"/><div className="scene-person person-one"><i/><b/><span/></div><div className="scene-person person-two"><i/><b/><span/></div><div className="scene-person person-three"><i/><b/><span/></div><div className="person-box box-one"><small>Person · 98%</small></div><div className="person-box box-two"><small>Person · 95%</small></div><div className="person-box box-three"><small>Person · 91%</small></div><div className="queue-zone"><span>QUEUE ZONE · PREVIEW</span></div><div className="scene-bottom-label"><span><span className="red-dot"/>REC SIMULATION</span><span>1920 × 1080 · UI MOCKUP</span></div></div>;
}

function Analytics({ settings, cameraStatuses, aiHistory, error }) {
  const [periodMinutes, setPeriodMinutes] = useState(5);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [reportBusy, setReportBusy] = useState('');
  const [reportMessage, setReportMessage] = useState('');
  const [reportError, setReportError] = useState('');
  const summary = useMemo(
    () => summarizeTrafficPeriod(aiHistory?.windowEvents || [], periodMinutes),
    [aiHistory?.windowEvents, periodMinutes],
  );
  const trafficHistory = aiHistory?.traffic || [];
  const maxEntries = Math.max(1, ...summary.traffic.map(row => row.entries));
  const currentOccupancy = (aiHistory?.totals?.entries || 0) - (aiHistory?.totals?.exits || 0);
  const dateRange = `${new Date(summary.start).toLocaleString()} – ${new Date(summary.end).toLocaleString()}`;
  const report = {
    title: 'QueuePulse AI Traffic Report',
    dateRange: `${periodMinutes}-minute period · ${dateRange}`,
    footfall: summary.footfall,
    entries: summary.entries,
    exits: summary.exits,
    occupancy: currentOccupancy,
    cameras: settings.cameras.map(camera => ({
      name: camera.name,
      sourceType: camera.sourceType,
      location: camera.location,
      status: cameraStatuses[camera.id] || 'Not connected',
    })),
    trafficRows: summary.traffic.map(row => ({
      time: new Date(row.minute).toLocaleString(),
      footfall: row.footfall,
      entries: row.entries,
      exits: row.exits,
    })),
    alerts: summary.periodEvents.map(alert => ({
      time: new Date(alert.timestamp).toLocaleString(),
      title: alert.title,
      severity: alert.severity,
      camera: alert.camera,
      detail: alert.detail,
    })),
  };
  const runReportAction = async action => {
    setReportBusy(action);
    setReportError('');
    setReportMessage('');
    try {
      if (!window.queuePulse) throw new Error('Report printing is available in the QueuePulse AI desktop app.');
      if (action === 'print') {
        if (!window.queuePulse.printReport) throw new Error('Electron printing is unavailable in this app session.');
        const result = await window.queuePulse.printReport(report);
        if (result.canceled) return;
        setReportMessage('Report sent to the system print dialog.');
      } else {
        if (!window.queuePulse.saveReportPdf) throw new Error('Electron PDF export is unavailable in this app session.');
        const result = await window.queuePulse.saveReportPdf(report);
        if (result.canceled) return;
        setReportMessage(`PDF saved to ${result.filePath}`);
      }
    } catch (actionError) {
      setReportError(actionError.message || 'Could not prepare the report.');
    } finally {
      setReportBusy('');
    }
  };
  return <>
    <PageHeading eyebrow="REPORTING" title="Shop analytics" subtitle="Visitor activity filtered from persisted event timestamps. Analytics refresh when new events arrive." action={<button className="button secondary" onClick={() => { setReportError(''); setReportMessage(''); setPreviewOpen(true); }}><Download size={15}/> Print report</button>} />
    {error && <div className="info-callout" role="alert"><AlertTriangle size={16}/><span>{error}</span></div>}
    <div className="analytics-period-bar panel">
      <div><strong>Traffic period</strong><span>Counts use saved entry and exit event timestamps.</span></div>
      <label>Show
        <select aria-label="Traffic time period" value={periodMinutes} onChange={event => setPeriodMinutes(Number(event.target.value))}>
          {TRAFFIC_PERIODS.map(minutes => <option key={minutes} value={minutes}>{minutes === 60 ? 'Last 1 hour' : `Last ${minutes} minutes`}</option>)}
        </select>
      </label>
      <span className="period-chip">{dateRange}</span>
    </div>
    <div className="analytics-top-grid traffic-period-metrics">
      <MetricCard title="Visitors in period" value={summary.footfall} change={`Last ${periodMinutes === 60 ? '1 hour' : `${periodMinutes} minutes`}`} changeType="neutral" icon={UsersIcon} iconTone="blue" footer="Unique tracked entrants"/>
      <MetricCard title="Entries" value={summary.entries} change="Persisted count-line events" changeType="neutral" icon={ArrowDownRight} iconTone="green" footer="Selected period"/>
      <MetricCard title="Exits" value={summary.exits} change="Persisted count-line events" changeType="neutral" icon={ArrowUpRight} iconTone="orange" footer="Selected period"/>
      <MetricCard title="Current occupancy" value={currentOccupancy} change="Persisted entries minus exits" changeType="neutral" icon={Clock3} iconTone="purple" footer="Across configured cameras"/>
    </div>
    <div className="panel report-panel">
      <div className="panel-heading"><div><h3>Footfall by minute</h3><p>{summary.entries} entries and {summary.exits} exits within the selected period</p></div><span className="period-chip">{summary.traffic.length} active minutes</span></div>
      {summary.traffic.length
        ? <div className="bar-chart">{summary.traffic.map(row => <div className="bar-row" key={row.minute}>
          <span className="bar-label">{new Date(row.minute).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${row.entries / maxEntries * 100}%` }}/></div>
          <strong>{row.entries}</strong><span className="queue-label">{row.exits} exits</span>
        </div>)}</div>
        : <div className="empty-analytics">No visitor events were recorded during this period.</div>}
      <div className="chart-footnote">Only minutes containing persisted count-line events are shown; empty periods do not contain generated or estimated data.</div>
    </div>
    <div className="analytics-top-grid analytics-secondary-grid">
      <MetricCard title="All-time footfall" value={aiHistory?.totals?.footfall ?? 0} change="Persisted total" changeType="neutral" icon={Activity} iconTone="blue" footer="Across application sessions"/>
      <MetricCard title="Alerts and events" value={summary.periodEvents.length} change="All stored event types" changeType="neutral" icon={Bell} iconTone="orange" footer="Selected period"/>
      <MetricCard title="Saved camera samples" value={trafficHistory.length} change="Minute resolution" changeType="neutral" icon={Camera} iconTone="purple" footer="SQLite local history"/>
    </div>
    {previewOpen && <ReportPreview report={report} busy={reportBusy} error={reportError} message={reportMessage} onClose={() => setPreviewOpen(false)} onPrint={() => runReportAction('print')} onSavePdf={() => runReportAction('pdf')}/>}
  </>;
}

function ReportPreview({ report, busy, error, message, onClose, onPrint, onSavePdf }) {
  return <div className="modal-backdrop report-preview-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="report-preview" role="dialog" aria-modal="true" aria-labelledby="report-preview-title">
      <div className="report-preview-toolbar">
        <div><span className="eyebrow">PRINT PREVIEW</span><h2 id="report-preview-title">{report.title}</h2><p>{report.dateRange}</p></div>
        <div className="report-preview-actions">
          <button className="button secondary" onClick={onClose}>Close</button>
          <button className="button secondary" onClick={onSavePdf} disabled={Boolean(busy)}>{busy === 'pdf' ? 'Saving PDF…' : 'Save as PDF'}</button>
          <button className="button primary" onClick={onPrint} disabled={Boolean(busy)}>{busy === 'print' ? 'Opening print dialog…' : 'Print'}</button>
        </div>
      </div>
      {error && <div className="info-callout report-feedback" role="alert"><AlertTriangle size={16}/><span>{error}</span></div>}
      {message && <div className="info-callout report-feedback success"><Check size={16}/><span>{message}</span></div>}
      <div className="report-preview-paper">
        <div className="report-preview-brand">QUEUEPULSE AI · ANALYTICS</div>
        <h1>{report.title}</h1>
        <p>{report.dateRange}</p>
        <h3>Traffic summary</h3>
        <div className="report-preview-metrics">
          {[['Footfall', report.footfall], ['Entries', report.entries], ['Exits', report.exits], ['Occupancy', report.occupancy]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
        </div>
        <h3>Camera information</h3>
        {report.cameras.length
          ? <table><thead><tr><th>Name</th><th>Source</th><th>Location</th><th>Status</th></tr></thead><tbody>{report.cameras.map((camera, index) => <tr key={`${camera.name}-${index}`}><td>{camera.name}</td><td>{camera.sourceType}</td><td>{camera.location}</td><td>{camera.status}</td></tr>)}</tbody></table>
          : <p>No cameras are configured.</p>}
        <h3>Footfall by minute</h3>
        {report.trafficRows.length
          ? <table><thead><tr><th>Time</th><th>Footfall</th><th>Entries</th><th>Exits</th></tr></thead><tbody>{report.trafficRows.map(row => <tr key={row.time}><td>{row.time}</td><td>{row.footfall}</td><td>{row.entries}</td><td>{row.exits}</td></tr>)}</tbody></table>
          : <p>No visitor events were recorded during this period.</p>}
        <h3>Alerts and events</h3>
        {report.alerts.length
          ? <table><thead><tr><th>Time</th><th>Event</th><th>Severity</th><th>Camera</th><th>Details</th></tr></thead><tbody>{report.alerts.map((alert, index) => <tr key={`${alert.time}-${index}`}><td>{alert.time}</td><td>{alert.title}</td><td>{alert.severity}</td><td>{alert.camera}</td><td>{alert.detail}</td></tr>)}</tbody></table>
          : <p>No alerts were recorded during this period.</p>}
      </div>
    </section>
  </div>;
}

function Alerts({ aiHistory, onUpdateAlert, error }) {
  const [query, setQuery] = useState('');
  const [severity, setSeverity] = useState('all');
  const [type, setType] = useState('all');
  const alerts = aiHistory?.alerts || [];
  const filtered = alerts.filter(alert => {
    const text = `${alert.title} ${alert.detail} ${alert.camera} ${alert.zone || ''}`.toLowerCase();
    return (!query || text.includes(query.toLowerCase()))
      && (severity === 'all' || alert.severity === severity)
      && (type === 'all' || alert.type === type);
  });
  const openCount = alerts.filter(alert => !alert.resolved).length;
  return <>
    <PageHeading eyebrow="EVENT CENTER" title="Alerts & events" subtitle="Review and manage locally generated camera events." action={<button className="button secondary" onClick={() => window.print()}><Download size={15}/> Print view</button>} />
    {error && <div className="info-callout" role="alert"><AlertTriangle size={16}/><span>{error}</span></div>}
    <div className="alert-stats"><div className="panel alert-stat"><span>Stored events</span><strong>{alerts.length}</strong></div><div className="panel alert-stat"><span>Unresolved alerts</span><strong>{openCount}</strong></div><div className="panel alert-stat"><span>Enabled notifications</span><strong>{aiHistory ? 'Local' : '—'}</strong></div></div>
    <div className="panel events-panel">
      <div className="panel-heading"><div><h3>Alert history</h3><p>Evidence and status are stored locally</p></div><div className="alert-filters"><input aria-label="Search alerts" placeholder="Search events" value={query} onChange={event => setQuery(event.target.value)}/><select aria-label="Filter severity" value={severity} onChange={event => setSeverity(event.target.value)}><option value="all">All severities</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select><select aria-label="Filter alert type" value={type} onChange={event => setType(event.target.value)}><option value="all">All types</option><option value="entry_exit">Entry / exit</option><option value="restricted_intrusion">Intrusion</option><option value="loitering">Loitering</option><option value="crowd_threshold">Crowd threshold</option><option value="camera_disconnected">Camera disconnected</option><option value="ai_worker_disconnected">AI worker disconnected</option><option value="detection_failure">Detection failure</option></select></div></div>
      {filtered.map(alert => <div className="event-row real-event-row" key={alert.id}>
        <div className={`event-type-icon ${alert.severity}`}><AlertTriangle size={17}/></div>
        {alert.evidence && <img className="alert-evidence" src={alert.evidence} alt="Detection evidence"/>}
        <div className="event-main"><strong>{alert.title}</strong><span>{alert.detail} · {alert.camera}{alert.trackingId ? ` · Track #${alert.trackingId}` : ''}{alert.zone ? ` · ${alert.zone}` : ''}</span></div>
        <div className="event-time"><strong>{new Date(alert.timestamp).toLocaleString()}</strong><span>{alert.resolved ? 'Resolved' : alert.acknowledged ? 'Acknowledged' : 'Needs review'}</span></div>
        <span className={`severity-chip ${alert.severity}`}>{alert.severity}</span>
        {!alert.resolved && <div className="alert-actions">{!alert.acknowledged && <button className="button secondary small" onClick={() => onUpdateAlert(alert.id, 'acknowledge')}>Acknowledge</button>}<button className="button secondary small" onClick={() => onUpdateAlert(alert.id, 'resolve')}>Resolve</button></div>}
      </div>)}
      {!filtered.length && <div className="empty-analytics">{alerts.length ? 'No alerts match those filters.' : 'No alerts recorded. Alerts are created only from actual camera events.'}</div>}
    </div>
  </>;
}

function SettingsPage({ draft, changeDraft, onSave, onReset, saving }) {
  return <>
    <PageHeading eyebrow="PREFERENCES" title="Settings" subtitle="Configure how QueuePulse AI behaves for your shop." action={<button className="button primary" onClick={onSave} disabled={saving}><Check size={16}/>{saving ? 'Saving…' : 'Save changes'}</button>} />
    <div className="settings-layout"><div className="settings-nav panel"><span className="settings-nav-label">PREFERENCES</span><a href="#general" className="selected"><Store size={16}/> General</a><a href="#monitoring"><SlidersHorizontal size={16}/> Monitoring rules</a><a href="#notifications"><Bell size={16}/> Notifications</a><a href="#privacy"><ShieldCheck size={16}/> Data & privacy</a></div>
      <div className="settings-main">
        <section className="panel settings-section" id="general"><div className="settings-section-heading"><div className="settings-icon blue"><Store size={18}/></div><div><h3>General</h3><p>Basic details shown across your workspace.</p></div></div><div className="form-grid"><label className="field-label full-width">Shop name<input value={draft.shopName} maxLength="80" onChange={e => changeDraft('shopName', e.target.value)} placeholder="e.g. Sharma General Store"/><small>This name appears in your sidebar and reports.</small></label><label className="field-label">Opening time<input type="time" value={draft.openingTime} onChange={e => changeDraft('openingTime', e.target.value)}/></label><label className="field-label">Closing time<input type="time" value={draft.closingTime} onChange={e => changeDraft('closingTime', e.target.value)}/></label></div></section>
        <section className="panel settings-section" id="monitoring"><div className="settings-section-heading"><div className="settings-icon orange"><SlidersHorizontal size={18}/></div><div><h3>Monitoring rules</h3><p>Detection zones, confidence, count line, loitering and crowd thresholds are configured in Live Monitor.</p></div></div><div className="form-grid"><label className="field-label">Queue alert threshold<div className="input-with-suffix"><input type="number" min="1" max="200" value={draft.queueThreshold} onChange={e => changeDraft('queueThreshold', Number(e.target.value))}/><span>people</span></div><small>Saved preference for the queue monitor.</small></label><label className="field-label">Alert duration<div className="input-with-suffix"><input type="number" min="10" max="3600" step="10" value={draft.alertDurationSeconds} onChange={e => changeDraft('alertDurationSeconds', Number(e.target.value))}/><span>seconds</span></div><small>General alert preference.</small></label><label className="field-label">Maximum simultaneous cameras<select value={draft.maxConcurrentCameras} onChange={e => changeDraft('maxConcurrentCameras', Number(e.target.value))}><option value="1">1 camera</option><option value="2">2 cameras</option><option value="4">4 cameras</option><option value="8">8 cameras</option><option value="16">16 cameras</option></select><small>New connections are refused at the limit; existing cameras stay connected.</small></label><label className="field-label">Maximum reconnect attempts<select value={draft.cameraReconnectAttempts || 0} onChange={e => changeDraft('cameraReconnectAttempts', Number(e.target.value))}><option value="0">Unlimited (exponential backoff)</option>{[3, 5, 10, 20, 30].map(attempts => <option key={attempts} value={attempts}>{attempts} attempts</option>)}</select><small>Applies to new and restarted RTSP connections.</small></label></div><ToggleRow title="Reconnect RTSP cameras on startup" description="Automatically reconnect saved RTSP profiles after QueuePulse AI starts." checked={draft.autoReconnectCameras} onChange={value => changeDraft('autoReconnectCameras', value)}/><ToggleRow title="Enable alert rules" description="Evaluate configured zone rules when the worker is processing live frames." checked={draft.alertsEnabled} onChange={value => changeDraft('alertsEnabled', value)}/></section>
        <section className="panel settings-section" id="notifications"><div className="settings-section-heading"><div className="settings-icon purple"><Bell size={18}/></div><div><h3>Notifications</h3><p>Choose how you want to be notified about events.</p></div></div><ToggleRow title="Sound notifications" description="Play a short local tone when an actual alert is generated." checked={draft.soundEnabled} onChange={value => changeDraft('soundEnabled', value)}/><ToggleRow title="Email notifications" description="Email delivery is not configured in this local release." checked={draft.emailNotifications} onChange={value => changeDraft('emailNotifications', value)}/></section>
        <section className="panel settings-section" id="privacy"><div className="settings-section-heading"><div className="settings-icon green"><ShieldCheck size={18}/></div><div><h3>Data & privacy</h3><p>Control how long your local event history should be retained.</p></div></div><label className="field-label retention-field">Event history retention<select value={draft.retentionDays} onChange={e => changeDraft('retentionDays', Number(e.target.value))}><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option></select><small>Retention is stored as a preference; automatic database cleanup is not implemented.</small></label><div className="privacy-note"><ShieldCheck size={16}/><span>Video frames are processed locally. Alert metadata, traffic samples, and evidence images remain in app data.</span></div></section>
        <div className="settings-bottom"><button className="button secondary" onClick={onReset}>Reset defaults</button><button className="button primary" onClick={onSave} disabled={saving}><Check size={16}/>{saving ? 'Saving…' : 'Save changes'}</button></div>
      </div></div>
  </>;
}

function ToggleRow({ title, description, checked, onChange }) {
  return <div className="toggle-row"><div><strong>{title}</strong><span>{description}</span></div><button className={cx('toggle-switch', checked && 'on')} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><i/></button></div>;
}

export default App;
