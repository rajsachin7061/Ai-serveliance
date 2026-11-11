const crypto = require('node:crypto');
const dgram = require('node:dgram');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const DISCOVERY_TIMEOUT_MS = 3500;
const MAX_DEVICES = 64;
let activeDiscoverySocket;

function isPrivateIpv4(address) {
  if (net.isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number);
  return octets[0] === 127
    || octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254);
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function decodeXml(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function readTag(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<(?:(?:[\\w.-]+):)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${escaped}\\s*>`, 'i'));
  return match ? decodeXml(match[1].trim()) : '';
}

function validatedDeviceUrl(raw, deviceIp) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username || url.password
    || net.isIP(url.hostname) !== 4
    || url.hostname !== deviceIp
    || (url.port && ![80, 443, 5000, 8000, 8080, 8081, 8899].includes(Number(url.port)))
    || !isPrivateIpv4(url.hostname)) return null;
  return url;
}

function parseProbeResponse(packet, address) {
  if (!isPrivateIpv4(address)) return null;
  const xml = packet.toString('utf8');
  if (!/<(?:[\w.-]+:)?ProbeMatch\b/i.test(xml)
    || !/NetworkVideoTransmitter|(?:^|\s)[\w.-]*:Device(?:\s|$)/i.test(readTag(xml, 'Types'))) return null;
  const xaddrs = readTag(xml, 'XAddrs').split(/\s+/).filter(Boolean);
  const endpoint = xaddrs.map(value => validatedDeviceUrl(value, address)).find(Boolean);
  if (!endpoint) return null;
  const scopes = readTag(xml, 'Scopes').split(/\s+/);
  const name = scopes.find(scope => /\/name\//i.test(scope))?.split('/').pop() || '';
  const hardware = scopes.find(scope => /\/hardware\//i.test(scope))?.split('/').pop() || '';
  return {
    id: `onvif-${address}`,
    name: safeDecode(name || hardware || `ONVIF camera (${address})`),
    ipAddress: address,
    manufacturer: '',
    model: hardware ? safeDecode(hardware) : '',
    xaddr: endpoint.href,
    sourceType: 'ONVIF camera',
    authenticationStatus: 'Unknown',
  };
}

function stopDiscovery() {
  if (activeDiscoverySocket) {
    const socket = activeDiscoverySocket;
    activeDiscoverySocket = null;
    try { socket.close(); } catch {}
  }
}

function discoverOnvif() {
  stopDiscovery();
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    activeDiscoverySocket = socket;
    const devices = new Map();
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (activeDiscoverySocket === socket) activeDiscoverySocket = null;
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve([...devices.values()].slice(0, MAX_DEVICES));
    };
    const timer = setTimeout(() => finish(), DISCOVERY_TIMEOUT_MS);
    socket.on('error', error => finish(error));
    socket.on('close', () => finish());
    socket.on('message', (message, remote) => {
      const device = parseProbeResponse(message, remote.address);
      if (device && devices.size < MAX_DEVICES) devices.set(device.id, device);
    });
    socket.bind(0, () => {
      const probe = Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>'
        + '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" '
        + 'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" '
          + 'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" '
          + 'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
        + '<e:Header><w:MessageID>uuid:' + crypto.randomUUID() + '</w:MessageID>'
        + '<w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>'
        + '<w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>'
        + '</e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types>'
        + '</d:Probe></e:Body></e:Envelope>',
      );
      socket.send(probe, 3702, '239.255.255.250', error => {
        if (error) finish(error);
      });
    });
  });
}

function wsSecurityHeader(username, password) {
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('Provide both an ONVIF username and password, or leave both blank.');
  }
  if (!username && !password) return '';
  if (typeof username !== 'string' || typeof password !== 'string'
    || username.length > 128 || password.length > 256) {
    throw new Error('Invalid ONVIF credentials.');
  }
  const nonce = crypto.randomBytes(16);
  const created = new Date().toISOString();
  const digest = crypto.createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)]))
    .digest('base64');
  const escapeXml = value => value.replace(/[<>&"']/g, char => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[char]));
  return '<s:Header><wsse:Security s:mustUnderstand="1" '
    + 'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" '
    + 'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">'
    + '<wsse:UsernameToken><wsse:Username>' + escapeXml(username) + '</wsse:Username>'
    + '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">'
    + digest + '</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">'
    + nonce.toString('base64') + '</wsse:Nonce><wsu:Created>' + created
    + '</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>';
}

function soapRequest(endpoint, body, credentials) {
  const url = validatedDeviceUrl(endpoint, new URL(endpoint).hostname);
  if (!url) return Promise.reject(new Error('The ONVIF endpoint is not a validated local device address.'));
  const security = wsSecurityHeader(credentials?.username || '', credentials?.password || '');
  const envelope = '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
    + 'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" '
    + 'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" '
    + 'xmlns:tt="http://www.onvif.org/ver10/schema">'
    + security + '<s:Body>' + body + '</s:Body></s:Envelope>';
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: 'POST',
      timeout: 5000,
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(envelope),
      },
    }, response => {
      let result = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        result += chunk;
        if (result.length > 256 * 1024) request.destroy(new Error('ONVIF response is too large.'));
      });
      response.on('end', () => {
        if (response.statusCode === 401 || response.statusCode === 403) {
          reject(new Error('ONVIF authentication failed. Check the authorized camera credentials.'));
        } else if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`ONVIF device returned HTTP ${response.statusCode}.`));
        } else if (/<(?:\w+:)?Fault\b/i.test(result)) {
          reject(new Error('The ONVIF device rejected the request. Verify the account permissions.'));
        } else {
          resolve(result);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('ONVIF request timed out.')));
    request.on('error', error => reject(error.message.includes('timed out')
      ? error : new Error('Could not communicate with the ONVIF device.')));
    request.end(envelope);
  });
}

async function getOnvifProfiles({ ipAddress, xaddr, username, password }) {
  if (!isPrivateIpv4(ipAddress) || !validatedDeviceUrl(xaddr, ipAddress)) {
    throw new Error('The ONVIF endpoint is not a validated local device address.');
  }
  const credentials = { username: username || '', password: password || '' };
  const deviceInfoXml = await soapRequest(xaddr, '<tds:GetDeviceInformation/>', credentials);
  const deviceInfo = {
    manufacturer: readTag(deviceInfoXml, 'Manufacturer').slice(0, 80),
    model: readTag(deviceInfoXml, 'Model').slice(0, 80),
  };
  const deviceXml = await soapRequest(xaddr,
    '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>', credentials);
  const capabilityMatch = deviceXml.match(/<(?:[\w.-]+:)?Media\b[\s\S]*?<(?:[\w.-]+:)?XAddr\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?XAddr>/i);
  const mediaEndpoint = capabilityMatch && validatedDeviceUrl(decodeXml(capabilityMatch[1].trim()), ipAddress);
  if (!mediaEndpoint) throw new Error('The ONVIF device did not provide a valid local media endpoint.');
  const profileXml = await soapRequest(mediaEndpoint.href, '<trt:GetProfiles/>', credentials);
  const profileBlocks = [...profileXml.matchAll(/<(?:[\w.-]+:)?Profiles\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Profiles>/gi)];
  let failedProfiles = 0;
  const profiles = await Promise.all(profileBlocks.slice(0, 32).map(async (match, index) => {
    const token = match[1].match(/\btoken\s*=\s*["']([^"']{1,128})["']/i)?.[1];
    if (!token) return null;
    const name = readTag(match[2], 'Name') || `Camera channel ${index + 1}`;
    const escapeXml = value => value.replace(/[<>&"']/g, char => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
    }[char]));
    try {
      const streamXml = await soapRequest(mediaEndpoint.href,
        '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>'
        + '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>'
        + `<trt:ProfileToken>${escapeXml(token)}</trt:ProfileToken></trt:GetStreamUri>`, credentials);
      const streamUrl = readTag(streamXml, 'Uri');
      const parsed = new URL(streamUrl);
      if (parsed.protocol !== 'rtsp:' || parsed.username || parsed.password
        || net.isIP(parsed.hostname) !== 4 || parsed.hostname !== ipAddress) return null;
      return { name: name.slice(0, 80), streamUrl: parsed.href };
    } catch (error) {
      if (error.message.includes('authentication failed')) throw error;
      failedProfiles += 1;
      return null;
    }
  }));
  return { ...deviceInfo, profiles: profiles.filter(Boolean), failedProfiles };
}

module.exports = { discoverOnvif, stopDiscovery, getOnvifProfiles, isPrivateIpv4 };
