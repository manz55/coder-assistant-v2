# Coder Assistant

Asistente personal tipo Jarvis con cerebro en Gemini y memoria persistente en Supabase.

## Instalación

```bash
npm install
```

## Configuración

1. Conseguí tu API key de Gemini en https://aistudio.google.com/apikey
2. Editá `.env` y reemplazá `pega_aqui_tu_api_key_de_gemini` con tu key real

## Uso

```bash
npm start
```

Escribí `salir` para terminar el chat.

## Tablas en Supabase

El proyecto espera estas tablas en tu proyecto de Supabase:

- `coder_config` — columnas: `id`, `system_prompt`
- `coder_facts` — columnas: `id`, `category`, `content`, `created_at`
- `coder_conversation_summaries` — columnas: `id`, `summary`, `topics`, `started_at`, `ended_at`

## Próximos pasos

- **Voz con Gemini Live API** — conversación por audio en tiempo real
- **Guardado automático de hechos** — detectar y persistir info relevante durante el chat
- **Resúmenes de conversación** — usar `saveConversationSummary()` al cerrar el chat
- **PWA para celular** — interfaz web progresiva para usarlo desde el teléfono
- **WhatsApp vía whatsapp-web.js** — chatear con el asistente desde WhatsApp
