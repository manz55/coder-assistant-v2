import Groq from 'groq-sdk';
import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';

// llama-3.3-70b-versatile: Groq announced its deprecation 2026-06-17, hard
// shutdown 2026-08-16 — requests started failing before the cutover date.
// openai/gpt-oss-120b is Groq's recommended replacement with tool-use support.
export const MODEL = 'openai/gpt-oss-120b';
// MODEL has no vision support (confirmed against console.groq.com/docs/vision,
// Aug 2026) — qwen/qwen3.6-27b is Groq's only current vision-capable model.
// Used exclusively for image attachments (see analyzeImage in web/server.js);
// the main conversation stays on MODEL.
export const VISION_MODEL = 'qwen/qwen3.6-27b';
// Fallback provider for when Groq's daily token quota runs out (happened 3x
// in 2 days — see createGeminiClient/createChatCompletionWithFallback in
// web/server.js). Went with Gemini over Cerebras because Cerebras's free
// trial requires a verified payment method to activate (confirmed against
// their rate-limits doc) — doesn't meet the zero-cost requirement. Gemini's
// AI Studio key is free with no card. gemini-3.6-flash confirmed live via
// GET /v1beta/models against the real GEMINI_API_KEY already in .env
// (leftover from before this project moved to Groq) — it's the newest
// non-preview flash model, appropriate for a fallback path that should be
// stable rather than experimental.
export const GEMINI_MODEL = 'gemini-3.6-flash';
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
            description: 'Qué buscar específicamente en el repo (ej. "cómo maneja la autenticación"). Omití esta clave por completo — nunca mandes null ni "" — si Joshua pidió un panorama general y no una pregunta puntual.',
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
  {
    type: 'function',
    function: {
      name: 'controlar_volumen',
      description:
        'Propone poner el volumen de salida de la Mac de Joshua a un nivel específico. Como con enviar_email, esto ' +
        'NUNCA se ejecuta directo — se le muestra a Joshua en pantalla y solo corre si él lo confirma ahí. ' +
        'Después de invocarla, respondé solo algo breve como "te dejé la propuesta en pantalla, confirmá para aplicarla".',
      parameters: {
        type: 'object',
        properties: {
          nivel: { type: 'number', description: 'Nivel de volumen de 0 (mudo) a 100 (máximo)' },
        },
        required: ['nivel'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'controlar_brillo',
      description:
        'Propone subir o bajar el brillo de pantalla de la Mac de Joshua, simulando la tecla de brillo. Igual que ' +
        'enviar_email, NUNCA se ejecuta directo — se muestra en pantalla y solo corre si Joshua lo confirma ahí. ' +
        'Después de invocarla, respondé solo algo breve como "te dejé la propuesta en pantalla, confirmá para aplicarla".',
      parameters: {
        type: 'object',
        properties: {
          direccion: { type: 'string', description: 'Una de: subir, bajar' },
          pasos: { type: 'integer', description: 'Cuántos pasos de brillo (opcional, default 1)' },
        },
        required: ['direccion'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'abrir_app',
      description:
        'Propone abrir/activar una aplicación en la Mac de Joshua por nombre. Igual que enviar_email, NUNCA se ' +
        'ejecuta directo — se muestra en pantalla y solo corre si Joshua lo confirma ahí. ' +
        'Después de invocarla, respondé solo algo breve como "te dejé la propuesta en pantalla, confirmá para abrirla".',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: 'Nombre exacto de la aplicación, ej. "Spotify", "Visual Studio Code"' },
        },
        required: ['nombre'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cotizar_proyecto',
      description:
        'Arma una cotización lista para copiar y mandarle a un cliente de Jzet Labs, usando los precios que ya sabés ' +
        'por los hechos guardados. Usala cuando Joshua pida cotizar, armar un presupuesto, o preparar un mensaje de ' +
        'precio para un cliente. Si no sabés el precio de ese tipo específico de proyecto, decilo — nunca inventes un ' +
        'número. Después de invocarla, escribí vos la cotización en el chat en formato de mensaje/email, lista para copiar.',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', description: 'Tipo de proyecto, ej. "landing page", "sistema", "e-commerce"' },
          detalles: { type: 'string', description: 'Detalles del pedido del cliente (alcance, extras, plazos, lo que haya dicho)' },
        },
        required: ['tipo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'entregar_respuesta',
      description:
        'SIEMPRE terminá tu turno invocando esta tool — nunca respondas con texto plano suelto, ' +
        'incluso para un saludo simple. Te obliga a separar tu respuesta en dos versiones, porque el ' +
        'frontend lee una en voz alta y muestra la otra en pantalla, y no puede adivinar cuál es cuál. ' +
        'También es la que usás cuando NINGUNA otra tool aplica al pedido — por ejemplo, si te piden algo ' +
        'que ninguna tool de esta lista puede hacer, o una tool que existe pero no está disponible ahora ' +
        '(como las de control de Mac cuando no estás corriendo ahí). En esos casos, llamala directo, sin ' +
        'pasar antes por ninguna otra tool, y usá respuesta_corta para explicar en una frase por qué no se ' +
        'puede — nunca falles el turno intentando forzar una tool que no corresponde.',
      parameters: {
        type: 'object',
        properties: {
          respuesta_corta: {
            type: 'string',
            description:
              'Lo que se lee en voz alta con text-to-speech. 1-4 oraciones, lenguaje 100% hablado — ' +
              'CERO LaTeX, código, markdown, tablas o cualquier símbolo crudo (nada de "$", "**", "\\frac", ' +
              '"```", etc.). Si la respuesta involucra algo técnico, describilo en palabras acá ' +
              '("te dejé la fórmula en pantalla") y el detalle real va en desarrollo_completo.',
          },
          desarrollo_completo: {
            // "string" solo (con el campo fuera de required) no alcanza: el
            // modelo manda `null` explícito para "no aplica" en vez de
            // omitir la clave — confirmado en vivo, Groq lo rechaza con
            // "expected string, but got null" porque null no es un string
            // válido aunque el campo sea opcional. Aceptar null en el schema
            // también es más barato que perseguir que el modelo nunca lo
            // mande — ya perdimos esa apuesta una vez con la instrucción de
            // texto que decía lo mismo.
            type: ['string', 'null'],
            description:
              'Opcional — solo cuando hay contenido largo o técnico que vale la pena mostrar en pantalla ' +
              '(código, LaTeX, tablas, un desarrollo paso a paso). Puede tener markdown/LaTeX crudo, formato ' +
              'técnico, lo que haga falta. Si la respuesta ya es corta y no hay nada más que mostrar, omití ' +
              'esta clave o mandá null — nunca la repitas idéntica a respuesta_corta.',
          },
        },
        required: ['respuesta_corta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resumir_texto',
      description:
        'Resume un texto largo que Joshua pegó o que salió de otra tool (un archivo, una búsqueda, etc.), ajustando ' +
        'la profundidad según nivel. Usala para textos largos en vez de resumirlos vos directo en el chat — así el ' +
        'resumen sale de un paso dedicado y consistente.',
      parameters: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'El texto completo a resumir' },
          nivel: { type: 'string', description: 'Una de: simple (lenguaje llano, sin jerga), tecnico (mantiene vocabulario técnico preciso). Default: simple' },
        },
        required: ['texto'],
      },
    },
  },
];

export const TERMINAL_TOOLS = ALL_TOOLS.filter(t => t.function.name === 'guardar_hecho');

// controlar_volumen / controlar_brillo / abrir_app shell out to osascript,
// which only exists on macOS — on any other platform (e.g. Render, Linux)
// they can never work no matter what Joshua confirms, so they're filtered
// out of what's offered to the model entirely rather than being proposed
// and then failing. process.platform doesn't change at runtime, so this is
// computed once here instead of per-request.
export const DARWIN_ONLY_TOOLS = new Set(['controlar_volumen', 'controlar_brillo', 'abrir_app']);

export const AVAILABLE_TOOLS = process.platform === 'darwin'
  ? ALL_TOOLS
  : ALL_TOOLS.filter(t => !DARWIN_ONLY_TOOLS.has(t.function.name));

// Gemini's tool format isn't OpenAI-compatible (unlike Groq/Cerebras) — it
// wants { functionDeclarations: [{ name, description, parametersJsonSchema }] }
// instead of { type: 'function', function: { name, description, parameters } }.
// The one piece that DOES carry over as-is is `parameters` itself: it's
// already plain JSON Schema (lowercase "object"/"string", not the older
// Gemini-specific uppercase Type enum), and `parametersJsonSchema` accepts
// exactly that per @google/genai's FunctionDeclaration type — confirmed by
// generating real Gemini responses against this exact array (see
// createChatCompletionWithFallback in web/server.js). Built from
// AVAILABLE_TOOLS (not ALL_TOOLS) so the darwin-only filtering stays
// consistent between providers.
function toGeminiFunctionDeclarations(tools) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parametersJsonSchema: t.function.parameters,
  }));
}

// Gemini 3.x ("thinking") models attach a thoughtSignature to each
// functionCall Part and reject the next request with a 400 if a prior
// model-turn functionCall in history comes back without it — confirmed by
// actually hitting this live on turn 2 of a multi-hop tool loop (e.g.
// guardar_hecho followed by entregar_respuesta): "Function call is missing a
// thought_signature in functionCall parts". The signature lives on the Part
// itself, as a sibling of `functionCall` — NOT inside the FunctionCall
// object — so it doesn't survive the round trip through our OpenAI-shaped
// chatHistory (tc.function.{name,arguments}) unless carried separately. This
// map does that: adaptGeminiResponse fills it keyed by the synthesized
// tool_call id, convertMessagesToGemini reads it back when reconstructing
// that same call's functionCall Part for a later request.
//
// Known gap: this only covers calls that themselves came from Gemini. A call
// that came from Groq (no signature was ever issued for it) and then needs
// to be echoed back to Gemini on a later hop of the same turn — i.e. Groq
// succeeds once, then fails mid-turn — isn't handled; Gemini's docs don't
// document a workaround for a missing signature on an externally-sourced
// call. Not exercised by testing (Groq's quota exhaustion doesn't flip-flop
// within one conversation turn in practice), so left as a known limitation
// rather than guessed at.
const geminiThoughtSignatures = new Map();

// Converts our OpenAI-shaped messages array (system + chatHistory, same
// thing sent to Groq) into Gemini's { systemInstruction, contents } shape.
// Gemini has no "system" or "tool" role — system content is a separate
// config field, and both function calls and function results live as parts
// on 'model'/'user' turns respectively. OpenAI tool-result messages only
// carry tool_call_id, not the function name Gemini's FunctionResponse
// requires, so the preceding assistant tool_calls entries are scanned first
// to build an id → name lookup.
function convertMessagesToGemini(messages) {
  let systemInstruction;
  const toolNameById = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) toolNameById.set(tc.id, tc.function.name);
    }
  }

  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemInstruction = m.content;
    } else if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      if (m.tool_calls?.length) {
        contents.push({
          role: 'model',
          parts: m.tool_calls.map((tc) => {
            const thoughtSignature = geminiThoughtSignatures.get(tc.id);
            return {
              functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}') },
              ...(thoughtSignature ? { thoughtSignature } : {}),
            };
          }),
        });
      } else {
        contents.push({ role: 'model', parts: [{ text: m.content ?? '' }] });
      }
    } else if (m.role === 'tool') {
      const name = toolNameById.get(m.tool_call_id) ?? 'unknown_tool';
      let response;
      try { response = JSON.parse(m.content); } catch { response = { raw: m.content }; }
      const part = { functionResponse: { name, response } };
      // Gemini expects the N function results answering one model turn's N
      // function calls to land as N parts on a single 'user' Content, not N
      // separate turns — bundle onto the previous Content when it's already
      // an all-functionResponse 'user' turn instead of starting a new one.
      const last = contents[contents.length - 1];
      if (last?.role === 'user' && last.parts.every((p) => p.functionResponse)) {
        last.parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
    }
  }

  return { systemInstruction, contents };
}

function toGeminiToolChoiceMode(toolChoice) {
  if (toolChoice === 'required') return FunctionCallingConfigMode.ANY;
  if (toolChoice === 'none') return FunctionCallingConfigMode.NONE;
  return FunctionCallingConfigMode.AUTO;
}

// Mirrors groq-sdk's ChatCompletion shape ({ choices: [{ finish_reason,
// message: { content, tool_calls } }] }) so the exact same tool-dispatch
// loop in web/server.js (reading choice.finish_reason, tc.function.name,
// JSON.parse(tc.function.arguments), pushing choice.message straight into
// chatHistory) works unmodified regardless of which provider answered.
// Gemini's FunctionCall.args is already a parsed object (not a JSON string
// like OpenAI's tc.function.arguments), and fc.id is usually unset — Gemini
// only needs it back for NON_BLOCKING/streaming function calls, which this
// integration doesn't use — so a synthesized id is fine as long as it's
// unique within the turn, since that id only has to round-trip through our
// own chatHistory to pair a tool result back to its call.
//
// Reads response.candidates[0].content.parts directly instead of the
// response.functionCalls convenience getter — that getter only surfaces
// {id, name, args}, dropping the sibling thoughtSignature field each Part
// actually carries (see geminiThoughtSignatures above for why that matters).
function adaptGeminiResponse(response) {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const functionCallParts = parts.filter((p) => p.functionCall);

  if (functionCallParts.length) {
    return {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: functionCallParts.map((p, i) => {
            const id = p.functionCall.id ?? `gemini_${Date.now()}_${i}`;
            if (p.thoughtSignature) geminiThoughtSignatures.set(id, p.thoughtSignature);
            return {
              id,
              type: 'function',
              function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
            };
          }),
        },
      }],
    };
  }

  return {
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content: response.text ?? '' },
    }],
  };
}

// Wraps @google/genai's GoogleGenAI client to expose the same
// `.chat.completions.create(params)` shape the rest of the codebase already
// calls on the Groq client, so createChatCompletionWithRetry and
// createChatCompletionWithFallback in web/server.js work against either
// provider without branching on which one they're talking to.
export function createGeminiClient(apiKey) {
  const ai = new GoogleGenAI({ apiKey });

  return {
    chat: {
      completions: {
        async create(params) {
          const { systemInstruction, contents } = convertMessagesToGemini(params.messages);
          const functionDeclarations = toGeminiFunctionDeclarations(params.tools ?? []);

          let response;
          try {
            response = await ai.models.generateContent({
              model: params.model || GEMINI_MODEL,
              contents,
              config: {
                systemInstruction,
                ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
                toolConfig: {
                  functionCallingConfig: { mode: toGeminiToolChoiceMode(params.tool_choice) },
                },
              },
            });
          } catch (err) {
            // @google/genai's ApiError already carries .status and .message
            // directly on the Error (node_modules/@google/genai/dist/node/node.d.ts)
            // — no extra unwrapping needed for the err?.status / err?.message
            // checks in isQuotaExhaustedError/describeGroqError to work.
            throw err;
          }

          return adaptGeminiResponse(response);
        },
      },
    },
  };
}

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
