# AffiliateOS v2

## Stack
- Frontend: HTML/CSS/JS (vanilla, no frameworks)
- Backend: Supabase (PostgreSQL + Auth + Realtime)
- AI: Groq API (llama-3.3-70b)
- Search: SerpAPI
- Hosting: Netlify
- Telegram data: TGStat API

## Architecture
- Single-page app, module-based
- Each module = separate JS file loaded dynamically
- Modules: Dashboard, Lead Database, Outreach Desk, Search, Telegram Parser, Funnel Analytics

## Rules
- No frameworks, pure vanilla JS
- All API keys in Netlify env vars, never hardcode
- Supabase client initialized in supabase-config.js
- Russian comments in code are OK