# Telegram-боты партнёрской программы — развёртывание

Шесть ботов, один воркер, один код. Различия между ботами — строки в таблице
`bot_configs`, а не в коде.

---

## 0. Что уже сделано и что осталось

| Шаг | Состояние |
|---|---|
| Схема БД (`bot_configs`, `bot_leads`, `bot_user_prefs`, `bot_faq`) | ✅ миграция `048` |
| Воркер: роутинг, `/start`, меню, ссылка, FAQ, менеджер, `/lang`, реминдер | ✅ `worker.js` |
| Тесты (26 проверок) | ✅ `node partner-bots/test.mjs` |
| Адрес регистрации `https://1xaffiliate.org/newreg?ref={ref}` | ✅ миграция `049` |
| Автодеплой воркера | ✅ `.github/workflows/deploy-partner-bots.yml` |
| `setWebhook` на 6 ботов + проверка через `getWebhookInfo` | ✅ шаг того же воркфлоу |
| Ключ Cloudflare в секретах **GitHub** | ⛔ **нужен ты** — см. §1 |
| Токены ботов в секретах **GitHub** | ⛔ **нужен ты** — см. §1 |
| Тексты FAQ на EN/FR/UZ | ⛔ **нужен ты** — см. §5 |

Важно: секреты нужны именно в **GitHub**, а не в панели Cloudflare. Воркфлоу
сам зальёт их оттуда в нужный воркер. Токены, добавленные руками в Cloudflare
на воркер `claude` (дашборд), боту не помогут — он живёт в воркере
`partner-bots`, это разные наборы секретов.

Бот запускается и работает без FAQ: пока ответ пуст, он честно говорит, что
текст ещё не опубликован, и отдаёт контакт менеджера — вместо того чтобы
выдумывать условия выплат и статус лицензий.

---

## 1. Секреты

Есть два пути. **Первый предпочтительнее**: в панель Cloudflare заходить не
нужно совсем.

### Путь А — через GitHub (рекомендуется)

GitHub → Settings → **Secrets and variables → Actions** → New repository secret.

⚠️ На этой странице три вкладки: **Actions**, **Dependabot**, **Codespaces**.
Выглядят они одинаково, и у каждой свой раздел «Repository secrets». Воркфлоу
видит **только вкладку Actions** — секрет, заведённый на двух других, для него
не существует, и он честно скажет «не заданы секреты GitHub».

| Имя секрета | Что вставить |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → шаблон «Edit Cloudflare Workers» |
| `CLOUDFLARE_ACCOUNT_ID` | из адреса панели: `dash.cloudflare.com/<ЭТО_ОН>/workers` |
| `BOT_TOKEN_INDIA` | токен бота India из BotFather |
| `BOT_TOKEN_AFRICA` | токен бота Africa |
| `BOT_TOKEN_BANGLADESH` | токен бота Bangladesh |
| `BOT_TOKEN_WORLDWIDE` | токен бота Worldwide |
| `BOT_TOKEN_AFRIQUE` | токен бота Afrique |
| `BOT_TOKEN_UZBEKISTAN` | токен бота Uzbekistan |
| `BOT_WEBHOOK_SECRET` | любая длинная случайная строка, придумывается один раз |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → `service_role` |

`SUPABASE_URL` в списке нет: он не секрет (открыто лежит в `index.html`) и
объявлен обычной переменной в `wrangler.jsonc`.

Дальше воркфлоу `deploy-partner-bots.yml` сам зальёт их в Cloudflare как
Secret'ы и задеплоит воркер. Незаданные пропускаются с предупреждением.

### Путь Б — руками через wrangler

**Токены в репозиторий не кладутся** — он публичный.

```bash
cd partner-bots
wrangler secret put BOT_TOKEN_INDIA
wrangler secret put BOT_TOKEN_AFRICA
wrangler secret put BOT_TOKEN_BANGLADESH
wrangler secret put BOT_TOKEN_WORLDWIDE
wrangler secret put BOT_TOKEN_AFRIQUE
wrangler secret put BOT_TOKEN_UZBEKISTAN

# Придумай любую длинную случайную строку. Ей Telegram подписывает каждый
# вебхук, и она же проверяется воркером. Значение нужно будет ещё раз в §3.
wrangler secret put BOT_WEBHOOK_SECRET

# Те же значения, что у основного воркера.
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
```

Через панель Cloudflare — то же самое: Workers & Pages → `partner-bots` →
Settings → Variables and Secrets → **+ Add variable**, тип **Secret** (не Text:
Text показывает значение открытым текстом и, кроме того, стирается деплоем —
`keep_vars` в конфиге страхует от второго, но не от первого). После добавления
внизу экрана появится чёрная плашка «Unsaved changes» → синяя кнопка **Deploy**.

Токены из ТЗ уже засветились в переписке. После переноса в Secrets имеет смысл
прогнать `/revoke` в BotFather и заменить их новыми — риск невелик (максимум
угон бота под спам), но гигиена дешёвая.

---

## 2. Деплой воркера

```bash
cd partner-bots
wrangler deploy
```

Выдаст адрес вида `https://partner-bots.<subdomain>.workers.dev` — он нужен
в §3.

---

## 3. Регистрация вебхуков

**Делается автоматически** шагом «Зарегистрировать вебхуки» в том же воркфлоу,
сразу после деплоя, и там же проверяется запросом `getWebhookInfo` — то есть
сверяется не наш собственный ответ, а то, что реально запомнил Telegram.

Адрес воркера при этом вычитывается из вывода `wrangler`, а не собирается из
имени: поддомен `workers.dev` свой у каждого аккаунта, и угаданный адрес
выглядел бы правдоподобно при том, что все шесть вебхуков указывали бы в
никуда.

Ниже — ручной путь, на случай если понадобится сделать это вне CI.

```bash
export WORKER_URL="https://partner-bots.<subdomain>.workers.dev"
export BOT_WEBHOOK_SECRET="<та же строка, что в §1>"
export BOT_TOKEN_INDIA="..."   # и остальные пять
./set-webhooks.sh
```

Проверить один бот руками:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

В ответе должен быть твой URL и `"has_custom_certificate": false`. Если
`pending_update_count` растёт, а `last_error_message` не пуст — смотри, что
там написано.

**Без секрета роут отвечает 401 всем**, включая Telegram. Это сделано намеренно:
незащищённый вебхук принимает поддельные апдейты от любого, кто узнал адрес.

---

## 4. Ссылка на регистрацию — обязательный шаг

Главная функция бота не работает, пока не задан адрес формы. ТЗ §5 запрещает
выбирать его самостоятельно, поэтому поле оставлено пустым, а не заполнено
догадкой.

Когда адрес известен — один запрос в SQL Editor Supabase, **передеплой не
нужен**:

```sql
-- Один адрес на все боты
UPDATE public.bot_configs
   SET signup_url_tpl = 'https://ТВОЙ_ДОМЕН/ПУТЬ_К_ФОРМЕ?ref={ref}';

-- Или свой на каждое гео
UPDATE public.bot_configs
   SET signup_url_tpl = 'https://ТВОЙ_ДОМЕН/ПУТЬ?ref={ref}'
 WHERE slug = 'india';
```

`{ref}` подставляется автоматически и равен `tg_{slug}_{tg_user_id}` —
например `tg_india_483920117`. Если в 1xPartners параметр называется иначе
(`sub_id`, `refcode`, `p`), просто напиши его в шаблоне: строка целиком твоя.

---

## 5. Тексты FAQ

Кнопки уже засеяны на трёх языках, ответы пустые. Пока ответ пуст, бот говорит,
что текст ещё не опубликован, и отдаёт контакт менеджера — вместо того чтобы
выдумывать условия выплат и статус лицензий.

```sql
UPDATE public.bot_faq SET answer = 'Weekly payouts, no admin fee...'
 WHERE lang = 'en' AND key = 'payouts';
```

Ключи: `payouts`, `revshare`, `geo`, `license`. Языки: `en`, `fr`, `uz`.
Посмотреть, что осталось незаполненным:

```sql
SELECT lang, key FROM public.bot_faq WHERE answer = '' ORDER BY lang, sort_order;
```

---

## 6. Команды в BotFather

Для каждого бота: `/mybots` → бот → Edit Bot → Edit Commands:

```
start - Start / Restart
lang - Change language
```

---

## 7. Реминдер

Крон `0 9 * * *` — раз в сутки. Берёт тех, кто получил ссылку больше 6 дней
назад, ещё не получал напоминания и не писал менеджеру. Отправляет **один раз
за всё время** и больше к этой записи не возвращается.

Посмотреть, кому уйдёт в ближайший тик:

```sql
SELECT bot_slug, tg_user_id, tg_username, link_issued_at
  FROM public.bot_leads
 WHERE reminder_sent = false
   AND status = 'link_issued'
   AND link_issued_at < now() - interval '6 days';
```

---

## 8. Куда смотреть Нику

```sql
-- Сколько ссылок выдано по каждому боту
SELECT bot_slug, count(*) AS выдано,
       count(*) FILTER (WHERE status = 'contacted_manager') AS написали_менеджеру
  FROM public.bot_leads GROUP BY bot_slug ORDER BY выдано DESC;

-- Последние обращения
SELECT bot_slug, tg_username, lang, status, link_issued_at
  FROM public.bot_leads ORDER BY link_issued_at DESC LIMIT 50;
```

Таблица закрыта для anon-ключа: в ней telegram id живых людей, а anon-ключ
опубликован в `index.html`. Читать её можно из SQL Editor Supabase или из
дашборда под логином.

---

## Тесты

```bash
node partner-bots/test.mjs
```

Сеть подменяется целиком — ни Supabase, ни Telegram не дёргаются. Проверяется
поведение: отказ без секрета, языки по умолчанию, отсутствие дублей при
повторном нажатии, то что «Talk to Manager» не заводит лида, однократность
реминдера и то, что падение Supabase не заставляет Telegram молотить
повторами.
