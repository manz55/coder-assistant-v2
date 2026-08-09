import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { GoogleGenAI } from '@google/genai';
import { PDFParse } from 'pdf-parse';
import nodemailer from 'nodemailer';
import { getSystemPrompt, getRelevantFacts, saveFact } from '../src/memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WEB_PORT || 3000;

const app = express();
app.use(express.static(join(__dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

const CATEGORIAS_VALIDAS = ['perfil', 'proyectos', 'ventas_jzet_labs', 'dev_preferences', 'personal'];
const TIPOS_CONTENIDO_VALIDOS = ['codigo', 'sql', 'texto', 'lista'];

const TOOL_DECLARATIONS = [{
  functionDeclarations: [
    {
      name: 'guardar_hecho',
      description:
        'Guarda un hecho nuevo y duradero sobre Joshua o sus proyectos, para recordarlo en futuras conversaciones. ' +
        'Usalo SOLO cuando Joshua comparta algo permanente que valga la pena recordar — nunca para cosas triviales.',
      parameters: {
        type: 'OBJECT',
        properties: {
          category: {
            type: 'STRING',
            description: `Una de: ${CATEGORIAS_VALIDAS.join(', ')}`,
          },
          content: {
            type: 'STRING',
            description: 'El hecho en texto plano, en español, en tercera persona',
          },
        },
        required: ['category', 'content'],
      },
    },
    {
      name: 'mostrar_contenido',
      description:
        'Muestra código, SQL, texto largo o listas en el panel de pantalla, en vez de leerlo en voz alta. ' +
        'Usala SIEMPRE que Joshua pida código, una query SQL, o cualquier contenido largo o estructurado. ' +
        'Después de invocarla, decí solo algo breve como "ahí te lo dejé en pantalla" — nunca leas el contenido en voz alta.',
      parameters: {
        type: 'OBJECT',
        properties: {
          titulo: {
            type: 'STRING',
            description: 'Título corto que describe el contenido',
          },
          tipo: {
            type: 'STRING',
            description: `Una de: ${TIPOS_CONTENIDO_VALIDOS.join(', ')}`,
          },
          contenido: {
            type: 'STRING',
            description: 'El contenido completo a mostrar',
          },
          lenguaje: {
            type: 'STRING',
            description: 'Lenguaje para syntax highlighting (ej. javascript, python, sql) — opcional',
          },
        },
        required: ['titulo', 'tipo', 'contenido'],
      },
    },
    {
      name: 'generar_archivo',
      description:
        'Genera un archivo real y lo descarga automáticamente en el navegador de Joshua, sin que tenga que copiar nada. ' +
        'Usala cuando Joshua pida explícitamente un archivo para descargar, guardar o pegar en otro lado ' +
        '(ej. "pasame un sql para pegar en Supabase", "dame un csv", "generame un archivo con..."). ' +
        'Si Joshua solo quiere VER el contenido en pantalla sin descargarlo, usá mostrar_contenido en cambio. ' +
        'Después de invocarla, decí solo algo breve como "ahí te lo descargué" — nunca leas el contenido en voz alta.',
      parameters: {
        type: 'OBJECT',
        properties: {
          nombre_archivo: {
            type: 'STRING',
            description: 'Nombre del archivo con extensión apropiada (ej. "seed.sql", "usuarios.csv", "notas.txt")',
          },
          contenido: {
            type: 'STRING',
            description: 'El contenido completo del archivo',
          },
        },
        required: ['nombre_archivo', 'contenido'],
      },
    },
    {
      name: 'enviar_email',
      description:
        'Prepara un borrador de email y lo muestra en pantalla para que Joshua lo confirme ANTES de mandarlo — nunca se envía directo sin aprobación. ' +
        'Usala cuando Joshua pida mandar, escribir o redactar un mail/email para alguien. ' +
        'Después de invocarla, decí solo algo breve como "te dejé el borrador en pantalla, confirmá para mandarlo" — nunca leas el cuerpo del mail en voz alta.',
      parameters: {
        type: 'OBJECT',
        properties: {
          destinatario: { type: 'STRING', description: 'Dirección de email del destinatario' },
          asunto: { type: 'STRING', description: 'Asunto del email' },
          cuerpo: { type: 'STRING', description: 'Cuerpo del email en texto plano' },
        },
        required: ['destinatario', 'asunto', 'cuerpo'],
      },
    },
    {
      name: 'buscar_imagen_stock',
      description:
        'Busca imágenes de stock gratuitas en Unsplash relacionadas a un término — útil para armar landing pages de clientes rápido. ' +
        'Devuelve 3-4 resultados con su URL y autor. Después de recibir los resultados, usá mostrar_contenido (tipo "lista") para mostrárselos ' +
        'a Joshua en pantalla — nunca leas las URLs en voz alta.',
      parameters: {
        type: 'OBJECT',
        properties: {
          busqueda: {
            type: 'STRING',
            description: 'Término de búsqueda — en inglés suele dar mejores resultados (ej. "office team", "coffee shop")',
          },
        },
        required: ['busqueda'],
      },
    },
  ],
}];

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

function buildSystemInstruction(systemPrompt, facts) {
  if (!facts.length) return systemPrompt;
  return (
    systemPrompt +
    '\n\n--- HECHOS QUE SABÉS SOBRE JOSHUA ---\n' +
    facts.map(f => `[${f.category}] ${f.content}`).join('\n') +
    '\n--- FIN DE HECHOS ---'
  );
}

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on('connection', async (ws) => {
  console.log('[WS] Cliente conectado');
  let session = null;
  let pendingEmailDraft = null; // { draftId, destinatario, asunto, cuerpo } — awaiting user confirmation in the UI

  // Load context — fall back to defaults if Supabase is unavailable
  let systemPrompt = 'Sos Coder, el asistente personal de Joshua. Hablás en español rioplatense, sos directo e inteligente.';
  let facts = [];

  try {
    [systemPrompt, facts] = await Promise.all([getSystemPrompt(), getRelevantFacts()]);
    console.log(`[WS] Contexto cargado: ${facts.length} hechos`);
  } catch (err) {
    console.warn('[WS] Supabase no disponible, usando defaults:', err.message);
  }

  // Open Gemini Live session
  try {
    session = await ai.live.connect({
      model: "gemini-3.1-flash-live-preview",
      config: {
        responseModalities: ['AUDIO'],
        outputAudioTranscription: {},
        systemInstruction: buildSystemInstruction(systemPrompt, facts),
        tools: TOOL_DECLARATIONS,
      },
      callbacks: {
        onopen: () => {
          console.log('[Gemini] Sesión Live abierta');
          safeSend(ws, { type: 'status', text: 'ready' });
        },

        onmessage: async (message) => {
          // Audio chunks
          const parts = message.serverContent?.modelTurn?.parts ?? [];
          for (const part of parts) {
            if (part.inlineData?.data) {
              safeSend(ws, { type: 'audio', data: part.inlineData.data });
            }
          }

          // Output transcription (text of what Coder is saying, synced with audio)
          if (message.serverContent?.outputTranscription?.text) {
            safeSend(ws, { type: 'text', content: message.serverContent.outputTranscription.text });
          }

          // Turn complete → back to listening
          if (message.serverContent?.turnComplete) {
            safeSend(ws, { type: 'status', text: 'listening' });
          }

          // Tool calls
          if (message.toolCall?.functionCalls?.length) {
            const responses = [];
            for (const fc of message.toolCall.functionCalls) {
              if (fc.name === 'guardar_hecho') {
                try {
                  await saveFact(fc.args.category, fc.args.content);
                  console.log(`[Tool] Hecho guardado en "${fc.args.category}": ${fc.args.content}`);
                  safeSend(ws, { type: 'fact_saved', category: fc.args.category });
                  responses.push({ id: fc.id, name: fc.name, response: { success: true } });
                } catch (err) {
                  console.error('[Tool] Error guardando hecho:', err.message);
                  responses.push({ id: fc.id, name: fc.name, response: { success: false } });
                }
              }

              if (fc.name === 'mostrar_contenido') {
                const { titulo, tipo, contenido, lenguaje } = fc.args;
                console.log(`[Tool] Mostrando contenido "${titulo}" (${tipo})`);
                safeSend(ws, { type: 'content', titulo, tipo, contenido, lenguaje: lenguaje ?? null });
                responses.push({ id: fc.id, name: fc.name, response: { success: true } });
              }

              if (fc.name === 'generar_archivo') {
                const { nombre_archivo, contenido } = fc.args;
                console.log(`[Tool] Generando archivo para descarga: ${nombre_archivo}`);
                safeSend(ws, {
                  type: 'download',
                  filename: nombre_archivo,
                  mimeType: guessMimeType(nombre_archivo),
                  contenido,
                });
                responses.push({ id: fc.id, name: fc.name, response: { success: true } });
              }

              if (fc.name === 'enviar_email') {
                const { destinatario, asunto, cuerpo } = fc.args;
                const draftId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                pendingEmailDraft = { draftId, destinatario, asunto, cuerpo };
                console.log(`[Tool] Borrador de email para confirmar: ${destinatario} — "${asunto}"`);
                safeSend(ws, { type: 'email_draft', draftId, destinatario, asunto, cuerpo });
                responses.push({
                  id: fc.id,
                  name: fc.name,
                  response: { success: true, status: 'esperando confirmación de Joshua en pantalla' },
                });
              }

              if (fc.name === 'buscar_imagen_stock') {
                try {
                  const resultados = await searchUnsplashImages(fc.args.busqueda);
                  console.log(`[Tool] Unsplash "${fc.args.busqueda}": ${resultados.length} resultados`);
                  responses.push({ id: fc.id, name: fc.name, response: { success: true, resultados } });
                } catch (err) {
                  console.error('[Tool] Error buscando en Unsplash:', err.message);
                  responses.push({ id: fc.id, name: fc.name, response: { success: false, error: err.message } });
                }
              }
            }
            if (responses.length) {
              session.sendToolResponse({ functionResponses: responses });
            }
          }
        },

        onerror: (err) => {
          console.error('[Gemini] Error:', JSON.stringify(err) ?? err);
          safeSend(ws, { type: 'error', message: String(err?.message ?? err) });
        },

        onclose: (evt) => {
          console.log('[Gemini] Sesión cerrada — code:', evt?.code, 'reason:', evt?.reason ?? '(sin razón)');
          ws.close();
        },
      },
    });
  } catch (err) {
    console.error('[WS] Error abriendo sesión Gemini Live:', err.message);
    safeSend(ws, { type: 'error', message: err.message });
    ws.close();
    return;
  }

  // Forward browser messages → Gemini
  ws.on('message', async (raw) => {
    if (!session) return;
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'audio') {
        session.sendRealtimeInput({
          audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
        });
      }

      // Push-to-talk released: tell the Live API the mic stream is done so
      // it can finalize turn detection instead of waiting for more audio.
      if (msg.type === 'audio_end') {
        session.sendRealtimeInput({ audioStreamEnd: true });
      }

      // Text typed instead of spoken — same realtime channel, same context.
      if (msg.type === 'text_input' && msg.text) {
        session.sendRealtimeInput({ text: msg.text });
      }

      if (msg.type === 'video') {
        session.sendRealtimeInput({
          video: { data: msg.data, mimeType: 'image/jpeg' },
        });
      }

      if (msg.type === 'file') {
        try {
          if (msg.mimeType === 'image/jpeg') {
            session.sendClientContent({
              turns: [{
                role: 'user',
                parts: [
                  { inlineData: { data: msg.data, mimeType: 'image/jpeg' } },
                  { text: `[Imagen adjunta: ${msg.filename}] Comentá brevemente qué ves.` },
                ],
              }],
              turnComplete: true,
            });
          } else if (msg.mimeType === 'application/pdf' && msg.data != null) {
            const buffer = Buffer.from(msg.data, 'base64');
            const parser = new PDFParse({ data: buffer });
            const { text } = await parser.getText();
            await parser.destroy();
            const preview = text.slice(0, 60000);
            session.sendClientContent({
              turns: [{
                role: 'user',
                parts: [{ text: `[PDF adjunto: ${msg.filename}]\n\`\`\`\n${preview}\n\`\`\`` }],
              }],
              turnComplete: true,
            });
          } else if (msg.mimeType === 'text/plain' && msg.text != null) {
            const preview = msg.text.slice(0, 60000);
            session.sendClientContent({
              turns: [{
                role: 'user',
                parts: [{ text: `[Archivo adjunto: ${msg.filename}]\n\`\`\`\n${preview}\n\`\`\`` }],
              }],
              turnComplete: true,
            });
          }
          console.log(`[WS] Archivo recibido: ${msg.filename} (${msg.mimeType})`);
          safeSend(ws, { type: 'file_received', filename: msg.filename });
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
    } catch (err) {
      console.error('[WS] Error procesando mensaje del cliente:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Cliente desconectado');
    try { session?.close(); } catch {}
    session = null;
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
