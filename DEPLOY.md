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

> ⚠️ **Этот секрет был скомпрометирован.** До 07.09.2026 его значение стояло
> прямо в этом файле открытым текстом, а репозиторий публичный. Оно остаётся
> в истории коммитов (`3a131c0`) — удаление из файла историю не чистит.
>
> Это **самый опасный** из утекавших здесь секретов. Им подписываются JWT, и
> тот, у кого он есть, выпишет себе токен с ролью `service_role` и получит
> полный доступ ко всей базе в обход RLS: чтение, изменение и удаление любых
> данных. Ни ключ бота, ни ключ Groq такого не давали.
>
> **Нужно немедленно перевыпустить его**: Supabase → Settings → API → Legacy
> JWT Secret → Generate new secret. После этого положить новое значение в
> Cloudflare Secrets и в GitHub Actions (`SUPABASE_JWT_SECRET`), в репозиторий
> не возвращать. Перевыпуск инвалидирует старые токены — дашборд попросит
> войти заново, это ожидаемо.

```bash
wrangler secret put SUPABASE_JWT_SECRET
# <JWT_SECRET_FROM_SUPABASE> — вставлять из менеджера паролей, не отсюда
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

## 2a. Почты для рассылки

Отправители живут не в секретах воркера, а в пуле `smtp_accounts`: у каждого
свой дневной лимит, свой прогрев и своя привязка к бренду. Процедура добавления
почты — в [SENDERS.md](SENDERS.md).

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
