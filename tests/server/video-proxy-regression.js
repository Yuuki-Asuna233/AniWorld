const assert = require('assert');
const { rewriteHlsManifest } = require('../../apps/server/src/routes/video');

const req = {
  headers: { 'x-forwarded-proto': 'https' },
  protocol: 'http',
  query: { access_token: 'test-token' },
  get: () => 'media.example.com'
};

const source = [
  '#EXTM3U',
  '#EXT-X-MAP:URI="https://cdn.example/init.png",BYTERANGE="1387@12421"',
  '#EXTINF:10.5,',
  '#EXT-X-BYTERANGE:2000@12421',
  'https://cdn.example/segment-1.png',
  '#EXTINF:10.5,',
  '#EXT-X-BYTERANGE:3000',
  'https://cdn.example/segment-1.png',
  '#EXT-X-ENDLIST'
].join('\n');

const rewritten = rewriteHlsManifest(source, 'https://origin.example/video.m3u8', req);
assert(!rewritten.includes('#EXT-X-BYTERANGE'));
assert(!rewritten.includes('BYTERANGE='));
assert(rewritten.includes('slice_start=12421&slice_length=1387'));
assert(rewritten.includes('slice_start=12421&slice_length=2000'));
assert(rewritten.includes('slice_start=14421&slice_length=3000'));
assert(rewritten.includes('access_token=test-token'));

console.log('video proxy regression: ok');
