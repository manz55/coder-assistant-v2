import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export async function getSystemPrompt() {
  const { data, error } = await supabase
    .from('coder_config')
    .select('system_prompt')
    .eq('id', 1)
    .single();

  if (error) throw new Error(`Error al cargar system prompt: ${error.message}`);
  return data.system_prompt;
}

export async function getRelevantFacts(categories = null) {
  let query = supabase
    .from('coder_facts')
    .select('category, content');

  if (categories && categories.length > 0) {
    query = query.in('category', categories);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Error al cargar facts: ${error.message}`);
  return data;
}

export async function saveFact(category, content) {
  const { error } = await supabase
    .from('coder_facts')
    .insert({ category, content });

  if (error) throw new Error(`Error al guardar fact: ${error.message}`);
  return true;
}

export async function saveConversationSummary(summary, topics, startedAt) {
  const { error } = await supabase
    .from('coder_conversation_summaries')
    .insert({
      summary,
      topics,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
    });

  if (error) throw new Error(`Error al guardar resumen: ${error.message}`);
}
