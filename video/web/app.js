'use strict';
const $ = id => document.getElementById(id);
const video = $('video');
const embedded = window.parent !== window;
const appRoot = new URL('./', location.href);
if (embedded) document.body.classList.add('embedded');
function parentMessage(type, value={}) {
  if (embedded) window.parent.postMessage({type, ...value}, location.origin);
}
let token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
if (location.hash) window.history.replaceState(null, '', location.pathname + location.search);
$('token-field').hidden = Boolean(token);
const maintenance = new URL(location.href); maintenance.port = '8090'; maintenance.pathname = '/'; maintenance.search = ''; maintenance.hash = '';
$('maintenance').href = maintenance.href;
let generation = 0, session = null, pc = null, previousInbound = null;
let videoControl = null, starting = false;
function renderControl() {
  if (!embedded) return;
  const blocked=videoControl?.enabled!==true || videoControl.offline;
  if (!session && !pc && !starting) {
    $('start').disabled=blocked;
    if (blocked) {
      const message=!videoControl || videoControl.enabled===null?'正在确认视频控制状态':videoControl.offline?'离线模式未连接设备':'全部视频已手动关闭，请先点击上方“恢复视频启动权限”';
      $('empty').hidden=false; $('empty').textContent=message;
      $('message').textContent=message; connection(message);
    } else if ($('start').dataset.controlBlocked==='true') {
      $('empty').textContent='等待开始观看';
      $('message').textContent='视频启动权限已恢复；点击“开始观看”后才会占用编码器。';
      connection('尚未观看');
    }
  }
  $('start').dataset.controlBlocked=String(blocked);
}
let frame = {}, frameCallback = null, callbackCount = 0, intervals = [], previousPresent = null;
let latestObservation = null;
Object.defineProperty(window, 'mixVideoObservation', {get: () => latestObservation});
const finite = value => typeof value === 'number' && Number.isFinite(value);
const shown = (value, decimals=0) => finite(value) ? value.toFixed(decimals) : '—';
const delta = (value, before) => finite(value) && finite(before) && value >= before ? value - before : null;
const rate = (value, before, seconds) => seconds > 0 && delta(value, before) !== null ? delta(value, before) / seconds : null;
const perFrameMs = (sum, beforeSum, count, beforeCount) => {
  const elapsed = delta(sum, beforeSum), frames = delta(count, beforeCount);
  return elapsed !== null && frames !== null && frames > 0 ? elapsed * 1000 / frames : null;
};


function qualityHint() {
  const mono = $('eye').value !== 'stereo';
  $('screen').classList.toggle('mono', mono);
  const widths = mono ? [320,480,640,800,960,1280,1600,1832] : [640,960,1280,1600,1920,2560,3200,3664];
  const selectedIndex = $('width').selectedIndex;
  Array.from($('width').options).forEach((option,i) => {
    const width = widths[i], height = (Math.ceil(width * 1920 / (mono ? 1832 : 3664)) + 1) & ~1;
    option.value = String(width); option.textContent = `${width} × ${height}${i === 7 ? ' · 原生' : ''}`;
  });
  $('width').selectedIndex = selectedIndex;
  const large = +$('width').value > 2560;
  Array.from($('fps').options).find(option => option.value === '60').disabled = large;
  if (large && +$('fps').value > 30) $('fps').value = '30';
  $('custom-field').hidden = $('bitrate').value !== 'custom';
  $('custom-bitrate').required = $('bitrate').value === 'custom';
  $('quality-hint').textContent = mono
    ? '单眼原生 1832 × 1920；在设备 GPU 上只转换所选眼，减少原始数据量。请求帧率不代表实测值。'
    : '双眼原生 3664 × 1920；宽度超过 2560 时最高请求 30 fps。自动优先协商 H.265，不支持时回退 H.264。';
}
function configureDisabled(value) {
  for (const id of ['width','fps','bitrate','custom-bitrate','codec','eye']) $(id).disabled = value;
  document.querySelectorAll('[data-preset]').forEach(b => b.disabled = value);
}
for (const id of ['width','bitrate','eye','codec']) $(id).addEventListener('change', qualityHint);
document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
  const values = {fluid:[1280,60,8000000],detail:[1920,60,20000000],native:[3664,30,40000000]}[b.dataset.preset];
  if ($('eye').value !== 'stereo') values[0] /= 2;
  ['width','fps','bitrate'].forEach((id,i) => $(id).value = String(values[i]));
  qualityHint();
}));
qualityHint();

function connection(text, live=false) {
  $('connection').textContent = text;
  $('connection').className = live ? 'live' : '';
  parentMessage('mix-video-status', {text, live});
}
async function api(path, options={}) {
  const headers = {'Authorization': 'Bearer ' + token, ...(options.body ? {'Content-Type': 'application/json'} : {})};
  const response = await fetch(new URL(path.replace(/^\//, ''), appRoot), {...options, headers, signal: AbortSignal.timeout(path === '/api/session' ? 22000 : 10000)});
  if (response.status === 401) { $('token-field').hidden = false; throw Error('访问密钥无效'); }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    let message = detail.error || ('服务返回 HTTP ' + response.status);
    if (message.includes('All video is manually disabled')) message = '全部视频已手动关闭，请在调试台恢复视频启动权限';
    else if (message.includes('Encoder quota reached')) message = '编码器配额已满，请先停止其他视频流';
    if (typeof detail.reason === 'string' && detail.reason.trim() && detail.reason !== message) message += '：' + detail.reason.slice(0, 240);
    const error = Error(message); error.status = response.status; throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}
function recordFrame(now, metadata) {
  if (finite(frame.callbackNow)) intervals.push(now - frame.callbackNow);
  if (intervals.length > 240) intervals.shift();
  ++callbackCount;
  frame = {callbackNow: now, presentedFrames: metadata.presentedFrames,
    mediaTime: metadata.mediaTime, width: metadata.width, height: metadata.height,
    expectedDisplayTime: metadata.expectedDisplayTime, processingDuration: metadata.processingDuration};
  $('empty').hidden = true;
  if (pc) frameCallback = video.requestVideoFrameCallback(recordFrame);
}
function resetMetrics() {
  previousInbound = previousPresent = latestObservation = null;
  frame = {}; callbackCount = 0; intervals = [];
  for (const id of ['decoder','receive-rate','receive-count','receive-bytes','decoded-size','power-efficient',
    'present-rate','present-count','present-interval','media-time','frame-age',
    'jitter-buffer-delay','decode-delay','ice-rtt','capture-reader-delay','reader-encoder-delay',
    'capture-encoder-delay','encoder-delay']) $(id).textContent = '—';
  $('server-stats').textContent = '等待服务端统计';
}
async function stopSession(message='已退出观看') {
  ++generation;
  const oldSession = session, oldPeer = pc;
  session = pc = null;
  starting = false;
  if (frameCallback !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallback);
  frameCallback = null;
  if (oldPeer) { oldPeer.ontrack = oldPeer.onicecandidate = oldPeer.onconnectionstatechange = null; oldPeer.close(); }
  video.pause(); video.srcObject = null;
  $('empty').hidden = false; $('empty').textContent = '视频已停止';
  $('start').disabled = false; $('stop').disabled = true;
  configureDisabled(false);
  connection('未连接'); $('message').textContent = message;
  renderControl();
  if (oldSession) {
    try { await api('/api/session/' + encodeURIComponent(oldSession), {method:'DELETE', keepalive:true}); }
    catch (error) { $('message').textContent = message + '；服务端释放未确认：' + error.message; }
  }
}
async function pollIce(epoch, id, peer, seen) {
  if (epoch !== generation) return;
  try {
    const reply = await api('/api/session/' + encodeURIComponent(id) + '/ice');
    if (epoch !== generation) return;
    for (const candidate of reply.candidates || []) {
      const key = JSON.stringify(candidate);
      if (!seen.has(key)) { await peer.addIceCandidate(candidate); seen.add(key); }
    }
    if (reply.state === 'failed' || reply.state === 'closed') {
      if (peer.mixStarting) { peer.mixStartupError = '服务端视频会话已结束：' + reply.state; return; }
      await stopSession('服务端视频会话已结束：' + reply.state); return;
    }
  } catch (error) {
    if (epoch === generation && [404,410].includes(error.status)) { if(session===id)session=null; await stopSession('服务端视频会话已结束');return; }
    if (epoch === generation) $('message').textContent = '信令暂不可用：' + error.message;
  }
  if (epoch === generation) setTimeout(() => pollIce(epoch, id, peer, seen), 250);
}
async function pollStats(epoch, id, peer) {
  if (epoch !== generation) return;
  try {
    const reports = await peer.getStats();
    if (epoch !== generation) return;
    const inbound = [...reports.values()].filter(r => r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video'))
      .sort((a,b) => (b.bytesReceived || 0) - (a.bytesReceived || 0))[0];
    const now = performance.now(), observation = {peer_state: peer.connectionState, sampled_at_ms: now};
    if (inbound) {
      const codec = reports.get(inbound.codecId);
      const seconds = previousInbound && previousInbound.id === inbound.id ? (inbound.timestamp - previousInbound.timestamp) / 1000 : 0;
      const receivedRate = rate(inbound.framesReceived, previousInbound?.framesReceived, seconds);
      const decodedRate = rate(inbound.framesDecoded, previousInbound?.framesDecoded, seconds);
      const receivedDelta = seconds > 0 ? delta(inbound.framesReceived, previousInbound?.framesReceived) : null;
      const decodedDelta = seconds > 0 ? delta(inbound.framesDecoded, previousInbound?.framesDecoded) : null;
      const bytesDelta = seconds > 0 ? delta(inbound.bytesReceived, previousInbound?.bytesReceived) : null;
      const droppedDelta = delta(inbound.framesDropped, previousInbound?.framesDropped);
      const bytesRate = rate(inbound.bytesReceived, previousInbound?.bytesReceived, seconds);
      const jitterBufferMs = seconds > 0 ? perFrameMs(inbound.jitterBufferDelay, previousInbound?.jitterBufferDelay,
        inbound.jitterBufferEmittedCount, previousInbound?.jitterBufferEmittedCount) : null;
      const decodeMs = seconds > 0 ? perFrameMs(inbound.totalDecodeTime, previousInbound?.totalDecodeTime,
        inbound.framesDecoded, previousInbound?.framesDecoded) : null;
      const transport = reports.get(inbound.transportId);
      const pair = reports.get(transport?.selectedCandidatePairId);
      const iceRttMs = pair?.type === 'candidate-pair' && pair.state === 'succeeded' && finite(pair.currentRoundTripTime)
        ? pair.currentRoundTripTime * 1000 : null;
      observation.inbound = {id: inbound.id, timestamp: inbound.timestamp, framesReceived: inbound.framesReceived ?? null,
        framesDecoded: inbound.framesDecoded ?? null, framesDropped: inbound.framesDropped ?? null,
        bytesReceived: inbound.bytesReceived ?? null, received_fps: receivedRate, decoded_fps: decodedRate,
        interval_seconds: seconds || null, received_since_previous: receivedDelta, decoded_since_previous: decodedDelta,
        bytes_since_previous: bytesDelta,
        dropped_since_previous: seconds > 0 ? droppedDelta : null, bitrate_bps: bytesRate === null ? null : bytesRate * 8,
        decoderImplementation: inbound.decoderImplementation ?? null, powerEfficientDecoder: inbound.powerEfficientDecoder ?? null,
        codec: codec?.mimeType ?? null, frameWidth: inbound.frameWidth ?? null, frameHeight: inbound.frameHeight ?? null};
      observation.browser_latency = {scope: 'separate receiver-stage means and selected ICE/STUN RTT; not end-to-end',
        interval_seconds: seconds || null,
        jitterBufferDelay: inbound.jitterBufferDelay ?? null,
        jitterBufferEmittedCount: inbound.jitterBufferEmittedCount ?? null,
        totalDecodeTime: inbound.totalDecodeTime ?? null,
        jitter_buffer_delay_delta_seconds: seconds > 0 ? delta(inbound.jitterBufferDelay, previousInbound?.jitterBufferDelay) : null,
        jitter_buffer_emitted_delta: seconds > 0 ? delta(inbound.jitterBufferEmittedCount, previousInbound?.jitterBufferEmittedCount) : null,
        decode_time_delta_seconds: seconds > 0 ? delta(inbound.totalDecodeTime, previousInbound?.totalDecodeTime) : null,
        decoded_frames_delta: decodedDelta,
        jitter_buffer_mean_ms: jitterBufferMs, decode_mean_ms: decodeMs,
        packet_jitter_ms: finite(inbound.jitter) ? inbound.jitter * 1000 : null,
        selected_candidate_pair_id: pair?.id ?? null, ice_rtt_ms: iceRttMs};
      $('decoder').textContent = (codec?.mimeType || '编码信息未提供') + ' / ' + (inbound.decoderImplementation || '解码器信息未提供');
      $('receive-rate').textContent = shown(receivedRate,1) + ' / ' + shown(decodedRate,1) + ' fps';
      $('receive-count').textContent = [inbound.framesReceived,inbound.framesDecoded,inbound.framesDropped].map(v => shown(v)).join(' / ') + '（本段 +' + [receivedDelta,decodedDelta,seconds > 0 ? droppedDelta : null].map(v=>shown(v)).join(' / +') + '）';
      $('receive-bytes').textContent = shown(inbound.bytesReceived) + ' B（本段 +' + shown(bytesDelta) + '）/ ' + shown(bytesRate === null ? null : bytesRate * 8 / 1e6,2) + ' Mbps';
      $('decoded-size').textContent = shown(inbound.frameWidth) + ' × ' + shown(inbound.frameHeight);
      $('power-efficient').textContent = inbound.powerEfficientDecoder == null ? '浏览器未提供' : 'powerEfficientDecoder = ' + inbound.powerEfficientDecoder;
      $('jitter-buffer-delay').textContent = shown(jitterBufferMs,2) + ' ms';
      $('decode-delay').textContent = shown(decodeMs,2) + ' ms';
      $('ice-rtt').textContent = shown(iceRttMs,2) + ' ms';
      previousInbound = inbound;
      if (!finite(peer.mixLastDecodeProgress) || decodedDelta > 0) peer.mixLastDecodeProgress = now;
      if (peer.connectionState === 'connected' && bytesDelta > 0 && decodedDelta === 0
          && now-peer.mixLastDecodeProgress > 1500 && now-(peer.mixLastKeyframeRequest || 0) > 1000) {
        peer.mixLastKeyframeRequest = now;
        void api('/api/session/' + encodeURIComponent(id) + '/keyframe', {method:'POST', body:'{}'})
          .catch(error => { if (epoch === generation) $('message').textContent = '请求恢复画面失败：' + error.message; });
      }
    }
    const presentSeconds = previousPresent ? (now - previousPresent.now) / 1000 : 0;
    const presentRate = rate(frame.presentedFrames, previousPresent?.presentedFrames, presentSeconds);
    const callbackRate = rate(callbackCount, previousPresent?.callbackCount, presentSeconds);
    const ordered = intervals.slice().sort((a,b) => a-b);
    const quantile = fraction => ordered.length ? ordered[Math.floor((ordered.length-1)*fraction)] : null;
    observation.presentation = {...frame, callbackCount, presented_fps: presentRate, callback_hz: callbackRate,
      interval_seconds: presentSeconds || null,
      presented_since_previous: presentSeconds > 0 ? delta(frame.presentedFrames, previousPresent?.presentedFrames) : null,
      callbacks_since_previous: presentSeconds > 0 ? delta(callbackCount, previousPresent?.callbackCount) : null,
      last_callback_age_ms: finite(frame.callbackNow) ? now-frame.callbackNow : null,
      callback_interval_p50_ms: quantile(.5), callback_interval_p95_ms: quantile(.95),
      callback_interval_max_ms: quantile(1), callback_interval_scope: 'up to 240 most recent real video callbacks',
      requestVideoFrameCallback_supported: Boolean(video.requestVideoFrameCallback)};
    $('present-rate').textContent = video.requestVideoFrameCallback ? shown(presentRate,1) + ' fps / ' + shown(callbackRate,1) + ' Hz' : '浏览器不支持视频帧回调';
    $('present-count').textContent = shown(frame.presentedFrames) + ' / ' + callbackCount;
    $('present-interval').textContent = [quantile(.5),quantile(.95),quantile(1)].map(v=>shown(v,2)).join(' / ') + ' ms';
    $('media-time').textContent = shown(frame.mediaTime,3) + ' s';
    $('frame-age').textContent = shown(observation.presentation.last_callback_age_ms,1) + ' ms';
    previousPresent = {now, presentedFrames: frame.presentedFrames, callbackCount};
    latestObservation = observation;
    if (peer.connectionState === 'connected') {
      const fresh = finite(frame.callbackNow) && now-frame.callbackNow < 1000;
      connection(fresh ? '视频接收中' : '连接正常 · 等待视频', fresh);
      if (!fresh) { $('empty').hidden = false; $('empty').textContent = '等待新的视频帧'; }
    }
    try {
      const server = await api('/api/session/' + encodeURIComponent(id) + '/stats');
      if (epoch !== generation) return;
      observation.server = server;
      $('server-stats').textContent = JSON.stringify(server, null, 2);
      const stages = server.phase_latency?.stages;
      for (const [id, key] of [['capture-reader-delay','capture_complete_to_reader_us'],
          ['reader-encoder-delay',server.phase_latency?.native_encoder ? 'encoded_output_to_reader_us' : 'reader_to_encoder_output_us'],
          ['capture-encoder-delay','capture_complete_to_encoder_output_us'],
          ['encoder-delay','encoder_input_to_output_us']]) {
        const stage = stages?.[key];
        $(id).textContent = [stage?.p50, stage?.p95].map(v => shown(finite(v) ? v / 1000 : null,2)).join(' / ') + ' ms';
      }
      $('reader-stage-label').textContent = server.phase_latency?.native_encoder ? '编码输出 → 信令进程读完码流' : '读完帧 → 编码输出';
      const mode = server.capture?.mode;
      $('capture-mode').textContent = mode === 'stereo' ? (server.requested.eye === 'left' ? '单眼 · 左眼' : server.requested.eye === 'right' ? '单眼 · 右眼' : '横屏 · 左眼 / 右眼') : mode === 'desktop' ? '维护桌面' : '画面模式待确认';
      parentMessage('mix-video-stats', {mode, inbound: observation.inbound,
        presentation: observation.presentation, observation});
    } catch (error) {
      if (epoch === generation) $('server-stats').textContent = '服务端统计暂不可用：' + error.message;
    }
  } catch (error) {
    if (epoch === generation) $('message').textContent = '浏览器统计不可用：' + error.message;
  }
  if (epoch === generation) setTimeout(() => pollStats(epoch, id, peer), 1000);
}
$('controls').addEventListener('submit', async event => {
  event.preventDefault();
  if (session || pc || starting) return;
  if (embedded && (videoControl?.enabled!==true || videoControl.offline)) { renderControl(); return; }
  token = $('token').value.trim() || token;
  if (!token) { $('token-field').hidden = false; $('token').focus(); return; }
  const requested = $('codec').value;
  const capabilities = RTCRtpReceiver.getCapabilities?.('video')?.codecs || [];
  const receiverCodecs = [...new Set(capabilities.map(c=>c.mimeType.toLowerCase().replace('video/','')).filter(c=>['h264','h265'].includes(c)))];
  const config = {width:+$('width').value, fps:+$('fps').value, eye:$('eye').value,
    bitrate:$('bitrate').value === 'custom' ? +$('custom-bitrate').value * 1e6 : +$('bitrate').value,
    codec:requested, receiver_codecs:receiverCodecs};
  let fallbackReason = null;
  for (let attempt=0;attempt<2;attempt++) {
    starting = true;
    const epoch = ++generation;
    $('start').disabled = true; configureDisabled(true);
    $('message').textContent = '建立真实视频会话…'; connection('连接中'); resetMetrics();
    let created = null;
    try {
      created = await api('/api/session', {method:'POST', body:JSON.stringify(config)});
      if (epoch !== generation) {
        if (typeof created.id === 'string') await api('/api/session/' + encodeURIComponent(created.id), {method:'DELETE', keepalive:true});
        return;
      }
      if (typeof created.id !== 'string' || created.offer?.type !== 'offer' || typeof created.offer.sdp !== 'string') throw Error('服务端会话格式无效');
      session = created.id;
      const id = session, peer = pc = new RTCPeerConnection({iceServers:[]});
      peer.mixStarting = true;
      const reasons = {receiver_no_hevc:'浏览器未提供 H.265 接收能力',hardware_hevc_unavailable:'设备 H.265 启动不可用'};
      const reason = fallbackReason || reasons[created.fallback_reason];
      $('codec-status').textContent = `实际编码：${created.codec === 'h265' ? 'H.265 / HEVC' : 'H.264'}${reason ? ' · 已回退：' + reason : ''}`;
      peer.ontrack = event => {
        if (epoch !== generation || event.track.kind !== 'video') return;
        video.srcObject = event.streams[0] || new MediaStream([event.track]);
        video.play().catch(error => { $('message').textContent = '浏览器未开始播放：' + error.message; });
        if (video.requestVideoFrameCallback && frameCallback === null) frameCallback = video.requestVideoFrameCallback(recordFrame);
      };
      peer.onicecandidate = event => {
        if (epoch !== generation || !event.candidate) return;
        api('/api/session/' + encodeURIComponent(id) + '/ice', {method:'POST', body:JSON.stringify({candidate:event.candidate.candidate, sdpMLineIndex:event.candidate.sdpMLineIndex})})
          .catch(error => { if (epoch === generation) $('message').textContent = 'ICE 发送失败：' + error.message; });
      };
      peer.onconnectionstatechange = () => {
        if (epoch === generation) connection('WebRTC · ' + peer.connectionState);
      };
      await peer.setRemoteDescription(created.offer);
      if (epoch !== generation) return;
      await peer.setLocalDescription(await peer.createAnswer());
      if (epoch !== generation) return;
      const answer = peer.localDescription.sdp;
      if (!/m=video [1-9]/.test(answer) || /a=inactive/.test(answer)) throw Error('浏览器拒绝视频编码协商');
      await api('/api/session/' + encodeURIComponent(id) + '/answer', {method:'POST', body:JSON.stringify({type:peer.localDescription.type, sdp:answer})});
      if (epoch !== generation) return;
      $('stop').disabled = false; $('token-field').hidden = true;
      void pollIce(epoch, id, peer, new Set());
      let decoded = false;
      let nextStartupKeyframe = performance.now()+1500;
      for (const deadline=performance.now()+10000;performance.now()<deadline;) {
        if (epoch !== generation) return;
        if (peer.mixStartupError) throw Error(peer.mixStartupError);
        const stats=await peer.getStats();
        decoded=[...stats.values()].some(r=>r.type==='inbound-rtp' && r.kind==='video' && r.framesDecoded>0);
        if (decoded) break;
        if (peer.connectionState==='failed') throw Error('接收连接失败');
        if (peer.connectionState==='connected' && performance.now() >= nextStartupKeyframe) {
          await api('/api/session/' + encodeURIComponent(id) + '/keyframe', {method:'POST', body:'{}'});
          nextStartupKeyframe = performance.now()+1500;
        }
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      if (!decoded) throw Error('未收到可解码视频帧');
      peer.mixStarting = false;
      starting = false;
      $('message').textContent = '会话已建立；更改编码、画面或画质请先退出观看。';
      void pollStats(epoch, id, peer);
      return;
    } catch (error) {
      if (epoch !== generation) return;
      const retry = attempt===0 && created?.codec==='h265';
      await stopSession(retry ? 'H.265 未能播放，正在回退 H.264…' : '未能开始观看：' + error.message);
      if (!retry) return;
      fallbackReason = 'H.265 协商或解码失败'; config.codec='h264';
    }
  }
});
$('stop').addEventListener('click', () => void stopSession());
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('screen').requestFullscreen();
  } catch (error) { $('message').textContent = '无法全屏：' + error.message; }
});
window.addEventListener('message', event => {
  if (!embedded || event.origin !== location.origin || event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'mix-video-control' && (typeof data.enabled==='boolean' || data.enabled===null)) {
    videoControl={enabled:data.enabled,offline:!!data.offline};
    if (data.enabled===false && (session || pc || starting)) void stopSession('全部视频已手动关闭');
    renderControl();
  }
  if (data.type === 'mix-video-theme' && ['light','dark'].includes(data.theme)) document.documentElement.dataset.theme = data.theme;
  if (data.type === 'mix-video-parent-ready') parentMessage('mix-video-ready');
  if (data.type === 'mix-video-auth' && typeof data.token === 'string' &&
      data.token.length >= 32 && data.token.length <= 512 && /^[\x21-\x7e]+$/.test(data.token)) {
    token = data.token; $('token').value = ''; $('token-field').hidden = true;
  }
  if (data.type === 'mix-video-stop') void stopSession(data.reason==='all-off'?'全部视频已关闭':data.reason==='screen-stop'?'屏幕流已关闭':'已切换到维护预览');
});
if (embedded) {
  renderControl();
  $('token-field').hidden = true;
  new ResizeObserver(() => parentMessage('mix-video-size', {
    height: Math.ceil(document.querySelector('main').getBoundingClientRect().height)
  })).observe(document.querySelector('main'));
  parentMessage('mix-video-ready');
}
window.addEventListener('pagehide', () => { void stopSession('页面已关闭'); });
