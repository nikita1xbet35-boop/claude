# Деплой AffiliateOS Telegram Bot

> ⚠️ **Токен этого бота был скомпрометирован.** До 07.09.2026 он лежал в этом
> файле открытым текстом, а репозиторий публичный. Токен остаётся в истории
> коммитов (`7baea5f` и далее) — удаление из файла историю не чистит, и
> переписывать её смысла нет: форки, зеркала и кэши уже разошлись.
>
> Единственное настоящее лечение — **отозвать токен в @BotFather** (`/revoke`)
> или удалить бота целиком (`/deletebot`), если он больше не нужен.
> Пока это не сделано, любой, кто видел репозиторий, может управлять ботом.
>
> Ни один токен, ключ или пароль в этот файл больше не вписывается. Значения
> живут только в Cloudflare Secrets.

## 1. Установить секреты (один раз)

Значения не хранятся в репозитории. `wrangler secret put` спросит их
интерактивно — вставлять из менеджера паролей, не из этого файла.

```bash
cd telegram-bot

wrangler secret put TELEGRAM_TOKEN
# <TOKEN_FROM_SECRETS> — новый токен из @BotFather после /revoke

wrangler secret put MY_USER_ID
# <ADMIN_USER_ID> — Telegram user_id единственного получателя (узнать: @userinfobot)

wrangler secret put SUPABASE_URL
# https://lxsyrserfuighwxuymgb.supabase.co — не секрет, открыто лежит в index.html

wrangler secret put SUPABASE_KEY
# <SERVICE_ROLE_KEY> — Supabase → Settings → API → service_role

wrangler secret put GROQ_API_KEY
# <GROQ_API_KEY> — console.groq.com → API Keys

wrangler secret put AFFILIATEOS_URL
# https://claude.nikita1xbet35.workers.dev/ — не секрет, публичный адрес дашборда
```

## 2. Задеплоить Worker

```bash
cd telegram-bot
wrangler deploy
```

После деплоя Wrangler выдаст URL вида:
`https://affiliateos-bot.<твой-subdomain>.workers.dev`

## 3. Установить Webhook

Токен подставляется из окружения, а не пишется в командную строку: команды с
секретом в аргументах оседают в истории оболочки и в логах CI.

```bash
export TELEGRAM_TOKEN="<токен из менеджера паролей>"
export WORKER_URL="https://affiliateos-bot.<subdomain>.workers.dev"

curl "https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook" \
  -d "url=${WORKER_URL}"
```

Ответ должен быть: `{"ok":true,"result":true}`

## 4. Проверить Webhook

```bash
curl "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo"
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
