# Деплой AffiliateOS Cloudflare Worker

## 1. Установить Wrangler

```bash
npm install -g wrangler
wrangler login
```

## 2. Установить Cloudflare Secrets (один раз)

Секреты нужно задать один раз, они сохраняются в аккаунте Cloudflare.

### Обязательные

**SUPABASE_JWT_SECRET** — HS256 ключ для подписи JWT токенов. Берётся из Supabase → Settings → API → Legacy JWT Secret.

```bash
wrangler secret put SUPABASE_JWT_SECRET
# Вставьте: 599A71F4-ECCE-49D6-8BB2-B23A483379FB
```

Это ключ позволяет Worker-у mint'ить JWT токены, которые Supabase проверяет по RLS политикам. Без этого дашборд загружается, но все таблицы остаются пустыми (RLS блокирует доступ).

### Опциональные

**DASHBOARD_PASSWORD** — пароль для входа на дашборд. Если не задан, дашборд открыт.

```bash
wrangler secret put DASHBOARD_PASSWORD
# Вставьте желаемый пароль
```

**SESSION_SECRET** — ключ для подписи session cookies. Если не задан, используется DASHBOARD_PASSWORD.

```bash
wrangler secret put SESSION_SECRET
# Вставьте секретное значение
```

## 3. Проверить переменные окружения

В `wrangler.jsonc` должны быть определены переменные окружения (они НЕ секреты):

```jsonc
{
  "env": {
    "production": {
      "vars": {
        "SUPABASE_URL": "https://lxsyrserfuighwxuymgb.supabase.co",
        "SUPABASE_ANON_KEY": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        "DASHBOARD_TITLE": "AffiliateOS"
      }
    }
  }
}
```

Если этих переменных нет, Worker использует встроенные значения по умолчанию (см. `worker.js`).

## 4. Задеплоить Worker

```bash
wrangler deploy
```

Wrangler выведет URL вида:
```
✅ Uploaded and published. See performance at https://dash.cloudflare.com/...
```

## 5. Проверить работу

1. Откройте URL Worker в браузере
2. Проверьте в браузере Developer Tools → Network:
   - `/db/rest/v1/...` запросы должны идти с заголовком `Authorization: Bearer ...`
   - Это значит, что JWT успешно выдан
3. Таблицы в дашборде должны загружаться (если они пусты по содержанию, это другая проблема)

Если таблицы остаются пустыми:
- Проверьте, что `SUPABASE_JWT_SECRET` задан корректно
- Откройте браузер DevTools → Console, ищите ошибки при загрузке таблиц
- Проверьте в Supabase логи, что запросы приходят с authenticated role

## 6. Изменения кода

После любых изменений `worker.js`:

```bash
wrangler deploy
```

Это всё. Дополнительно ничего не надо перезагружать.

## Что дальше?

- **Расписание**: триггеры cron-функций настраиваются в `triggers.crons` в `wrangler.jsonc`
- **Логирование**: Worker выводит логи в консоль, они видны в Cloudflare Dashboard → Workers & Pages → claude (ваш worker)
- **Мониторинг**: для production используйте Tail в Cloudflare Dashboard, чтобы видеть логи в реальном времени

```bash
wrangler tail
```

---

## Разрешение проблем

### JWT Secret неправильный
Ошибка: таблицы загружаются пустыми, в консоли нет ошибок.
- Проверьте точность ключа в Supabase Settings → API → Legacy JWT Secret
- Убедитесь, что скопировали без пробелов
- Переустановите секрет: `wrangler secret put SUPABASE_JWT_SECRET`

### Worker отвечает 500 ошибкой
- Проверьте логи: `wrangler tail`
- Обычно это означает, что SUPABASE_URL или SUPABASE_ANON_KEY некорректны

### CORS ошибка при загрузке таблиц
- Это ожидаемо в локальной разработке, но не в production
- Worker должен прокси-ировать запрос с правильными заголовками
- Проверьте, что `Authorization: Bearer ...` идёт в Supabase

### Дашборд просит пароль, но я его не устанавливал
- Пароль был задан ранее и сохранился в Cloudflare
- Либо переустановите `DASHBOARD_PASSWORD`, либо удалите секрет через Cloudflare Dashboard
