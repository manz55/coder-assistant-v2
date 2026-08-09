import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL_NAME = 'gemini-3-flash-preview';

const CATEGORIAS_VALIDAS = [
  'perfil',
  'proyectos',
  'ventas_jzet_labs',
  'dev_preferences',
  'personal',
];

const tools = [
  {
    functionDeclarations: [
      {
        name: 'guardar_hecho',
        description:
          'Guarda un hecho nuevo y duradero sobre Joshua o sus proyectos, para recordarlo en futuras conversaciones. ' +
          'Usalo SOLO cuando Joshua comparta algo permanente que valga la pena recordar (una decisión, una preferencia, ' +
          'un dato de un proyecto, un cliente nuevo, etc.) — nunca para cosas triviales, temporales o hipotéticas.',
        parameters: {
          type: 'OBJECT',
          properties: {
            category: {
              type: 'STRING',
              description: `Una de: ${CATEGORIAS_VALIDAS.join(', ')}`,
            },
            content: {
              type: 'STRING',
              description: 'El hecho en texto plano, en español, redactado de forma clara y en tercera persona',
            },
          },
          required: ['category', 'content'],
        },
      },
    ],
  },
];

export function buildModel(systemPrompt, facts) {
  const factsText = facts
    .map((f) => `[${f.category}] ${f.content}`)
    .join('\n');

  const fullSystemInstruction = `${systemPrompt}

--- HECHOS QUE SABÉS SOBRE JOSHUA ---
${factsText}
--- FIN DE HECHOS ---`;

  return genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: fullSystemInstruction,
    tools,
  });
}

function buildPlainModel() {
  return genAI.getGenerativeModel({ model: MODEL_NAME });
}

export async function summarizeConversation(transcript) {
  if (transcript.length === 0) return null;

  const plain = buildPlainModel();
  const transcriptText = transcript
    .map((t) => `${t.role === 'user' ? 'Joshua' : 'Coder'}: ${t.text}`)
    .join('\n');

  const prompt = `Resumí la siguiente conversación entre Joshua y su asistente Coder en 2-3 oraciones,
y sacá una lista corta de temas (topics) tratados, en minúsculas y sin espacios (usá guiones si hace falta).

Conversación:
${transcriptText}

Respondé ÚNICAMENTE con JSON válido, sin backticks ni texto extra, con este formato exacto:
{"summary": "...", "topics": ["...", "..."]}`;

  try {
    const result = await plain.generateContent(prompt);
    const text = result.response.text().trim();
    const clean = text.replace(/^```json\s*|\s*```$/g, '');
    return JSON.parse(clean);
  } catch (err) {
    console.error('No se pudo generar el resumen:', err.message);
    return null;
  }
}
