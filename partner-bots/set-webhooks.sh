#!/usr/bin/env bash
# Регистрирует вебхуки всех шести ботов разом.
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

SLUGS=(india africa bangladesh worldwide afrique uzbekistan)

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

  # drop_pending_updates: при перерегистрации в очереди могут висеть апдейты,
  # накопившиеся пока вебхук был сломан. Отвечать на позавчерашнее «/start»
  # никому не нужно.
  response=$(curl -sS --max-time 20 \
    "https://api.telegram.org/bot${token}/setWebhook" \
    -d "url=${url}" \
    -d "secret_token=${BOT_WEBHOOK_SECRET}" \
    -d "drop_pending_updates=true" \
    -d 'allowed_updates=["message","callback_query"]')

  if echo "$response" | grep -q '"ok":true'; then
    echo "  ok   ${slug} → ${url}"
  else
    echo "  FAIL ${slug}: ${response}" >&2
    fail=1
  fi
done

exit $fail
