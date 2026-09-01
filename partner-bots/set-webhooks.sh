#!/usr/bin/env bash
# Регистрирует вебхуки всех восьми ботов разом.
#
# Токены берутся из окружения и никогда не пишутся в файл — репозиторий
# публичный. Запуск:
#
#   export WORKER_URL="https://partner-bots.<subdomain>.workers.dev"
#   export BOT_WEBHOOK_SECRET="..."
#   export BOT_TOKEN_INDIA="..." BOT_TOKEN_AFRICA="..." ...
#   ./set-webhooks.sh
#
# Скрипт идемпотентен: setWebhook просто перезаписывает адрес, повторный запуск
# ничего не ломает.

set -euo pipefail

SLUGS=(india africa bangladesh worldwide afrique uzbekistan ru latam)

: "${WORKER_URL:?нужен WORKER_URL — адрес задеплоенного воркера}"
: "${BOT_WEBHOOK_SECRET:?нужен BOT_WEBHOOK_SECRET — тот же, что в секретах воркера}"

# Сначала проверяем, что заданы ВСЕ токены, и только потом что-то меняем:
# половина зарегистрированных ботов — состояние хуже, чем ноль, потому что
# непонятно, какая именно половина.
missing=()
for slug in "${SLUGS[@]}"; do
  var="BOT_TOKEN_$(echo "$slug" | tr '[:lower:]' '[:upper:]')"
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
if (( ${#missing[@]} )); then
  echo "не заданы токены: ${missing[*]}" >&2
  exit 1
fi

fail=0
for slug in "${SLUGS[@]}"; do
  var="BOT_TOKEN_$(echo "$slug" | tr '[:lower:]' '[:upper:]')"
  token="${!var}"
  url="${WORKER_URL%/}/bot/${slug}"

  # drop_pending_updates НЕ ставим.
  #
  # Он выбрасывает всё, что Telegram успел накопить, а этот скрипт запускается
  # на КАЖДОМ деплое. За сегодня их было больше десятка подряд — и любое
  # сообщение, пришедшее в те секунды, пока шла перерегистрация, молча
  # исчезало. Снаружи это выглядит ровно как «нажал /start, ничего не
  # произошло», причём воспроизводится через раз.
  #
  # Ответить на пару минут позже — не проблема. Потерять обращение человека,
  # который пришёл в бота, — проблема.
  response=$(curl -sS --max-time 20 \
    "https://api.telegram.org/bot${token}/setWebhook" \
    -d "url=${url}" \
    -d "secret_token=${BOT_WEBHOOK_SECRET}" \
    -d 'allowed_updates=["message","callback_query"]')

  if echo "$response" | grep -q '"ok":true'; then
    echo "  ok   ${slug} → ${url}"
  else
    echo "  FAIL ${slug}: ${response}" >&2
    fail=1
  fi
done

exit $fail
