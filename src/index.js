import 'dotenv/config';
import readline from 'node:readline';
import Groq from 'groq-sdk';
import { getSystemPrompt, getRelevantFacts, saveFact, saveConversationSummary } from './memory.js';
import { MODEL, TERMINAL_TOOLS, buildSystemContent, summarizeConversation } from './groq-brain.js';

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

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const systemContent = buildSystemContent(systemPrompt, facts);
  const chatHistory = [];

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
      chatHistory.push({ role: 'user', content: message });

      let response = await groq.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'system', content: systemContent }, ...chatHistory],
        tools: TERMINAL_TOOLS,
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
            const ok = await saveFact(args.category, args.content);
            result = { success: ok };
            if (ok) console.log(`  (Coder guardó un hecho nuevo en "${args.category}")`);
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
          tools: TERMINAL_TOOLS,
          tool_choice: 'auto',
        });
        choice = response.choices[0];
      }

      const text = choice.message.content ?? '';
      chatHistory.push({ role: 'assistant', content: text });

      console.log(`\nCoder > ${text}\n`);

      transcript.push({ role: 'user', text: message });
      transcript.push({ role: 'model', text });
    } catch (err) {
      console.error('\nError hablando con Groq:', err.message, '\n');
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
