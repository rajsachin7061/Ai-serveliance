const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('queuePulse', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  discoverCameras: () => ipcRenderer.invoke('camera:discover'),
  stopCameraDiscovery: () => ipcRenderer.invoke('camera:discovery-stop'),
  getOnvifProfiles: input => ipcRenderer.invoke('camera:onvif-profiles', input),
  saveCameraCredentials: input => ipcRenderer.invoke('camera:save-credentials', input),
  startCameraStream: input => ipcRenderer.invoke('camera:start-stream', input),
  testCameraConnection: input => ipcRenderer.invoke('camera:test-connection', input),
  retryCameraConnection: input => ipcRenderer.invoke('camera:retry', input),
  reconnectCamera: input => ipcRenderer.invoke('camera:reconnect', input),
  getCameraDiagnostics: cameraId => ipcRenderer.invoke('camera:diagnostics', { cameraId }),
  stopCameraStream: cameraId => ipcRenderer.invoke('camera:stop-stream', { cameraId }),
  reserveUsbCamera: cameraId => ipcRenderer.invoke('camera:reserve-usb', { cameraId }),
  releaseUsbCamera: cameraId => ipcRenderer.invoke('camera:release-usb', { cameraId }),
  reportUsbCameraStatus: (cameraId, status, diagnostics) =>
    ipcRenderer.invoke('camera:report-usb-status', { cameraId, status, diagnostics }),
  getCameraStatus: cameraId => ipcRenderer.invoke('camera:status', { cameraId }),
  startAi: () => ipcRenderer.invoke('ai:start'),
  stopAi: () => ipcRenderer.invoke('ai:stop'),
  sendAiFrame: frame => ipcRenderer.invoke('ai:frame', frame),
  loadAiHistory: () => ipcRenderer.invoke('ai:history'),
  printReport: report => ipcRenderer.invoke('report:print', report),
  saveReportPdf: report => ipcRenderer.invoke('report:save-pdf', report),
  updateAiAlert: update => ipcRenderer.invoke('ai:update-alert', update),
  recordAiSystemAlert: event => ipcRenderer.invoke('ai:system-alert', event),
  onAiEvent: callback => {
    const listener = (_event, alert) => callback(alert);
    ipcRenderer.on('ai:event', listener);
    return () => ipcRenderer.removeListener('ai:event', listener);
  },
  onAiTotals: callback => {
    const listener = (_event, totals) => callback(totals);
    ipcRenderer.on('ai:totals', listener);
    return () => ipcRenderer.removeListener('ai:totals', listener);
  },
  onAiStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('ai:status', listener);
    return () => ipcRenderer.removeListener('ai:status', listener);
  },
  onAiDetection: callback => {
    const listener = (_event, detection) => callback(detection);
    ipcRenderer.on('ai:detection', listener);
    return () => ipcRenderer.removeListener('ai:detection', listener);
  },
  onAiFrameError: callback => {
    const listener = (_event, error) => callback(error);
    ipcRenderer.on('ai:frame-error', listener);
    return () => ipcRenderer.removeListener('ai:frame-error', listener);
  },
  onCameraFrame: callback => {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on('camera:frame', listener);
    return () => ipcRenderer.removeListener('camera:frame', listener);
  },
  onCameraStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('camera:status', listener);
    return () => ipcRenderer.removeListener('camera:status', listener);
  },
  isDesktop: true,
});
