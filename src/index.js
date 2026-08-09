import 'dotenv/config';
import readline from 'node:readline';
import { getSystemPrompt, getRelevantFacts, saveFact, saveConversationSummary } from './memory.js';
import { buildModel, summarizeConversation } from './gemini.js';

async function main() {
  console.log('Cargando a Coder...\n');

  const systemPrompt = await getSystemPrompt();
  const facts = await getRelevantFacts();

  if (!systemPrompt) {
    console.error(
      'No se pudo cargar la personalidad de Coder. Revisá tu SUPABASE_URL y SUPABASE_ANON_KEY en el .env'
    );
    process.exit(1);
  }

  const model = buildModel(systemPrompt, facts);
  const chat = model.startChat({ history: [] });

  const startedAt = new Date().toISOString();
  const transcript = [];

  console.log(`Coder está listo (${facts.length} hechos cargados). Escribí y presioná enter. Ctrl+C para salir.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'vos > ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const message = line.trim();
    if (!message) {
      rl.prompt();
      return;
    }

    try {
      let result = await chat.sendMessage(message);
      let calls = result.response.functionCalls();

      while (calls && calls.length > 0) {
        const responses = [];
        for (const call of calls) {
          if (call.name === 'guardar_hecho') {
            const { category, content } = call.args;
            const ok = await saveFact(category, content);
            responses.push({
              functionResponse: {
                name: call.name,
                response: { success: ok },
              },
            });
            if (ok) {
              console.log(`  (Coder guardó un hecho nuevo en "${category}")`);
            }
          }
        }
        result = await chat.sendMessage(responses);
        calls = result.response.functionCalls();
      }

      const text = result.response.text();
      console.log(`\nCoder > ${text}\n`);

      transcript.push({ role: 'user', text: message });
      transcript.push({ role: 'model', text });
    } catch (err) {
      console.error('\nError hablando con Gemini:', err.message, '\n');
    }

    rl.prompt();
  });

  async function shutdown() {
    if (transcript.length > 0) {
      console.log('\nCerrando... guardando un resumen de esta charla.');
      const summary = await summarizeConversation(transcript);
      if (summary) {
        await saveConversationSummary(summary.summary, summary.topics, startedAt);
      }
    }
    console.log('Nos vidrios, jefe.');
    process.exit(0);
  }

  rl.on('SIGINT', shutdown);
  rl.on('close', shutdown);
}

main();
