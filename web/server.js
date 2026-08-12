import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Groq, { toFile } from 'groq-sdk';
import { PDFParse } from 'pdf-parse';
import nodemailer from 'nodemailer';
import { getSystemPrompt, getRelevantFacts, saveFact, createReminder, getDueReminders, markReminderNotified } from '../src/memory.js';
import { MODEL, VISION_MODEL, AVAILABLE_TOOLS, buildSystemContent, currentDateTimeBlock } from '../src/groq-brain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WEB_PORT || 3000;

const app = express();
app.use(compression());
app.use(express.static(join(__dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// enviar_email — Gmail SMTP via App Password (never the account's real password)
const mailTransport = (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD },
    })
  : null;

if (!mailTransport) {
  console.warn('[Email] EMAIL_USER / EMAIL_APP_PASSWORD no configurados — enviar_email fallará hasta que se agreguen al .env');
}

// buscar_imagen_stock — Unsplash free search API
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || null;

if (!UNSPLASH_ACCESS_KEY) {
  console.warn('[Unsplash] UNSPLASH_ACCESS_KEY no configurada — buscar_imagen_stock fallará hasta que se agregue al .env');
}

async function searchUnsplashImages(query, count = 4) {
  if (!UNSPLASH_ACCESS_KEY) throw new Error('UNSPLASH_ACCESS_KEY no configurada en el servidor');

  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`;
  const res = await fetch(url, { headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` } });

  if (!res.ok) throw new Error(`Unsplash respondió ${res.status}`);

  const data = await res.json();
  return (data.results ?? []).map((r) => ({
    url: r.urls?.regular ?? r.urls?.small,
    descripcion: r.alt_description || r.description || query,
    autor: r.user?.name ?? 'desconocido',
    perfil_autor: r.user?.links?.html ?? null,
  }));
}

// notificar_celular — ntfy.sh push notifications, free, no API key, just a topic
const NTFY_TOPIC = process.env.NTFY_TOPIC || null;

if (!NTFY_TOPIC) {
  console.warn('[ntfy] NTFY_TOPIC no configurada — notificar_celular fallará hasta que se agregue al .env');
}

async function sendNtfyNotification(titulo, mensaje) {
  if (!NTFY_TOPIC) throw new Error('notificaciones no configuradas todavía — falta NTFY_TOPIC en el servidor');

  // JSON publish (not the /<topic> + headers form) so tildes/ñ in titulo
  // don't blow up as invalid HTTP header bytes — see ntfy.sh/docs/publish/#publish-as-json
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: NTFY_TOPIC, title: titulo, message: mensaje }),
  });

  if (!res.ok) throw new Error(`ntfy.sh respondió ${res.status}`);
}

// crear_recordatorio — background check, independent of any WS connection.
// Only marks a reminder as notified after the ntfy push actually succeeds,
// so a transient ntfy failure just retries on the next tick instead of
// silently losing the reminder.
const REMINDER_CHECK_INTERVAL_MS = 60 * 1000;

async function checkDueReminders() {
  let due;
  try {
    due = await getDueReminders();
  } catch (err) {
    console.error('[Recordatorios] Error buscando pendientes:', err.message);
    return;
  }

  for (const reminder of due) {
    try {
      await sendNtfyNotification('Recordatorio', reminder.mensaje);
      await markReminderNotified(reminder.id);
      console.log(`[Recordatorios] Notificado: "${reminder.mensaje}"`);
    } catch (err) {
      console.error(`[Recordatorios] Error notificando "${reminder.mensaje}":`, err.message);
    }
  }
}

checkDueReminders();
setInterval(checkDueReminders, REMINDER_CHECK_INTERVAL_MS);

// Shared cap for anything that stuffs raw external text into a tool result
// bound for Groq. 60,000 chars used to be the ceiling here, but that's well
// past what fits in a single request on the free-tier TPM limit for
// openai/gpt-oss-120b — Groq rejects the whole request with a 413 instead of
// just answering with less context, so this needs to stay conservative.
const MAX_TOOL_CONTENT_CHARS = 20000;

// leer_repo_github — public GitHub Contents API; GITHUB_TOKEN is optional and
// only needed to read private repos (public ones work with zero config).
const GITHUB_OWNER = 'manz55';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;

if (!GITHUB_TOKEN) {
  console.warn('[GitHub] GITHUB_TOKEN no configurado — leer_repo_github solo va a poder leer repos públicos');
}

function githubHeaders() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'coder-assistant' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

async function readGithubFile(repo, ruta) {
  // Encode each path segment (spaces, accents, etc.) without touching the slashes.
  const encodedPath = ruta.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${encodedPath}`;

  const res = await fetch(url, { headers: githubHeaders() });

  if (res.status === 404) {
    throw new Error(`no encontré "${ruta}" en el repo "${repo}" (puede no existir, o ser un repo privado sin GITHUB_TOKEN configurado)`);
  }
  if (!res.ok) {
    throw new Error(`GitHub respondió ${res.status}`);
  }

  const data = await res.json();

  if (Array.isArray(data)) {
    throw new Error(`"${ruta}" es una carpeta, no un archivo — pasá la ruta de un archivo específico`);
  }
  if (data.type !== 'file') {
    throw new Error(`"${ruta}" no es un archivo`);
  }
  if (!data.content) {
    throw new Error(`"${ruta}" es demasiado grande para leerlo así (límite ~1MB de la API de contenidos de GitHub)`);
  }

  return Buffer.from(data.content, 'base64').toString('utf-8');
}

// explorar_repo_github — walks a whole repo instead of one file at a time:
// list the tree, keep the ~15 most relevant files, read + summarize each one
// individually (one small Groq call per file, never the raw content of more
// than one file in a single request), then synthesize those summaries into
// one final answer. This is the only way to cover a whole repo without
// blowing past the same per-request TPM limit that MAX_TOOL_CONTENT_CHARS
// exists for above — a giant single request with N files concatenated would
// hit the exact 413 that started that fix.
const EXPLORE_MAX_FILES = 15;

const EXPLORE_EXCLUDE_DIR_SEGMENTS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'vendor',
  'coverage', '.cache', 'out', '.turbo', '.vercel', '__pycache__',
]);

const EXPLORE_EXCLUDE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
  '.pdf', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac',
  '.lock', '.map',
]);

// Named lock files whose actual extension (.json/.yaml) doesn't give them
// away — huge, auto-generated, zero signal for an architecture summary.
const EXPLORE_EXCLUDE_FILENAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'composer.lock', 'gemfile.lock',
]);

const EXPLORE_MAX_FILE_BYTES = 300 * 1024; // not worth an API round trip if it's this big

function isExplorableFile(entry) {
  const path = entry.path;
  if (path.split('/').some((s) => EXPLORE_EXCLUDE_DIR_SEGMENTS.has(s))) return false;

  const base = path.split('/').pop().toLowerCase();
  if (EXPLORE_EXCLUDE_FILENAMES.has(base)) return false;
  if (base.includes('.min.')) return false;

  const ext = base.includes('.') ? '.' + base.split('.').pop() : '';
  if (EXPLORE_EXCLUDE_EXTENSIONS.has(ext)) return false;

  if (typeof entry.size === 'number' && entry.size > EXPLORE_MAX_FILE_BYTES) return false;

  return true;
}

const EXPLORE_HIGH_PRIORITY_NAMES = /^(readme(\.\w+)?|package\.json|pyproject\.toml|requirements\.txt|go\.mod|cargo\.toml|composer\.json|gemfile|pom\.xml)$/i;
const EXPLORE_MAIN_CODE_PREFIXES = ['src/', 'app/', 'lib/', 'pages/', 'components/', 'api/'];

function explorePriorityOf(path) {
  const base = path.split('/').pop();
  if (EXPLORE_HIGH_PRIORITY_NAMES.test(base)) return 0;
  if (!path.includes('/')) return 1; // other top-level files (configs) next
  if (EXPLORE_MAIN_CODE_PREFIXES.some((p) => path.startsWith(p))) return 2;
  return 3;
}

// Highest priority first, shallower paths first within a tier — the goal is
// "what would a human open first to understand this repo", not full coverage.
function prioritizeExploreFiles(entries, max) {
  const explorable = entries.filter(isExplorableFile);
  const sorted = [...explorable].sort((a, b) => {
    const pa = explorePriorityOf(a.path), pb = explorePriorityOf(b.path);
    if (pa !== pb) return pa - pb;
    const depthDiff = a.path.split('/').length - b.path.split('/').length;
    if (depthDiff !== 0) return depthDiff;
    return a.path.localeCompare(b.path);
  });
  return { seleccionados: sorted.slice(0, max), total: explorable.length };
}

async function fetchRepoTree(repo) {
  const repoRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}`, { headers: githubHeaders() });
  if (repoRes.status === 404) {
    throw new Error(`no encontré el repo "${repo}" (puede no existir, o ser privado sin GITHUB_TOKEN configurado)`);
  }
  if (!repoRes.ok) throw new Error(`GitHub respondió ${repoRes.status} buscando el repo "${repo}"`);
  const repoData = await repoRes.json();
  const branch = repoData.default_branch || 'main';

  const treeRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers: githubHeaders() }
  );
  if (!treeRes.ok) throw new Error(`GitHub respondió ${treeRes.status} listando los archivos de "${repo}"`);
  const treeData = await treeRes.json();
  if (treeData.truncated) {
    console.warn(`[Explorar] El árbol de "${repo}" vino truncado por la API de GitHub (repo muy grande) — puede faltar algún archivo`);
  }

  return (treeData.tree ?? []).filter((entry) => entry.type === 'blob');
}

// One small, focused Groq call per file — never more than one file's raw
// content in a single request, and a short max_tokens keeps each call fast.
async function summarizeExploredFile(groq, path, contenido, pregunta) {
  const truncado = contenido.length > MAX_TOOL_CONTENT_CHARS;
  const preview = contenido.slice(0, MAX_TOOL_CONTENT_CHARS);

  const instruccion = pregunta
    ? `Un usuario está explorando un repo buscando específicamente: "${pregunta}". Del archivo de abajo, extraé en 3-5 líneas SOLO lo relevante a esa pregunta — si no hay nada relevante, decilo en una sola línea.`
    : 'Resumí en 3-5 líneas qué hace este archivo, su rol en el proyecto, y cualquier tecnología o patrón notable.';

  const response = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 220,
    messages: [
      { role: 'system', content: 'Sos un asistente que resume archivos de código de forma breve y concreta, en español. No repitas código literal, parafraseá.' },
      { role: 'user', content: `${instruccion}\n\nArchivo: ${path}${truncado ? ' (contenido recortado, el archivo completo es más largo)' : ''}\n\`\`\`\n${preview}\n\`\`\`` },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || '(sin contenido para resumir)';
}

// Consolidates every per-file summary into one final answer. If this one
// call fails (e.g. hits a transient rate limit right at the end), we still
// have every individual summary — falling back to those beats losing the
// whole exploration over the very last request.
async function synthesizeRepoExploration(groq, repo, resumenes, pregunta) {
  const cuerpo = resumenes
    .map((r) => `### ${r.path}${r.error ? ` (no se pudo leer: ${r.error})` : ''}\n${r.resumen ?? ''}`)
    .join('\n\n');

  const instruccion = pregunta
    ? `Basándote en estos resúmenes de archivos del repo "${repo}", respondé específicamente: "${pregunta}". Si ningún archivo tiene información relevante, decilo con claridad.`
    : `Basándote en estos resúmenes de archivos del repo "${repo}", armá un resumen general: qué hace el proyecto, su arquitectura principal, y el stack tecnológico. Sintetizá, no repitas los resúmenes tal cual.`;

  try {
    const response = await groq.chat.completions.create({
      model: MODEL,
      max_tokens: 700,
      messages: [
        { role: 'system', content: 'Sos un asistente técnico que sintetiza resúmenes de archivos de un repo en una conclusión clara, en español.' },
        { role: 'user', content: `${instruccion}\n\n${cuerpo}` },
      ],
    });
    return response.choices[0]?.message?.content?.trim() || cuerpo;
  } catch (err) {
    console.error('[Explorar] Error consolidando el resumen final, devolviendo resúmenes parciales:', err.message);
    return cuerpo;
  }
}

// Only step that can throw all the way up to the caller — nothing has been
// read yet at that point, so there's no partial work to lose. From here on,
// every failure (a single file, or even the final synthesis) is caught and
// folded into the result instead of aborting the whole exploration.
async function exploreGithubRepo(groq, repo, pregunta) {
  const allFiles = await fetchRepoTree(repo);
  const { seleccionados, total } = prioritizeExploreFiles(allFiles, EXPLORE_MAX_FILES);

  const resumenes = [];
  for (const entry of seleccionados) {
    try {
      const contenido = await readGithubFile(repo, entry.path);
      const resumen = await summarizeExploredFile(groq, entry.path, contenido, pregunta);
      resumenes.push({ path: entry.path, resumen });
      console.log(`[Explorar] ${repo}/${entry.path} resumido`);
    } catch (err) {
      console.error(`[Explorar] Error en ${repo}/${entry.path}, sigo con el resto:`, err.message);
      resumenes.push({ path: entry.path, error: err.message });
    }
  }

  const resumen = resumenes.length
    ? await synthesizeRepoExploration(groq, repo, resumenes, pregunta)
    : 'No se pudo leer ningún archivo del repo.';

  return {
    archivosExplorados: seleccionados.length,
    archivosTotales: total,
    archivosConError: resumenes.filter((r) => r.error).map((r) => r.path),
    resumen,
  };
}

// resumir_texto — same MAX_TOOL_CONTENT_CHARS discipline as everything else
// that hands raw external text to Groq, plus a dedicated call so the
// summary's tone (nivel) is consistent instead of depending on whatever the
// main chat happens to do with it inline.
async function summarizeText(groq, texto, nivel) {
  const truncado = texto.length > MAX_TOOL_CONTENT_CHARS;
  const preview = texto.slice(0, MAX_TOOL_CONTENT_CHARS);

  const estilo = nivel === 'tecnico'
    ? 'Mantené vocabulario técnico preciso, no simplifiques términos del dominio — asumí que el lector tiene conocimiento técnico.'
    : 'Explicá en lenguaje simple y llano, sin jerga innecesaria, como si se lo explicaras a alguien sin conocimiento previo del tema.';

  const response = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 500,
    messages: [
      { role: 'system', content: `Sos un asistente que resume textos en español de forma clara y concisa. ${estilo}` },
      { role: 'user', content: `Resumí el siguiente texto${truncado ? ' (viene recortado, el original es más largo)' : ''}:\n\n${preview}` },
    ],
  });

  return { resumen: response.choices[0]?.message?.content?.trim() || '(no se pudo generar el resumen)', truncado };
}

// buscar_web — Tavily search API (free tier: 1000 searches/month, no card)
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || null;

if (!TAVILY_API_KEY) {
  console.warn('[Tavily] TAVILY_API_KEY no configurada — buscar_web fallará hasta que se agregue al .env');
}

async function searchWeb(query) {
  if (!TAVILY_API_KEY) throw new Error('TAVILY_API_KEY no configurada en el servidor');

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      max_results: 5,
      include_answer: 'basic', // short synthesized answer, on top of the per-result snippets
    }),
  });

  if (!res.ok) throw new Error(`Tavily respondió ${res.status}`);

  const data = await res.json();

  // Same risk as leer_repo_github: five verbose results plus a synthesized
  // answer can add up to more than the free-tier TPM limit on a single Groq
  // request. Cap conservatively per-field instead of trusting the total —
  // 5 × 3000 + 4000 stays safely under MAX_TOOL_CONTENT_CHARS.
  const RESUMEN_MAX = 3000;
  const RESPUESTA_MAX = 4000;
  let truncado = false;

  const respuestaCompleta = data.answer ?? null;
  if (respuestaCompleta && respuestaCompleta.length > RESPUESTA_MAX) truncado = true;
  const respuesta = respuestaCompleta?.slice(0, RESPUESTA_MAX) ?? null;

  const resultados = (data.results ?? []).map((r) => {
    const contenido = r.content ?? '';
    if (contenido.length > RESUMEN_MAX) truncado = true;
    return { titulo: r.title, url: r.url, resumen: contenido.slice(0, RESUMEN_MAX) };
  });

  return { respuesta, resultados, truncado };
}

// Push-to-talk STT — the client's AudioWorklet (processor.js) already
// downsamples the mic to mono 16 kHz PCM16 before streaming it over, so all
// that's left server-side is to wrap the raw samples in a WAV header and
// hand them to Groq's Whisper endpoint.
const STT_SAMPLE_RATE = 16000;
const STT_MIN_BYTES = STT_SAMPLE_RATE * 2 * 0.3; // ~0.3s — below this, treat as an accidental tap, not speech

function pcm16ToWav(pcmBuffer, sampleRate = STT_SAMPLE_RATE, numChannels = 1) {
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20);  // audio format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

async function transcribeAudio(groq, pcmBuffer) {
  const wav = pcm16ToWav(pcmBuffer);
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });

  const transcription = await groq.audio.transcriptions.create({
    file,
    model: 'whisper-large-v3-turbo',
    language: 'es',
    response_format: 'json',
  });

  return transcription.text?.trim() ?? '';
}

// Image attachments — MODEL (openai/gpt-oss-120b) has no vision, so a
// one-off call to VISION_MODEL "looks" at the image and reports back in
// text; that description then goes into the main conversation as normal
// user content, same shape as the PDF/text-file branches above. This keeps
// vision isolated to the one call that actually needs it instead of
// switching the whole session's model.
async function analyzeImage(groq, base64Jpeg, filename) {
  const response = await groq.chat.completions.create({
    model: VISION_MODEL,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `Esta imagen se llama "${filename}". Describí en detalle qué hay en ella. ` +
            'Si es un problema matemático, un ejercicio o texto con una pregunta, transcribilo completo y ' +
            'resolvelo/respondelo paso a paso. Si es texto en general, transcribilo. Si es una foto de algo ' +
            'sin texto, describila con precisión. Respondé en español.',
        },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Jpeg}` } },
      ],
    }],
  });

  return response.choices[0]?.message?.content?.trim() || null;
}

// TTS is handled entirely client-side via the browser's Web Speech API
// (speechSynthesis) — see web/public/app.js. Self-hosting it server-side
// (Piper) OOM-killed Render (status 137) even at the "medium" voice tier, so
// there's no server-side TTS code at all now: the server only ever sends
// plain text back, at zero extra RAM cost.

const MIME_BY_EXT = {
  sql: 'application/sql',
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  js: 'text/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
  html: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
};

function guessMimeType(filename) {
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'text/plain';
}

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// controlar_volumen / controlar_brillo / abrir_app — same propose-then-confirm
// flow as enviar_email above: the tool handler never runs anything, it just
// builds a draft and shows it on screen. Only wss.on('connection')'s
// system_command_confirm handler actually calls execFileAsync, and only
// after Joshua approves the exact command shown to him.
const execFileAsync = promisify(execFile);

function draftSystemCommand(ws, tipo, descripcion, script) {
  if (process.platform !== 'darwin') {
    // Nothing to confirm if it can't possibly run — osascript doesn't exist
    // outside macOS, so fail immediately instead of showing a dead-end panel.
    throw new Error('esto solo funciona si el servidor corre en la Mac de Joshua (usa osascript, que no existe en este sistema)');
  }
  const draft = {
    draftId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tipo,
    descripcion,
    script,
  };
  safeSend(ws, { type: 'system_command_draft', draftId: draft.draftId, tipo, descripcion, comando: script });
  return draft;
}

// Defense in depth for abrir_app's app name landing inside an AppleScript
// string literal — the confirm panel already shows Joshua the exact command
// before anything runs, but this keeps a crafted name from breaking out of
// the string regardless.
function escapeAppleScriptString(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Groq SDK errors carry status/error.code/error.type from the API response
// (see node_modules/groq-sdk/core/error.js) — log all of it so a failure is
// diagnosable from `render logs` alone, and turn it into a message that
// actually says what broke instead of a generic "intentá de nuevo".
function describeGroqError(err) {
  const status = err?.status;
  // The SDK stores the raw response body as `err.error`; Groq's body shape
  // is itself `{ error: { message, type, code } }`, so it's nested twice.
  const body = err?.error?.error ?? err?.error ?? {};
  const code = body?.code ?? err?.code ?? null;
  const type = body?.type ?? null;
  const apiMessage = body?.message ?? err?.message ?? String(err);

  console.error(
    `[Groq] status=${status ?? 'n/a'} code=${code ?? 'n/a'} type=${type ?? 'n/a'} model=${MODEL} — ${apiMessage}`
  );

  if (status === 401) return '(Groq rechazó la API key — revisá GROQ_API_KEY en las variables de entorno del servidor)';
  // Groq returns 413 (sometimes bundled under a generic rate_limit_exceeded
  // code) when a single request's tokens blow past the free-tier TPM limit
  // — most often a big file or search result stuffed into tool content, even
  // after the MAX_TOOL_CONTENT_CHARS caps, since tokens ≠ characters 1:1.
  if (status === 413 || /too large/i.test(apiMessage)) {
    return '(ese archivo o resultado es muy grande para leerlo de una — pedime una parte específica en vez de todo junto)';
  }
  if (status === 429) return '(límite de uso de Groq alcanzado — esperá un momento y probá de nuevo)';
  if (code === 'model_decommissioned' || code === 'model_not_found') {
    return `(el modelo "${MODEL}" no está disponible en Groq — hay que actualizar MODEL en src/groq-brain.js)`;
  }
  if (typeof status === 'number' && status >= 500) return '(Groq está teniendo problemas del lado de ellos — probá de nuevo en un rato)';

  return `(error contactando Groq — ${String(apiMessage).slice(0, 100)})`;
}

wss.on('connection', async (ws) => {
  console.log('[WS] Cliente conectado');
  let pendingEmailDraft = null;
  let pendingSystemCommand = null;
  let recordedChunks = [];

  // The `ws` library starts parsing incoming frames the instant the
  // connection opens, independent of whether the app has attached a
  // 'message' listener yet — and a plain EventEmitter silently drops any
  // event with zero listeners (no queueing, no error). The context load
  // below awaits Supabase before this used to register, so anything a
  // client sent right after connecting (e.g. tapping the camera/file button
  // immediately, or typing before "ready") could vanish with no trace.
  // Registering synchronously here and buffering until context load
  // finishes closes that window completely — verified with a raw WS client
  // that a message sent right on 'open' was silently lost before this fix,
  // and arrived normally once buffered instead.
  let contextReady = false;
  const earlyMessages = [];
  let handleMessage; // assigned below, once runGroq and the rest are in scope
  ws.on('message', (raw) => {
    if (contextReady) handleMessage(raw);
    else earlyMessages.push(raw);
  });

  // Load context — fall back to defaults if Supabase is unavailable
  let systemPrompt = 'Sos Coder, el asistente personal de Joshua. Hablás en español rioplatense, sos directo e inteligente.';
  let facts = [];

  try {
    [systemPrompt, facts] = await Promise.all([getSystemPrompt(), getRelevantFacts()]);
    console.log(`[WS] Contexto cargado: ${facts.length} hechos`);
  } catch (err) {
    console.warn('[WS] Supabase no disponible, usando defaults:', err.message);
  }

  const systemContent = buildSystemContent(systemPrompt, facts);
  const chatHistory = [];
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  safeSend(ws, { type: 'status', text: 'ready' });

  async function runGroq(userContent) {
    chatHistory.push({ role: 'user', content: userContent });

    // Computed fresh per call, not baked into systemContent once at connect
    // time — a long-running session would otherwise anchor "now" to whenever
    // the WS connected, hours stale by the time crear_recordatorio needs it.
    let response = await groq.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: `${systemContent}\n\n${currentDateTimeBlock()}` }, ...chatHistory],
      tools: AVAILABLE_TOOLS,
      tool_choice: 'auto',
    });

    let choice = response.choices[0];

    while (choice.finish_reason === 'tool_calls') {
      const toolCalls = choice.message.tool_calls ?? [];
      chatHistory.push(choice.message);

      for (const tc of toolCalls) {
        const args = JSON.parse(tc.function.arguments);
        let result = {};

        if (tc.function.name === 'guardar_hecho') {
          try {
            await saveFact(args.category, args.content);
            console.log(`[Tool] Hecho guardado en "${args.category}": ${args.content}`);
            safeSend(ws, { type: 'fact_saved', category: args.category });
            result = { success: true };
          } catch (err) {
            console.error('[Tool] Error guardando hecho:', err.message);
            result = { success: false };
          }
        }

        if (tc.function.name === 'mostrar_contenido') {
          const { titulo, tipo, contenido, lenguaje } = args;
          console.log(`[Tool] Mostrando contenido "${titulo}" (${tipo})`);
          safeSend(ws, { type: 'content', titulo, tipo, contenido, lenguaje: lenguaje ?? null });
          result = { success: true };
        }

        if (tc.function.name === 'generar_archivo') {
          const { nombre_archivo, contenido } = args;
          console.log(`[Tool] Generando archivo para descarga: ${nombre_archivo}`);
          safeSend(ws, {
            type: 'download',
            filename: nombre_archivo,
            mimeType: guessMimeType(nombre_archivo),
            contenido,
          });
          result = { success: true };
        }

        if (tc.function.name === 'enviar_email') {
          const { destinatario, asunto, cuerpo } = args;
          const draftId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          pendingEmailDraft = { draftId, destinatario, asunto, cuerpo };
          console.log(`[Tool] Borrador de email para confirmar: ${destinatario} — "${asunto}"`);
          safeSend(ws, { type: 'email_draft', draftId, destinatario, asunto, cuerpo });
          result = { success: true, status: 'esperando confirmación de Joshua en pantalla' };
        }

        if (tc.function.name === 'controlar_volumen') {
          try {
            const nivel = Math.max(0, Math.min(100, Math.round(args.nivel)));
            pendingSystemCommand = draftSystemCommand(
              ws, 'volumen', `Poner el volumen al ${nivel}%`, `set volume output volume ${nivel}`
            );
            console.log(`[Tool] Comando propuesto — volumen a ${nivel}%`);
            result = { success: true, status: 'esperando confirmación de Joshua en pantalla' };
          } catch (err) {
            console.error('[Tool] Error proponiendo comando de volumen:', err.message);
            result = { success: false, error: err.message };
          }
        }

        if (tc.function.name === 'controlar_brillo') {
          try {
            const { direccion } = args;
            if (direccion !== 'subir' && direccion !== 'bajar') {
              throw new Error('direccion tiene que ser "subir" o "bajar"');
            }
            // Sane ceiling — 16 taps is already well past the full brightness range.
            const pasos = Math.max(1, Math.min(16, Math.round(args.pasos) || 1));
            const keyCode = direccion === 'subir' ? 145 : 144; // standard macOS brightness key codes
            const script = `tell application "System Events"\n${Array(pasos).fill(`key code ${keyCode}`).join('\ndelay 0.15\n')}\nend tell`;
            pendingSystemCommand = draftSystemCommand(
              ws, 'brillo', `${direccion === 'subir' ? 'Subir' : 'Bajar'} el brillo ${pasos} paso${pasos > 1 ? 's' : ''}`, script
            );
            console.log(`[Tool] Comando propuesto — brillo ${direccion} x${pasos}`);
            result = { success: true, status: 'esperando confirmación de Joshua en pantalla' };
          } catch (err) {
            console.error('[Tool] Error proponiendo comando de brillo:', err.message);
            result = { success: false, error: err.message };
          }
        }

        if (tc.function.name === 'abrir_app') {
          try {
            const { nombre } = args;
            const nombreSeguro = escapeAppleScriptString(nombre);
            pendingSystemCommand = draftSystemCommand(
              ws, 'abrir_app', `Abrir ${nombre}`, `tell application "${nombreSeguro}" to activate`
            );
            console.log(`[Tool] Comando propuesto — abrir "${nombre}"`);
            result = { success: true, status: 'esperando confirmación de Joshua en pantalla' };
          } catch (err) {
            console.error('[Tool] Error proponiendo abrir app:', err.message);
            result = { success: false, error: err.message };
          }
        }

        if (tc.function.name === 'buscar_imagen_stock') {
          try {
            const resultados = await searchUnsplashImages(args.busqueda);
            console.log(`[Tool] Unsplash "${args.busqueda}": ${resultados.length} resultados`);
            // The model only gets text back from tool results — send the
            // actual images to the client separately so Joshua sees them.
            safeSend(ws, { type: 'images', query: args.busqueda, resultados });
            result = { success: true, resultados };
          } catch (err) {
            console.error('[Tool] Error buscando en Unsplash:', err.message);
            result = { success: false, error: err.message };
          }
        }

        if (tc.function.name === 'notificar_celular') {
          const { titulo, mensaje } = args;
          try {
            await sendNtfyNotification(titulo, mensaje);
            console.log(`[Tool] Notificación mandada al celular: "${titulo}"`);
            result = { success: true };
          } catch (err) {
            console.error('[Tool] Error mandando notificación:', err.message);
            result = { success: false, error: err.message };
          }
        }

        if (tc.function.name === 'cotizar_proyecto') {
          const { tipo, detalles } = args;
          console.log(`[Tool] Armando cotización — tipo: "${tipo}"`);
          // No external call and nothing to fetch — Joshua's pricing already
          // lives in the guardar_hecho facts injected into the system prompt.
          // This just standardizes the output shape and, importantly, tells
          // the model not to make up a price it doesn't actually know.
          result = {
            success: true,
            tipo,
            detalles: detalles || null,
            instrucciones:
              'Con los precios de Jzet Labs que ya sabés por los hechos guardados, armá la cotización lista para copiar ' +
              'y mandarle a un cliente: saludo breve, qué incluye el servicio para este tipo de proyecto, precio, y un ' +
              'cierre profesional invitando a confirmar. Concreto, sin relleno, en español. Si no sabés el precio de ' +
              'este tipo específico de proyecto, decilo y pedile el dato a Joshua en vez de inventar un número.',
          };
        }

        if (tc.function.name === 'leer_repo_github') {
          const { repo, ruta } = args;
          try {
            const contenido = await readGithubFile(repo, ruta);
            console.log(`[Tool] Leído ${repo}/${ruta} de GitHub (${contenido.length} caracteres)`);
            const truncado = contenido.length > MAX_TOOL_CONTENT_CHARS;
            result = {
              success: true,
              contenido: contenido.slice(0, MAX_TOOL_CONTENT_CHARS),
              ...(truncado ? {
                nota: `este archivo tiene ${contenido.length} caracteres en total, pero solo se cargaron los primeros ${MAX_TOOL_CONTENT_CHARS} — avisale a Joshua que estás viendo solo una parte y, si necesita el resto, pedile que te diga qué sección específica`,
              } : {}),
            };
          } catch (err) {
            console.error('[Tool] Error leyendo repo de GitHub:', err.message);
            result = { success: false, error: err.message };
          }
        }

        if (tc.function.name === 'explorar_repo_github') {
          const { repo, pregunta } = args;
          try {
            const { archivosExplorados, archivosTotales, archivosConError, resumen } =
              await exploreGithubRepo(groq, repo, pregunta || null);
            console.log(`[Tool] Exploré "${repo}": ${archivosExplorados}/${archivosTotales} archivos${archivosConError.length ? `, ${archivosConError.length} con error` : ''}`);
            const hayMas = archivosTotales > archivosExplorados;
            result = {
              success: true,
              repo,
              archivos_explorados: archivosExplorados,
              archivos_totales: archivosTotales,
              resumen,
              ...(archivosConError.length ? { archivos_con_error: archivosConError } : {}),
              ...(hayMas ? {
                nota: `este repo tiene ${archivosTotales} archivos relevantes en total, pero por límite de seguridad solo se exploraron los ${archivosExplorados} más importantes — avisale a Joshua que hay más disponibles por si quiere profundizar en algo puntual (con leer_repo_github para un archivo específico)`,
              } : {}),
            };
          } catch (err) {
            console.error(`[Tool] Error explorando repo "${repo}" de GitHub:`, err.message);
            result = { success: false, error: err.message };
          }
        }

        if (tc.function.name === 'buscar_web') {
          try {
            const { respuesta, resultados, truncado } = await searchWeb(args.query);
            console.log(`[Tool] Tavily "${args.query}": ${resultados.length} resultados${truncado ? ' (recortados)' : ''}`);
            result = {
              success: true,
              respuesta,
              resultados,
              ...(truncado ? {
                nota: 'algunos resultados o la respuesta sintetizada venían muy largos y se recortaron — avisale a Joshua si parece que falta contexto y ofrecele buscar algo más específico',
              } : {}),
            };
          } catch (err) {
            console.error('[Tool] Error buscando en la web:', err.message);
            result = { success: false, error: err.message };
          }
        }

        if (tc.function.name === 'resumir_texto') {
          const { texto, nivel } = args;
          try {
            const { resumen, truncado } = await summarizeText(groq, texto, nivel);
            console.log(`[Tool] Resumen generado (nivel: ${nivel || 'simple'}${truncado ? ', recortado' : ''})`);
            result = {
              success: true,
              resumen,
              ...(truncado ? {
                nota: `el texto original tenía ${texto.length} caracteres, se usaron los primeros ${MAX_TOOL_CONTENT_CHARS} para el resumen — avisale a Joshua si el resumen parece incompleto`,
              } : {}),
            };
          } catch (err) {
            console.error('[Tool] Error resumiendo texto:', err.message);
            result = { success: false, error: err.message };
          }
        }

        if (tc.function.name === 'crear_recordatorio') {
          const { mensaje, minutos_desde_ahora, fecha_hora } = args;
          // Log the model's raw args before any processing — if the date
          // ever comes out wrong again, this says immediately whether the
          // model ignored minutos_desde_ahora, sent a bad fecha_hora, or both.
          console.log(`[Recordatorio] Args del modelo — minutos_desde_ahora=${minutos_desde_ahora ?? 'n/a'} fecha_hora=${fecha_hora ?? 'n/a'}`);

          try {
            let resolvedFechaHora;

            if (typeof minutos_desde_ahora === 'number' && Number.isFinite(minutos_desde_ahora)) {
              // Relative time is computed here, deterministically — never by the model.
              resolvedFechaHora = new Date(Date.now() + minutos_desde_ahora * 60000).toISOString();
            } else if (typeof fecha_hora === 'string' && fecha_hora) {
              if (!/(Z|[+-]\d{2}:\d{2})$/.test(fecha_hora)) {
                throw new Error(`fecha_hora sin offset de zona horaria explícito: "${fecha_hora}" — no se puede guardar de forma confiable`);
              }
              resolvedFechaHora = fecha_hora;
            } else {
              throw new Error('falta minutos_desde_ahora o fecha_hora');
            }

            console.log(`[Recordatorio] fecha_hora resuelta antes de guardar: ${resolvedFechaHora}`);

            const reminder = await createReminder(mensaje, resolvedFechaHora);
            const legible = new Date(reminder.fecha_hora).toLocaleString('es-GT', {
              dateStyle: 'full',
              timeStyle: 'short',
              timeZone: 'America/Guatemala',
            });
            console.log(`[Tool] Recordatorio creado: "${mensaje}" para ${legible}`);
            // Same one-line pattern as fact_saved — just a trigger for the
            // frontend's "recordando" visual, no other behavior change.
            safeSend(ws, { type: 'reminder_created', mensaje, fecha_hora_legible: legible });
            result = { success: true, mensaje, fecha_hora_legible: legible };
          } catch (err) {
            console.error('[Tool] Error creando recordatorio:', err.message);
            result = { success: false, error: err.message };
          }
        }

        chatHistory.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }

      response = await groq.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'system', content: `${systemContent}\n\n${currentDateTimeBlock()}` }, ...chatHistory],
        tools: AVAILABLE_TOOLS,
        tool_choice: 'auto',
      });
      choice = response.choices[0];
    }

    const text = choice.message.content ?? '';
    chatHistory.push({ role: 'assistant', content: text });

    if (text) safeSend(ws, { type: 'text', content: text });

    safeSend(ws, { type: 'status', text: 'listening' });
  }

  handleMessage = async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Text typed or transcribed by the browser
      if (msg.type === 'text_input' && msg.text) {
        try {
          await runGroq(msg.text);
        } catch (err) {
          safeSend(ws, { type: 'text', content: describeGroqError(err) });
          safeSend(ws, { type: 'status', text: 'listening' });
        }
      }

      // File attachments — extract text content and pass to Groq
      if (msg.type === 'file') {
        try {
          let userContent = null;

          if (msg.mimeType === 'application/pdf' && msg.data != null) {
            const buffer = Buffer.from(msg.data, 'base64');
            const parser = new PDFParse({ data: buffer });
            const { text } = await parser.getText();
            await parser.destroy();
            const preview = text.slice(0, MAX_TOOL_CONTENT_CHARS);
            // Unlike a tool result (which can carry a separate `nota` field
            // the model reads on its own), this becomes the user turn's raw
            // content — the truncation notice has to live inline in the text
            // itself so Coder actually sees it and can mention it.
            const nota = text.length > MAX_TOOL_CONTENT_CHARS
              ? `\n\n(este PDF tiene ${text.length} caracteres en total, pero solo se cargaron los primeros ${MAX_TOOL_CONTENT_CHARS} — avisale a Joshua que estás viendo solo una parte y, si necesita el resto, pedile que te diga qué sección específica)`
              : '';
            userContent = `[PDF adjunto: ${msg.filename}]\n\`\`\`\n${preview}\n\`\`\`${nota}`;
          } else if (msg.mimeType === 'text/plain' && msg.text != null) {
            const preview = msg.text.slice(0, MAX_TOOL_CONTENT_CHARS);
            const nota = msg.text.length > MAX_TOOL_CONTENT_CHARS
              ? `\n\n(este archivo tiene ${msg.text.length} caracteres en total, pero solo se cargaron los primeros ${MAX_TOOL_CONTENT_CHARS} — avisale a Joshua que estás viendo solo una parte y, si necesita el resto, pedile que te diga qué sección específica)`
              : '';
            userContent = `[Archivo adjunto: ${msg.filename}]\n\`\`\`\n${preview}\n\`\`\`${nota}`;
          } else if (msg.mimeType === 'image/jpeg' && msg.data != null) {
            const analisis = await analyzeImage(groq, msg.data, msg.filename);
            console.log(`[WS] Imagen "${msg.filename}" analizada con ${VISION_MODEL}`);
            userContent = analisis
              ? `[Imagen adjunta: ${msg.filename}]\n${analisis}`
              : `[Imagen adjunta: ${msg.filename}] (no se pudo generar una descripción — pedile a Joshua que la describa él si hace falta)`;
          }

          console.log(`[WS] Archivo recibido: ${msg.filename} (${msg.mimeType})`);
          safeSend(ws, { type: 'file_received', filename: msg.filename });

          if (userContent) {
            try {
              await runGroq(userContent);
            } catch (err) {
              safeSend(ws, { type: 'text', content: describeGroqError(err) });
              safeSend(ws, { type: 'status', text: 'listening' });
            }
          }
        } catch (err) {
          console.error('[WS] Error procesando archivo:', err.message);
          safeSend(ws, { type: 'file_error', filename: msg.filename });
        }
      }

      // User approved/rejected an enviar_email draft from the confirmation panel
      if (msg.type === 'email_confirm') {
        if (!pendingEmailDraft || pendingEmailDraft.draftId !== msg.draftId) return;
        const draft = pendingEmailDraft;
        pendingEmailDraft = null;

        if (!msg.approved) {
          console.log('[Email] Borrador cancelado por Joshua');
          safeSend(ws, { type: 'email_cancelled', draftId: draft.draftId });
          return;
        }

        if (!mailTransport) {
          console.error('[Email] No se puede enviar: faltan EMAIL_USER/EMAIL_APP_PASSWORD en .env');
          safeSend(ws, { type: 'email_error', draftId: draft.draftId, message: 'faltan credenciales de email en el servidor (.env)' });
          return;
        }

        try {
          await mailTransport.sendMail({
            from: process.env.EMAIL_USER,
            to: draft.destinatario,
            subject: draft.asunto,
            text: draft.cuerpo,
          });
          console.log(`[Email] Enviado a ${draft.destinatario}`);
          safeSend(ws, { type: 'email_sent', draftId: draft.draftId });
        } catch (err) {
          console.error('[Email] Error enviando:', err.message);
          safeSend(ws, { type: 'email_error', draftId: draft.draftId, message: err.message });
        }
      }

      // User approved/rejected a controlar_volumen / controlar_brillo / abrir_app
      // draft — the osascript only runs here, after explicit confirmation.
      if (msg.type === 'system_command_confirm') {
        if (!pendingSystemCommand || pendingSystemCommand.draftId !== msg.draftId) return;
        const draft = pendingSystemCommand;
        pendingSystemCommand = null;

        if (!msg.approved) {
          console.log('[Sistema] Comando cancelado por Joshua:', draft.descripcion);
          safeSend(ws, { type: 'system_command_cancelled', draftId: draft.draftId });
          return;
        }

        try {
          await execFileAsync('osascript', ['-e', draft.script]);
          console.log(`[Sistema] Ejecutado: ${draft.descripcion}`);
          safeSend(ws, { type: 'system_command_done', draftId: draft.draftId, descripcion: draft.descripcion });
        } catch (err) {
          console.error('[Sistema] Error ejecutando comando:', err.message);
          safeSend(ws, { type: 'system_command_error', draftId: draft.draftId, message: err.message });
        }
      }

      // Push-to-talk: raw 16 kHz PCM16 chunks stream in while the button is
      // held, then audio_end triggers transcription + the normal chat flow.
      if (msg.type === 'audio' && msg.data) {
        recordedChunks.push(Buffer.from(msg.data, 'base64'));
      }

      if (msg.type === 'audio_end') {
        const pcm = Buffer.concat(recordedChunks);
        recordedChunks = [];

        if (pcm.length < STT_MIN_BYTES) {
          // Accidental tap, not speech — nothing worth sending to Whisper.
          safeSend(ws, { type: 'status', text: 'listening' });
        } else {
          try {
            const text = await transcribeAudio(groq, pcm);

            if (!text) {
              safeSend(ws, { type: 'text', content: '(no escuché nada — probá de nuevo)' });
              safeSend(ws, { type: 'status', text: 'listening' });
            } else {
              safeSend(ws, { type: 'stt_result', text });
              try {
                await runGroq(text);
              } catch (err) {
                safeSend(ws, { type: 'text', content: describeGroqError(err) });
                safeSend(ws, { type: 'status', text: 'listening' });
              }
            }
          } catch (err) {
            safeSend(ws, { type: 'text', content: describeGroqError(err) });
            safeSend(ws, { type: 'status', text: 'listening' });
          }
        }
      }

      // video: ignored — camera frames are context-only, never trigger a response by themselves
    } catch (err) {
      console.error('[WS] Error procesando mensaje del cliente:', err.message);
    }
  };

  // Now that handleMessage is assigned, flush anything that arrived while
  // Supabase was still loading, in the order it was received.
  contextReady = true;
  while (earlyMessages.length) await handleMessage(earlyMessages.shift());

  ws.on('close', () => {
    console.log('[WS] Cliente desconectado');
  });
});

function getLocalIP() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\nCoder Web`);
  console.log(`  local   → http://localhost:${PORT}`);
  console.log(`  celular → http://${ip}:${PORT}\n`);
});
