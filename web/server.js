import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import Groq from 'groq-sdk';
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

wss.on('connection', async (ws) => {
  console.log('[WS] Cliente conectado');
  let pendingEmailDraft = null;

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
          console.error('[Groq] Error:', err.message);
          safeSend(ws, { type: 'text', content: '(error contactando Groq — intentá de nuevo)' });
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
              console.error('[Groq] Error analizando archivo:', err.message);
              safeSend(ws, { type: 'text', content: '(no pude analizar el archivo — intentá de nuevo)' });
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

      // audio, audio_end, video: ignored until STT/TTS is wired up
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
