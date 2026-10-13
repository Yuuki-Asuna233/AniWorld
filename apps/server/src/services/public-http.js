const http = require('http');
const https = require('https');
const dns = require('dns/promises');
const net = require('net');

function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
  const [left, right] = address.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const groups = right !== undefined ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  const [first, second] = groups.map(group => parseInt(group, 16));
  // Allow global unicast only, excluding transition/protocol and documentation ranges.
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

async function resolvePublicUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (url.port && !['80', '443'].includes(url.port))) throw new Error('Unsupported media URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let timer;
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }]
    : await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 5000); })
    ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Media URL must resolve to a public address');
  return { url, address: addresses[0] };
}

// Resolve and pin the connection address on every hop, avoiding a second DNS lookup.
async function openPublicStream(value, { headers = {}, signal, timeout = 20000, method = 'GET' } = {}) {
  let target = value;
  for (let hop = 0; hop <= 5; hop++) {
    if (signal?.aborted) throw new Error('Request aborted');
    const { url, address } = await resolvePublicUrl(target);
    const { response, request } = await new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const request = lib.request(url, {
        method, headers, signal, timeout, agent: false,
        lookup: (_hostname, options, callback) => options.all
          ? callback(null, [address]) : callback(null, address.address, address.family)
      }, response => {
        // An error can occur while a redirect body is being discarded too.
        response.on('error', () => {});
        resolve({ response, request });
      });
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('Upstream timeout')));
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || hop === 5) throw new Error('Invalid or excessive media redirects');
      target = new URL(location, url).toString();
      continue;
    }
    return { response, request, url };
  }
}

module.exports = { openPublicStream, isPublicAddress };
