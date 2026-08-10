import { initRobot, setState as robotSetState, setMicAnalyser, setOutAnalyser, triggerSpark } from './robot.js';
import { createAnalyser } from './audio-analyser.js';

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${protocol}//${window.location.host}/ws`;

const statusEl      = document.getElementById('status');
const btnSession    = document.getElementById('btn-session');
const talkArea       = document.getElementById('talk-area');
const btnTalk       = document.getElementById('btn-talk');
const textForm      = document.getElementById('text-form');
const textInput     = document.getElementById('text-input');
const btnSend       = document.getElementById('btn-send');
const btnCam        = document.getElementById('btn-cam');
const btnFile       = document.getElementById('btn-file');
const fileInput     = document.getElementById('file-input');
const toast         = document.getElementById('toast');
const transcriptEl  = document.getElementById('transcript');
const cameraEl      = document.getElementById('camera-preview');
const cookingEl     = document.getElementById('cooking');
const cookingName   = document.getElementById('cooking-filename');
const dropOverlay   = document.getElementById('drop-overlay');
const contentPanel  = document.getElementById('content-panel');
const contentTitle  = document.getElementById('content-title');
const contentBadge  = document.getElementById('content-badge');
const contentBody   = document.getElementById('content-body');
const contentClose  = document.getElementById('content-close');
const emailPanel    = document.getElementById('email-panel');
const emailTitle    = document.getElementById('email-title');
const emailTo       = document.getElementById('email-to');
const emailSubject  = document.getElementById('email-subject');
const emailContent  = document.getElementById('email-content');
const emailClose    = document.getElementById('email-close');
const emailCancel   = document.getElementById('email-cancel');
const emailApprove  = document.getElementById('email-approve');

let ws                 = null;
let connected           = false;
let audioCtx           = null;
let outputAnalyserNode = null;
let mediaStream        = null;
let micSource          = null;
let micAnalyserNode    = null;
let playTime           = 0;
let toastTimer         = null;

// Push-to-talk: the mic MediaStream + AudioContext live for the whole
// session, but the worklet that actually forwards audio to the WebSocket is
// created fresh for each hold and torn down on release — nothing is ever
// sent while the button isn't pressed.
let recording   = false;
let talkWorklet = null;

// Camera state
let cameraStream   = null;
let cameraCanvas   = null;
let cameraInterval = null;
let cameraActive   = false;

// Gemini Live outputs PCM16 mono at 24 kHz
const GEMINI_OUT_RATE = 24000;

// ── Init robot ────────────────────────────────────────────────────────────────
initRobot(document.getElementById('robot-container'));

// ── UI helpers ────────────────────────────────────────────────────────────────

function setState(state, label) {
  statusEl.textContent = label;
  statusEl.className   = state === 'error'
    ? 'err'
    : ['listening', 'speaking', 'connecting'].includes(state) ? 'live' : '';
  robotSetState(state);
}

function setIdleConnected()    { setState('idle', 'mantené presionado para hablar'); }
function setIdleDisconnected() { setState('idle', 'listo'); }

function showToast(msg) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

let pendingText = '';
let turnActive  = false;

function appendTranscript(chunk) {
  if (!turnActive) {
    clearTranscript();
    turnActive = true;
  }
  pendingText += chunk;
  transcriptEl.textContent = pendingText.slice(-400);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function clearTranscript() {
  pendingText = '';
  transcriptEl.textContent = '';
}

function setTextDisabled(disabled) {
  textInput.disabled = disabled;
  btnSend.disabled   = disabled;
}

// ── Content panel (mostrar_contenido tool) ────────────────────────────────────

const TIPO_LABELS = { codigo: 'código', sql: 'sql', texto: 'texto', lista: 'lista' };

function showContent({ titulo, tipo, contenido, lenguaje }) {
  contentTitle.textContent = titulo || 'contenido';
  contentBadge.textContent = lenguaje || TIPO_LABELS[tipo] || tipo || '';
  contentBody.textContent  = contenido || '';
  contentBody.classList.toggle('nowrap', tipo === 'codigo' || tipo === 'sql');
  contentPanel.classList.add('show');
}

function hideContent() {
  contentPanel.classList.remove('show');
}

contentClose.onclick = hideContent;

// ── File download (generar_archivo tool) ──────────────────────────────────────

function triggerDownload({ filename, mimeType, contenido }) {
  const blob = new Blob([contenido ?? ''], { type: mimeType || 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename || 'archivo.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`archivo descargado  ·  ${filename}`);
}

// ── Email draft confirmation (enviar_email tool) ──────────────────────────────
// Never sent without an explicit click here — the draft only leaves the
// server after the user approves it in this panel.

let pendingDraftId = null;

function showEmailDraft({ draftId, destinatario, asunto, cuerpo }) {
  pendingDraftId = draftId;
  emailTitle.textContent = 'Borrador de email — esperando confirmación';
  emailTo.textContent = destinatario || '';
  emailSubject.textContent = asunto || '';
  emailContent.textContent = cuerpo || '';
  emailPanel.classList.add('show');
}

function hideEmailDraft() {
  emailPanel.classList.remove('show');
  pendingDraftId = null;
}

function respondEmailDraft(approved) {
  if (!pendingDraftId || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'email_confirm', draftId: pendingDraftId, approved }));
  if (!approved) hideEmailDraft();
}

emailClose.onclick  = () => respondEmailDraft(false);
emailCancel.onclick = () => respondEmailDraft(false);
emailApprove.onclick = () => respondEmailDraft(true);

// ── Audio playback (output goes through analyser → speakers) ─────────────────

function scheduleAudio(base64) {
  if (!audioCtx || !outputAnalyserNode) return;

  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const pcm16 = new Int16Array(bytes.buffer);
  const f32   = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;

  const buf = audioCtx.createBuffer(1, f32.length, GEMINI_OUT_RATE);
  buf.getChannelData(0).set(f32);

  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(outputAnalyserNode); // → analyser → destination (pass-through)

  const when = Math.max(playTime, audioCtx.currentTime + 0.04);
  src.start(when);
  playTime = when + buf.duration;

  src.onended = () => {
    if (audioCtx && playTime <= audioCtx.currentTime + 0.12 && !recording) {
      setIdleConnected();
    }
  };
}

// ── Session (connect / disconnect) ─────────────────────────────────────────────

async function connectSession() {
  setState('connecting', 'conectando...');

  // Audio setup — non-fatal: failure shows a toast but text chat still opens
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    playTime = 0;

    outputAnalyserNode = createAnalyser(audioCtx, { fftSize: 256, smoothing: 0.75 });
    outputAnalyserNode.connect(audioCtx.destination);
    setOutAnalyser(outputAnalyserNode);

    await audioCtx.audioWorklet.addModule('/processor.js');

    micSource = audioCtx.createMediaStreamSource(mediaStream);
    micAnalyserNode = createAnalyser(audioCtx, { fftSize: 256, smoothing: 0.8 });
    micSource.connect(micAnalyserNode);
    setMicAnalyser(micAnalyserNode);
  } catch (err) {
    console.warn('[Audio] Setup fallido, continuando sin audio:', err.message);
    showToast('audio no disponible — solo texto');
    mediaStream?.getTracks().forEach(t => t.stop());
    mediaStream = null;
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    outputAnalyserNode = null;
    micSource = null;
    micAnalyserNode = null;
    setMicAnalyser(null);
    setOutAnalyser(null);
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => setState('connecting', 'iniciando sesión...');

  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'status':
        if (msg.text === 'ready') {
          clearTranscript();
          onSessionReady();
        } else if (msg.text === 'listening') {
          turnActive = false;
          if (!recording) setIdleConnected();
        }
        break;
      case 'audio':
        setState('speaking', 'coder está hablando');
        scheduleAudio(msg.data);
        break;
      case 'text':
        appendTranscript(msg.content);
        break;
      case 'content':
        showContent(msg);
        break;
      case 'download':
        triggerDownload(msg);
        break;
      case 'email_draft':
        showEmailDraft(msg);
        break;
      case 'email_sent':
        hideEmailDraft();
        showToast('email enviado ✓');
        break;
      case 'email_cancelled':
        hideEmailDraft();
        showToast('envío cancelado');
        break;
      case 'email_error':
        hideEmailDraft();
        showToast(`error mandando email  ·  ${msg.message.slice(0, 50)}`);
        break;
      case 'fact_saved':
        triggerSpark();
        showToast(`memoricé algo nuevo  ·  ${msg.category}`);
        break;
      case 'file_received':
        hideCooking();
        btnFile.classList.remove('uploading');
        showToast(`archivo enviado  ·  ${msg.filename}`);
        break;
      case 'file_error':
        hideCooking();
        btnFile.classList.remove('uploading');
        showToast(`error procesando  ·  ${msg.filename}`);
        break;
      case 'error':
        setState('error', msg.message.slice(0, 60));
        setTimeout(disconnectSession, 2500);
        break;
    }
  };

  ws.onerror = () => setState('error', 'error de conexión');
  ws.onclose = () => { if (ws) disconnectSession(); };
}

function onSessionReady() {
  connected = true;
  talkArea.hidden = false;
  talkArea.classList.add('enter');
  btnSession.textContent = 'Desconectar';
  btnSession.classList.add('connected');
  setIdleConnected();
}

function disconnectSession() {
  if (recording) stopRecording();

  ws?.close();
  ws = null;
  connected = false;

  mediaStream?.getTracks().forEach(t => t.stop());
  mediaStream = null;
  micSource = null;

  setMicAnalyser(null);
  setOutAnalyser(null);
  outputAnalyserNode = null;
  micAnalyserNode = null;

  audioCtx?.close();
  audioCtx = null;
  playTime  = 0;

  if (cameraActive) stopCamera();
  hideEmailDraft();

  talkArea.hidden = true;
  btnSession.textContent = 'Conectar con Coder';
  btnSession.classList.remove('connected');
  setTextDisabled(false);

  setIdleDisconnected();
}

function cleanup() {
  mediaStream?.getTracks().forEach(t => t.stop());
  mediaStream = null;
  audioCtx?.close();
  audioCtx = null;
}

btnSession.onclick = () => {
  if (connected) {
    disconnectSession();
  } else {
    connectSession();
  }
};

// ── Push-to-talk ──────────────────────────────────────────────────────────────

function startRecording() {
  if (!connected || recording || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (!audioCtx || !micSource) {
    showToast('audio no disponible en este dispositivo');
    return;
  }

  recording = true;
  btnTalk.classList.add('recording');
  setTextDisabled(true);
  setState('listening', 'grabando');

  talkWorklet = new AudioWorkletNode(audioCtx, 'pcm-processor');
  talkWorklet.port.onmessage = ({ data }) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'audio', data: toBase64(data) }));
    }
  };
  micSource.connect(talkWorklet);
}

function stopRecording() {
  if (!recording) return;

  recording = false;
  btnTalk.classList.remove('recording');
  setTextDisabled(false);

  micSource?.disconnect(talkWorklet);
  if (talkWorklet) talkWorklet.port.onmessage = null;
  talkWorklet = null;

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'audio_end' }));
    setState('connecting', 'procesando...');
  } else {
    setIdleConnected();
  }
}

btnTalk.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  btnTalk.setPointerCapture(e.pointerId);
  startRecording();
});
btnTalk.addEventListener('pointerup', stopRecording);
btnTalk.addEventListener('pointercancel', stopRecording);
btnTalk.addEventListener('lostpointercapture', stopRecording);
btnTalk.addEventListener('contextmenu', (e) => e.preventDefault());

// ── Text input ────────────────────────────────────────────────────────────────

function sendTextInput(raw) {
  const text = raw.trim();
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('conectate primero');
    return;
  }
  if (recording) return;

  pendingText = `Vos: ${text}\n\nCoder: `;
  transcriptEl.textContent = pendingText;
  turnActive = true;

  ws.send(JSON.stringify({ type: 'text_input', text }));
  setState('connecting', 'procesando...');
}

textForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendTextInput(textInput.value);
  textInput.value = '';
  textInput.style.height = 'auto';
});

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTextInput(textInput.value);
    textInput.value = '';
    textInput.style.height = 'auto';
  }
});

textInput.addEventListener('input', () => {
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight, 150) + 'px';
});

// ── Utility ───────────────────────────────────────────────────────────────────

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    str += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(str);
}

// ── Camera ────────────────────────────────────────────────────────────────────

async function startCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
  } catch {
    showToast('permiso de cámara denegado');
    return;
  }

  cameraEl.srcObject = cameraStream;
  cameraEl.style.display = 'block';

  cameraCanvas = document.createElement('canvas');
  cameraCanvas.width = 640;
  cameraCanvas.height = 480;
  const ctx = cameraCanvas.getContext('2d');

  cameraInterval = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ctx.drawImage(cameraEl, 0, 0);
    cameraCanvas.toBlob((blob) => {
      if (!blob) return;
      blob.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf);
        let str = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          str += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        ws.send(JSON.stringify({ type: 'video', data: btoa(str) }));
      });
    }, 'image/jpeg', 0.75);
  }, 1000);

  cameraActive = true;
  btnCam.classList.add('active');
  btnCam.title = 'Desactivar cámara';
}

function stopCamera() {
  clearInterval(cameraInterval);
  cameraInterval = null;
  cameraStream?.getTracks().forEach(t => t.stop());
  cameraStream = null;
  cameraCanvas = null;
  cameraEl.srcObject = null;
  cameraEl.style.display = 'none';
  cameraActive = false;
  btnCam.classList.remove('active');
  btnCam.title = 'Activar cámara';
}

btnCam.onclick = () => {
  if (cameraActive) {
    stopCamera();
  } else {
    startCamera();
  }
};

// ── Cooking indicator ─────────────────────────────────────────────────────────

function showCooking(filename) {
  cookingName.textContent = filename;
  cookingEl.classList.add('show');
}

function hideCooking() {
  cookingEl.classList.remove('show');
  cookingName.textContent = '';
}

// ── File utilities ────────────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  '.txt','.js','.ts','.jsx','.tsx','.py','.rs','.go','.java','.c','.cpp','.h',
  '.css','.html','.xml','.yaml','.yml','.toml','.ini','.env','.md','.mdx',
  '.json','.sh','.bash','.sql','.graphql','.gql','.vue','.svelte','.rb',
  '.php','.cs','.config','.lock','.dockerfile',
]);

function isTextFile(file) {
  if (file.type.startsWith('text/') || file.type === 'application/json') return true;
  const ext = file.name.includes('.') ? '.' + file.name.split('.').pop().toLowerCase() : '';
  return TEXT_EXTENSIONS.has(ext);
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(toBase64(e.target.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function imageToJpegBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const maxW = 1280;
      const scale = img.width > maxW ? maxW / img.width : 1;
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('canvas toBlob failed')); return; }
        blob.arrayBuffer().then((buf) => resolve(toBase64(new Uint8Array(buf))));
      }, 'image/jpeg', 0.85);
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ── File sending ──────────────────────────────────────────────────────────────

async function sendFile(file) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('primero iniciá una sesión con Coder');
    return;
  }

  const MAX = 25 * 1024 * 1024;
  if (file.size > MAX) {
    showToast('archivo demasiado grande (máx 25 MB)');
    return;
  }

  showCooking(file.name);
  btnFile.classList.add('uploading');

  try {
    if (file.type.startsWith('image/')) {
      const data = await imageToJpegBase64(file);
      ws.send(JSON.stringify({ type: 'file', filename: file.name, mimeType: 'image/jpeg', data }));
    } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      const data = await readAsBase64(file);
      ws.send(JSON.stringify({ type: 'file', filename: file.name, mimeType: 'application/pdf', data }));
    } else if (isTextFile(file)) {
      const text = await readAsText(file);
      ws.send(JSON.stringify({ type: 'file', filename: file.name, mimeType: 'text/plain', text }));
    } else {
      showToast(`tipo "${file.type || file.name.split('.').pop()}" no soportado aún`);
      hideCooking();
      btnFile.classList.remove('uploading');
    }
  } catch (err) {
    console.error('Error leyendo archivo:', err);
    showToast('error leyendo el archivo');
    hideCooking();
    btnFile.classList.remove('uploading');
  }
}

// ── File button & drag-and-drop ───────────────────────────────────────────────

btnFile.onclick = () => fileInput.click();

fileInput.onchange = () => {
  const file = fileInput.files[0];
  if (file) sendFile(file);
  fileInput.value = '';
};

let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.add('show');
});

document.addEventListener('dragleave', () => {
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('show'); }
});

document.addEventListener('dragover', (e) => e.preventDefault());

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('show');
  const file = e.dataTransfer?.files[0];
  if (file) sendFile(file);
});

// ── Init ──────────────────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.error);
}
