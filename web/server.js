import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import Groq, { toFile } from 'groq-sdk';
import { PDFParse } from 'pdf-parse';
import nodemailer from 'nodemailer';
import { getSystemPrompt, getRelevantFacts, saveFact } from '../src/memory.js';
import { MODEL, ALL_TOOLS, buildSystemContent } from '../src/groq-brain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WEB_PORT || 3000;

const app = express();
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

// leer_repo_github — public GitHub Contents API; GITHUB_TOKEN is optional and
// only needed to read private repos (public ones work with zero config).
const GITHUB_OWNER = 'manz55';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;

if (!GITHUB_TOKEN) {
  console.warn('[GitHub] GITHUB_TOKEN no configurado — leer_repo_github solo va a poder leer repos públicos');
}

async function readGithubFile(repo, ruta) {
  // Encode each path segment (spaces, accents, etc.) without touching the slashes.
  const encodedPath = ruta.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${encodedPath}`;

  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'coder-assistant' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });

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
  return {
    respuesta: data.answer ?? null,
    resultados: (data.results ?? []).map((r) => ({
      titulo: r.title,
      url: r.url,
      resumen: r.content,
    })),
  };
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
  let recordedChunks = [];

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

    let response = await groq.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: systemContent }, ...chatHistory],
      tools: ALL_TOOLS,
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

        if (tc.function.name === 'buscar_imagen_stock') {
          try {
            const resultados = await searchUnsplashImages(args.busqueda);
            console.log(`[Tool] Unsplash "${args.busqueda}": ${resultados.length} resultados`);
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

        if (tc.function.name === 'leer_repo_github') {
          const { repo, ruta } = args;
          try {
            const contenido = await readGithubFile(repo, ruta);
            console.log(`[Tool] Leído ${repo}/${ruta} de GitHub (${contenido.length} caracteres)`);
            result = { success: true, contenido: contenido.slice(0, 60000) };
          } catch (err) {
            console.error('[Tool] Error leyendo repo de GitHub:', err.message);
            result = { success: false, error: err.message };
          }
        }

        if (tc.function.name === 'buscar_web') {
          try {
            const { respuesta, resultados } = await searchWeb(args.query);
            console.log(`[Tool] Tavily "${args.query}": ${resultados.length} resultados`);
            result = { success: true, respuesta, resultados };
          } catch (err) {
            console.error('[Tool] Error buscando en la web:', err.message);
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
        messages: [{ role: 'system', content: systemContent }, ...chatHistory],
        tools: ALL_TOOLS,
        tool_choice: 'auto',
      });
      choice = response.choices[0];
    }

    const text = choice.message.content ?? '';
    chatHistory.push({ role: 'assistant', content: text });

    if (text) safeSend(ws, { type: 'text', content: text });

    safeSend(ws, { type: 'status', text: 'listening' });
  }

  ws.on('message', async (raw) => {
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
            const preview = text.slice(0, 60000);
            userContent = `[PDF adjunto: ${msg.filename}]\n\`\`\`\n${preview}\n\`\`\``;
          } else if (msg.mimeType === 'text/plain' && msg.text != null) {
            const preview = msg.text.slice(0, 60000);
            userContent = `[Archivo adjunto: ${msg.filename}]\n\`\`\`\n${preview}\n\`\`\``;
          } else if (msg.mimeType === 'image/jpeg') {
            userContent = `[Imagen adjunta: ${msg.filename}] (en modo texto no puedo ver imágenes — describila vos si querés que la analice)`;
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
  });

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
