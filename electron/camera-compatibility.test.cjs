const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const {
  cameraErrorDetails,
  classifyCaptureFailure,
  evaluateVideoHealth,
  probeRtspPort,
  validateRtspEndpoint,
} = require('./camera-compatibility.cjs');

const isLocalIpv4 = address => net.isIP(address) === 4
  && (address.startsWith('127.')
    || address.startsWith('10.')
    || address.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    || address.startsWith('169.254.'));

test('accepts a local credential-free RTSP endpoint', () => {
  const url = validateRtspEndpoint('rtsp://127.0.0.1:8554/live/sub?tcp', isLocalIpv4);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '8554');
});

test('rejects invalid schemes, public hosts, and embedded credentials', () => {
  for (const value of [
    'http://192.168.1.25/video',
    'rtsp://8.8.8.8/live',
    'rtsp://user:password@192.168.1.25/live',
    'rtsp://192.168.1.25:99999/live',
  ]) {
    assert.throws(() => validateRtspEndpoint(value, isLocalIpv4));
  }
});

test('classifies camera failures without exposing raw FFmpeg messages', () => {
  assert.equal(classifyCaptureFailure('401 Unauthorized'), 'authentication_failed');
  assert.equal(classifyCaptureFailure('DESCRIBE request failed: 404 Not Found'), 'invalid_rtsp_path');
  assert.equal(classifyCaptureFailure('Could not find decoder for codec h265'), 'unsupported_codec');
  assert.equal(classifyCaptureFailure('Connection timed out'), 'connection_timeout');
  assert.equal(classifyCaptureFailure('RTSP connection reset by peer'), 'network_interruption');
  assert.match(cameraErrorDetails('authentication_failed').message, /rejected the saved credentials/);
});

test('flags missing, stale, black, and slow video frames', () => {
  assert.equal(evaluateVideoHealth({ hasFrame: false }), 'no_frames');
  assert.equal(evaluateVideoHealth({ hasFrame: true, frameAgeMs: 12001 }), 'no_frames');
  assert.equal(evaluateVideoHealth({ hasFrame: true, frameAgeMs: 10, brightness: 0 }), 'black_screen');
  assert.equal(evaluateVideoHealth({ hasFrame: true, frameAgeMs: 10, brightness: 42, fps: 0.5 }), 'low_fps');
  assert.equal(evaluateVideoHealth({ hasFrame: true, frameAgeMs: 10, brightness: 42, fps: 10 }), '');
});

test('measures a reachable local RTSP port using a real TCP socket', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await probeRtspPort('127.0.0.1', port);
    assert.equal(result.reachable, true);
    assert.equal(result.category, '');
    assert.ok(result.latencyMs >= 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('reports a refused local TCP port', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  const result = await probeRtspPort('127.0.0.1', port);
  assert.equal(result.reachable, false);
  assert.equal(result.category, 'connection_refused');
});
