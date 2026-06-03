# Деплой AffiliateOS Telegram Bot

## 1. Установить секреты (один раз)

```bash
cd telegram-bot

wrangler secret put TELEGRAM_TOKEN
# вставить: 8825294806:AAGMo0C0T8TkkFBI2GS_0eR5PF0vXQBGFyc

wrangler secret put MY_USER_ID
# вставить: 8403573669

wrangler secret put SUPABASE_URL
# вставить: https://lxsyrserfuighwxuymgb.supabase.co

wrangler secret put SUPABASE_KEY
# вставить: eyJhbGci... (service_role ключ)

wrangler secret put GROQ_API_KEY
# вставить: gsk_KuBNWdk3...

wrangler secret put AFFILIATEOS_URL
# вставить: https://claude.nikita1xbet35.workers.dev/
```

## 2. Задеплоить Worker

```bash
cd telegram-bot
wrangler deploy
```

После деплоя Wrangler выдаст URL вида:
`https://affiliateos-bot.<твой-subdomain>.workers.dev`

## 3. Установить Webhook

Подставь свой URL и выполни в браузере или curl:

```bash
curl "https://api.telegram.org/bot8825294806:AAGMo0C0T8TkkFBI2GS_0eR5PF0vXQBGFyc/setWebhook?url=https://affiliateos-bot.<subdomain>.workers.dev"
```

Ответ должен быть: `{"ok":true,"result":true}`

## 4. Проверить Webhook

```bash
curl "https://api.telegram.org/bot8825294806:AAGMo0C0T8TkkFBI2GS_0eR5PF0vXQBGFyc/getWebhookInfo"
```

## 5. Настроить меню бота (опционально)

В @BotFather → /mybots → твой бот → Edit Bot → Edit Commands:
```
start - Запустить бота
help - Справка по формату
```

## Обновление кода

```bash
cd telegram-bot
wrangler deploy
```

Webhook переустанавливать не нужно.
