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
];

export const TERMINAL_TOOLS = ALL_TOOLS.filter(t => t.function.name === 'guardar_hecho');

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
