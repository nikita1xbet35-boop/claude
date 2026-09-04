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

# Бот без токена ПРОПУСКАЕТСЯ, а не роняет весь скрипт.
#
# Раньше здесь было «или все, или ни одного»: рассуждение было в том, что
# половина зарегистрированных ботов — состояние хуже нуля, потому что непонятно,
# какая именно половина. Для первого запуска это верно, но флот перестал быть
# однородным: когда добавляются два новых бота, отсутствие их токенов лишало
# перерегистрации ШЕСТЬ уже работающих. Строгость била не по тому месту.
#
# Пропуск при этом громкий, а не молчаливый, и в конце печатается список — иначе
# «бот не отвечает» снова стало бы загадкой.
#
# Ноль заданных токенов — по-прежнему ошибка: это не «часть флота не заведена»,
# а «секреты не доехали вообще».
missing=()
present=()
for slug in "${SLUGS[@]}"; do
  var="BOT_TOKEN_$(echo "$slug" | tr '[:lower:]' '[:upper:]')"
  if [[ -n "${!var:-}" ]]; then present+=("$slug"); else missing+=("$var"); fi
done
if (( ${#present[@]} == 0 )); then
  echo "не задан НИ ОДИН токен бота — секреты не доехали до этого шага" >&2
  exit 1
fi

fail=0
for slug in "${present[@]}"; do
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

# Админ-бот регистрируется тем же способом, но отдельно от цикла: у него другой
# роут (/admin-bot, а не /bot/{slug}), он не входит во флот из восьми и его
# отсутствие не должно ни падать, ни считаться пропущенным ботом — партнёрские
# боты работают и без него.
if [[ -n "${ADMIN_BOT_TOKEN:-}" ]]; then
  admin_url="${WORKER_URL%/}/admin-bot"
  response=$(curl -sS --max-time 20 \
    "https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/setWebhook" \
    -d "url=${admin_url}" \
    -d "secret_token=${BOT_WEBHOOK_SECRET}" \
    -d 'allowed_updates=["message","callback_query"]')

  if echo "$response" | grep -q '"ok":true'; then
    echo "  ok   admin-bot → ${admin_url}"
  else
    echo "  FAIL admin-bot: ${response}" >&2
    fail=1
  fi
else
  echo "  ─    admin-bot: пропущен, нет ADMIN_BOT_TOKEN"
fi

if (( ${#missing[@]} )); then
  echo "пропущены (токен не задан): ${missing[*]}" >&2
fi

exit $fail
