const net = require('node:net');

function validateRtspEndpoint(value, isPrivateIpv4) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Enter a valid local RTSP stream URL.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid local RTSP stream URL.');
  }
  if (url.protocol !== 'rtsp:' || url.username || url.password
    || !isPrivateIpv4(url.hostname) || (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) > 65535))) {
    throw new Error('RTSP must use a private local IPv4 address without embedded credentials.');
  }
  return url;
}

function classifyCaptureFailure(text) {
  const message = String(text || '').toLowerCase();
  if (/401|403|unauthori[sz]ed|authentication failed|invalid credentials/.test(message)) return 'authentication_failed';
  if (/404|not found|describe request failed/.test(message)) return 'invalid_rtsp_path';
  if (/decoder.*not found|unsupported.*codec|unknown codec|could not find decoder/.test(message)) return 'unsupported_codec';
  if (/connection reset|broken pipe|end of file|unexpected eof|read error/.test(message)) return 'network_interruption';
  if (/timed out|timeout/.test(message)) return 'connection_timeout';
  if (/connection refused|actively refused/.test(message)) return 'connection_refused';
  if (/network is unreachable|host is unreachable|no route to host/.test(message)) return 'network_unreachable';
  return '';
}

function cameraErrorDetails(category) {
  const messages = {
    camera_not_found: {
      message: 'QueuePulse could not find this camera on the local network.',
      troubleshooting: ['Check that the camera and computer are connected to the same network.', 'Confirm the camera IP address in its manufacturer app or NVR.'],
    },
    invalid_ip: {
      message: 'The camera IP address is not a valid local IPv4 address.',
      troubleshooting: ['Enter the camera’s current private IPv4 address.', 'Check whether the camera received a new address from DHCP.'],
    },
    network_unreachable: {
      message: 'The camera network cannot currently be reached.',
      troubleshooting: ['Check power, Ethernet/Wi-Fi, VLAN, and local routing.', 'Confirm the computer and camera are on networks allowed to communicate.'],
    },
    connection_timeout: {
      message: 'The camera did not respond before the connection timed out.',
      troubleshooting: ['Check the camera is online and the IP address is current.', 'Allow QueuePulse through Windows Firewall and confirm RTSP is enabled.'],
    },
    connection_refused: {
      message: 'The camera refused the RTSP connection.',
      troubleshooting: ['Confirm the RTSP service is enabled in the camera/NVR settings.', 'Check the RTSP port (commonly 554) and the selected stream path.'],
    },
    authentication_failed: {
      message: 'The camera rejected the saved credentials.',
      troubleshooting: ['Re-enter the RTSP username and password.', 'Confirm this account has permission to view the selected stream.'],
    },
    invalid_rtsp_path: {
      message: 'The camera is reachable, but the RTSP stream path was not found.',
      troubleshooting: ['Copy the exact main- or sub-stream URL from the camera/NVR documentation.', 'Use ONVIF discovery when supported, or enter the vendor-specific URL manually.'],
    },
    unsupported_codec: {
      message: 'The stream opened, but this computer could not decode its video codec.',
      troubleshooting: ['Switch the camera stream to H.264, or install a decoder that supports this H.265 profile.', 'Check that the installed OpenCV FFmpeg build supports the camera codec.'],
    },
    black_screen: {
      message: 'The received video is nearly black.',
      troubleshooting: ['Check the lens cover, camera exposure, IR/night mode, and whether the selected NVR channel is active.'],
    },
    no_frames: {
      message: 'The RTSP connection has not delivered a video frame.',
      troubleshooting: ['Verify the selected stream is active and has video enabled.', 'Check the camera/NVR channel, codec, and network bandwidth.'],
    },
    network_interruption: {
      message: 'The camera stream was interrupted by a network or transport error.',
      troubleshooting: ['Check cables, Wi-Fi signal, switch ports, and packet loss.', 'Try RTSP over TCP or reduce the stream bitrate.'],
    },
    camera_disconnected: {
      message: 'The camera stopped delivering video.',
      troubleshooting: ['Check camera power and network link, then reconnect the camera.', 'Confirm its IP address has not changed.'],
    },
    camera_ip_changed: {
      message: 'The camera no longer responds at its saved IP address.',
      troubleshooting: ['Find the camera’s current address in the router or NVR.', 'Update the RTSP URL and save the camera profile.'],
    },
    onvif_discovery_failed: {
      message: 'No ONVIF discovery response was received.',
      troubleshooting: ['Enable ONVIF/WS-Discovery and allow multicast UDP on the camera network.', 'Some cameras are not discoverable; use their vendor RTSP URL manually.'],
    },
    insufficient_resources: {
      message: 'This computer does not currently have enough available camera capacity or memory.',
      troubleshooting: ['Disconnect an unused camera or increase the camera limit only if the PC can handle it.', 'Close other high-load applications or choose a lower-resolution sub-stream.'],
    },
    low_fps: {
      message: 'The camera is delivering video below the expected frame rate.',
      troubleshooting: ['Check camera frame-rate settings and available network bandwidth.', 'Try a lower-resolution sub-stream or reduce the configured processing FPS.'],
    },
    worker_disconnected: {
      message: 'The local AI worker is not connected.',
      troubleshooting: ['Check the Python 3 installation and worker dependencies.', 'Restart the AI worker from Live Monitor and review the local application logs.'],
    },
  };
  return messages[category] || {
    message: 'The camera connection is not healthy.',
    troubleshooting: ['Check camera power, the network, RTSP settings, and credentials.', 'Run Test Connection again to collect an updated diagnostic report.'],
  };
}

function evaluateVideoHealth({ hasFrame, frameAgeMs, decoding, fps, brightness }) {
  if (!hasFrame) return 'no_frames';
  if (Number.isFinite(frameAgeMs) && frameAgeMs > 12000) return 'no_frames';
  if (decoding === 'Failed') return 'decoding_failed';
  if (Number.isFinite(brightness) && brightness < 2) return 'black_screen';
  if (Number.isFinite(fps) && fps < 1) return 'low_fps';
  return '';
}

function probeRtspPort(host, port, timeoutMs = 2500) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, latencyMs: Date.now() - startedAt });
    };
    socket.setTimeout(timeoutMs, () => finish({ reachable: false, category: 'connection_timeout' }));
    socket.once('connect', () => finish({ reachable: true, category: '' }));
    socket.once('error', error => {
      const categories = {
        ECONNREFUSED: 'connection_refused',
        ETIMEDOUT: 'connection_timeout',
        ENETUNREACH: 'network_unreachable',
        EHOSTUNREACH: 'network_unreachable',
        EADDRNOTAVAIL: 'invalid_ip',
      };
      finish({ reachable: false, category: categories[error.code] || 'camera_not_found' });
    });
  });
}

module.exports = {
  cameraErrorDetails,
  classifyCaptureFailure,
  evaluateVideoHealth,
  probeRtspPort,
  validateRtspEndpoint,
};
