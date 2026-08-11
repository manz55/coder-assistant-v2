import Groq from 'groq-sdk';

// llama-3.3-70b-versatile: Groq announced its deprecation 2026-06-17, hard
// shutdown 2026-08-16 — requests started failing before the cutover date.
// openai/gpt-oss-120b is Groq's recommended replacement with tool-use support.
export const MODEL = 'openai/gpt-oss-120b';
export const CATEGORIAS_VALIDAS = ['perfil', 'proyectos', 'ventas_jzet_labs', 'dev_preferences', 'personal'];
export const TIPOS_CONTENIDO_VALIDOS = ['codigo', 'sql', 'texto', 'lista'];

export const ALL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'guardar_hecho',
      description:
        'Guarda un hecho nuevo y duradero sobre Joshua o sus proyectos, para recordarlo en futuras conversaciones. ' +
        'Usalo SOLO cuando Joshua comparta algo permanente que valga la pena recordar (una decisión, una preferencia, ' +
        'un dato de un proyecto, un cliente nuevo, etc.) — nunca para cosas triviales, temporales o hipotéticas.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: `Una de: ${CATEGORIAS_VALIDAS.join(', ')}`,
          },
          content: {
            type: 'string',
            description: 'El hecho en texto plano, en español, redactado de forma clara y en tercera persona',
          },
        },
        required: ['category', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mostrar_contenido',
      description:
        'Muestra código, SQL, texto largo o listas en el panel de pantalla, en vez de escribirlo en el chat. ' +
        'Usala SIEMPRE que Joshua pida código, una query SQL, o cualquier contenido largo o estructurado. ' +
        'Después de invocarla, respondé solo algo breve como "ahí te lo dejé en pantalla" — nunca repitas el contenido en el chat.',
      parameters: {
        type: 'object',
        properties: {
          titulo: {
            type: 'string',
            description: 'Título corto que describe el contenido',
          },
          tipo: {
            type: 'string',
            description: `Una de: ${TIPOS_CONTENIDO_VALIDOS.join(', ')}`,
          },
          contenido: {
            type: 'string',
            description: 'El contenido completo a mostrar',
          },
          lenguaje: {
            type: 'string',
            description: 'Lenguaje para syntax highlighting (ej. javascript, python, sql) — opcional',
          },
        },
        required: ['titulo', 'tipo', 'contenido'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generar_archivo',
      description:
        'Genera un archivo real y lo descarga automáticamente en el navegador de Joshua, sin que tenga que copiar nada. ' +
        'Usala cuando Joshua pida explícitamente un archivo para descargar, guardar o pegar en otro lado. ' +
        'Si Joshua solo quiere VER el contenido en pantalla sin descargarlo, usá mostrar_contenido en cambio. ' +
        'Después de invocarla, respondé solo algo breve como "ahí te lo descargué" — nunca repitas el contenido.',
      parameters: {
        type: 'object',
        properties: {
          nombre_archivo: {
            type: 'string',
            description: 'Nombre del archivo con extensión apropiada (ej. "seed.sql", "usuarios.csv", "notas.txt")',
          },
          contenido: {
            type: 'string',
            description: 'El contenido completo del archivo',
          },
        },
        required: ['nombre_archivo', 'contenido'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_email',
      description:
        'Prepara un borrador de email y lo muestra en pantalla para que Joshua lo confirme ANTES de mandarlo — nunca se envía directo sin aprobación. ' +
        'Usala cuando Joshua pida mandar, escribir o redactar un mail/email para alguien. ' +
        'Después de invocarla, respondé solo algo breve como "te dejé el borrador en pantalla, confirmá para mandarlo".',
      parameters: {
        type: 'object',
        properties: {
          destinatario: { type: 'string', description: 'Dirección de email del destinatario' },
          asunto: { type: 'string', description: 'Asunto del email' },
          cuerpo: { type: 'string', description: 'Cuerpo del email en texto plano' },
        },
        required: ['destinatario', 'asunto', 'cuerpo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_imagen_stock',
      description:
        'Busca imágenes de stock gratuitas en Unsplash relacionadas a un término — útil para armar landing pages de clientes rápido. ' +
        'Devuelve 3-4 resultados con su URL y autor. Después de recibir los resultados, usá mostrar_contenido (tipo "lista") para mostrárselos ' +
        'a Joshua en pantalla — nunca repitas las URLs en el chat.',
      parameters: {
        type: 'object',
        properties: {
          busqueda: {
            type: 'string',
            description: 'Término de búsqueda — en inglés suele dar mejores resultados (ej. "office team", "coffee shop")',
          },
        },
        required: ['busqueda'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notificar_celular',
      description:
        'Manda una notificación push al celular de Joshua. ' +
        'Usala cuando Joshua pida explícitamente que le avises algo al celular, o para avisarle que algo terminó ' +
        '(una tarea larga, un análisis, etc.) cuando él lo haya pedido. No la uses para cosas triviales ni sin que la pida.',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título corto de la notificación' },
          mensaje: { type: 'string', description: 'Cuerpo de la notificación' },
        },
        required: ['titulo', 'mensaje'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'leer_repo_github',
      description:
        'Lee el contenido de un archivo de uno de los repos de GitHub de Joshua (github.com/manz55), ' +
        'sin depender de que esté en su Mac. Usala cuando pida ver, revisar o analizar un archivo de un repo por nombre y ruta.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Nombre del repositorio, ej. "coder-assistant-v2"' },
          ruta: { type: 'string', description: 'Ruta del archivo dentro del repo, ej. "src/index.js"' },
        },
        required: ['repo', 'ruta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explorar_repo_github',
      description:
        'Explora un repo entero de GitHub de Joshua (github.com/manz55) sin que tengas que pedir archivo por archivo: ' +
        'lista los archivos, prioriza los más relevantes (README, manifest de dependencias como package.json, y el código ' +
        'principal en src/app/lib/pages/components), los lee y resume uno por uno, y al final te da una síntesis del ' +
        'repo entero — arquitectura, qué hace, stack tecnológico — o, si mandás "pregunta", una respuesta enfocada en eso ' +
        'específico. Tarda bastante más que leer_repo_github porque hace varias lecturas y resúmenes en cadena, así que ' +
        'usala cuando Joshua pida un panorama general o "revisá/explorá el repo X" — si ya sabés el archivo puntual que ' +
        'necesitás, usá leer_repo_github en cambio, es mucho más rápido. Por límite de seguridad explora como máximo 15 ' +
        'archivos; si el repo tiene más, te lo va a avisar en la respuesta para que se lo digas a Joshua.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Nombre del repositorio, ej. "coder-assistant-v2"' },
          pregunta: {
            type: 'string',
            description: 'Opcional — qué buscar específicamente en el repo (ej. "cómo maneja la autenticación"). Si no la mandás, hace un resumen general del repo.',
          },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_web',
      description:
        'Busca información actual en internet — noticias, precios, eventos recientes, o cualquier cosa fuera del ' +
        'conocimiento de Coder. Devuelve un resumen y hasta 5 fuentes con su URL; usalas para responder, citando la fuente si corresponde.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Términos de búsqueda' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crear_recordatorio',
      description:
        'Crea un recordatorio — Coder le manda una notificación push al celular de Joshua cuando llega el momento. ' +
        'Usala cuando Joshua pida que le recuerdes algo en un momento específico.\n\n' +
        'IMPORTANTE — cómo elegir el momento: NUNCA calcules vos una fecha/hora absoluta para pedidos relativos ' +
        '("en 5 minutos", "en 2 horas", "en una hora") — los LLMs son malos haciendo esa aritmética. Para esos casos ' +
        'usá minutos_desde_ahora con el número de minutos, y dejá que el servidor haga la cuenta. ' +
        'Usá fecha_hora SOLO para una fecha/hora absoluta y explícita ("el 20 de agosto a las 10", "mañana a las 3pm") — ' +
        'en ese caso tiene que ser ISO 8601 CON offset explícito (ej. "2026-08-20T10:00:00-06:00", nunca sin el "-06:00" al final), ' +
        'basándote en el ISO de "ahora" que tenés en el system prompt. Mandá uno de los dos parámetros, nunca ninguno.\n\n' +
        'Después de invocarla, confirmá con Joshua qué guardaste y para cuándo usando fecha_hora_legible que te devuelve — nunca le muestres el ISO crudo.',
      parameters: {
        type: 'object',
        properties: {
          mensaje: { type: 'string', description: 'Qué hay que recordarle a Joshua' },
          minutos_desde_ahora: {
            type: 'integer',
            description: 'Preferido para pedidos relativos ("en N minutos/horas") — cantidad de minutos desde ahora. El servidor calcula la fecha exacta.',
          },
          fecha_hora: {
            type: 'string',
            description: 'Solo para fechas/horas absolutas. ISO 8601 CON offset explícito, ej. "2026-08-20T10:00:00-06:00".',
          },
        },
        required: ['mensaje'],
      },
    },
  },
];

export const TERMINAL_TOOLS = ALL_TOOLS.filter(t => t.function.name === 'guardar_hecho');

const REMINDER_TIMEZONE = 'America/Guatemala'; // UTC-6, no DST

// ISO 8601 string with an explicit numeric offset, e.g. "2026-08-11T00:41:00-06:00".
// Built from Intl parts rather than toISOString() so the offset reflects
// REMINDER_TIMEZONE instead of always being "Z" (UTC).
function isoNowInTimezone(timeZone) {
  const fields = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const p = Object.fromEntries(fields.map(f => [f.type, f.value]));

  const offsetName = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date())
    .find(f => f.type === 'timeZoneName').value; // "GMT-06:00"
  const offset = offsetName.replace('GMT', '') || '+00:00';

  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

// Called fresh on every chat.completions.create — NOT baked into the static
// system content once per connection, which would go stale on long-running
// sessions (a request for "en 5 minutos" late in a multi-hour session would
// otherwise still be anchored to whatever "now" was at connect time).
export function currentDateTimeBlock() {
  const legible = new Date().toLocaleString('es-GT', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: REMINDER_TIMEZONE,
  });
  const iso = isoNowInTimezone(REMINDER_TIMEZONE);

  return `--- FECHA Y HORA ACTUAL ---\n${legible} (${REMINDER_TIMEZONE}, UTC-6)\nISO: ${iso}\n--- FIN FECHA Y HORA ---`;
}

export function buildSystemContent(systemPrompt, facts) {
  if (!facts.length) return systemPrompt;
  return (
    systemPrompt +
    '\n\n--- HECHOS QUE SABÉS SOBRE JOSHUA ---\n' +
    facts.map(f => `[${f.category}] ${f.content}`).join('\n') +
    '\n--- FIN DE HECHOS ---'
  );
}

export async function summarizeConversation(transcript) {
  if (!transcript.length) return null;
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const transcriptText = transcript
    .map(t => `${t.role === 'user' ? 'Joshua' : 'Coder'}: ${t.text}`)
    .join('\n');

  const prompt = `Resumí la siguiente conversación entre Joshua y su asistente Coder en 2-3 oraciones,
y sacá una lista corta de temas (topics) tratados, en minúsculas y sin espacios (usá guiones si hace falta).

Conversación:
${transcriptText}

Respondé ÚNICAMENTE con JSON válido, sin backticks ni texto extra, con este formato exacto:
{"summary": "...", "topics": ["...", "..."]}`;

  try {
    const response = await groq.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.choices[0].message.content.trim();
    const clean = text.replace(/^```json\s*|\s*```$/g, '');
    return JSON.parse(clean);
  } catch (err) {
    console.error('No se pudo generar el resumen:', err.message);
    return null;
  }
}
