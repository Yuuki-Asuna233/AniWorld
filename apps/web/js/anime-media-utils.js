function isLikelyHevcSource(source) {
  const text = [
    source?.video_type || '',
    source?.codec || '',
    source?.play_url || '',
    source?.proxy_url || ''
  ].join(' ').toLowerCase();
  return /h265|h\.265|hevc|hvc1|hev1/.test(text);
}

function browserReportsHevcSupport(videoEl) {
  const video = videoEl || document.createElement('video');
  const tests = [
    'video/mp4; codecs="hvc1"',
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/mp4; codecs="hev1"',
    'video/mp4; codecs="hev1.1.6.L93.B0"'
  ];
  return tests.some(type => video.canPlayType(type));
}

function hevcUnsupportedMessage() {
  return '当前播放源是 H265/HEVC 编码，当前浏览器不支持这个解码，所以网页端无法直接播放。' +
    '<br><small style="opacity:0.75">这不是播放地址失效：服务器已经拿到视频并能读取字节，但浏览器不能解码。可以用手机 App 播放，或在 Windows/浏览器安装 HEVC 解码支持；如果源站后续提供 H264 线路，网页端会自动选择。</small>' +
    '<br><button onclick="autoTestLines()" style="margin-top:8px;background:#e85d04;color:#fff;border:none;padding:8px 24px;border-radius:20px;cursor:pointer;font-size:14px">⚡ 智能选线</button>';
}

function withVideoCacheBust(url) {
  if (!url || !String(url).startsWith('/api/video')) return url;
  const separator = String(url).includes('?') ? '&' : '?';
  return url + separator + '_cb=' + Date.now().toString(36);
}
