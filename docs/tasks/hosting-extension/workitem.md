---
title: "Расширение хостинга для branch-protection"
slug: hosting-extension
description: "Делает L3 оси branch-protection известным: спрашивает хостинг вместо «неизвестно»"
status: in-progress
session-type: prd-prep
created: 2026-10-15
last-updated: 2026-10-20
---

# Расширение хостинга для branch-protection

> L3 оси `branch-protection` сегодня «неизвестно» у всех проектов, поэтому
> общий L3 не получит никто. Кристалл — про расширение, которое спрашивает
> хостинг. Начат 2026-10-15 по согласию владельца после того, как
> `vdx-dogfooding` уснул на общем L2.

## Назначение

Предикат `branch_requires_checks` (L3 оси `branch-protection`) всегда отвечает
«неизвестно»: знает о защите ветки только хостинг, а расширения для него нет
(DL #12 кристалла `vdm-gates-wiring-axis`). Неизвестное считается
невыполненным, и общий уровень любого проекта упирается в L2.

**Цель.** Расширение для GitHub: аудит спрашивает хостинг и отвечает «да» или
«нет» с причиной; где спросить нельзя (другой хостинг, нет сети, нет прав) —
«неизвестно» с названной причиной, как сейчас.

**Ограничения.** Комбайн, не монолит: авторизация и план хостинга — забота его
CLI (`gh`, `glab`), не vdx (DL #12 кристалла гейтов). Без сети аудит не
краснеет ложно — «неизвестно», не «нет».

**Критерий готовности.** На выпущенном CLI `vdx audit` репо на GitHub даёт
`branch-protection` L3 известным — выполнено или нет; у репо на другом
хостинге, без сети, без нужного токена — «неизвестно» с причиной.

## Текущая модель

**Выпущено в 0.29.0 (2026-10-15, `c16f56c`); критерий выполнен
(2026-10-18).** `cli/src/hosting.ts` и предикат `branch_requires_checks`;
18 тестов на записанных ответах. Аудит выпущенным 0.29.0
(`npx -p @vodmal/vdx-cli@0.29.0 vdx audit .`, lft, без токена, 2026-10-18):
у vdx ячейка `branch-protection` — `—` без `(L3 ?)`, то есть L3 известен и
«не выполнено» (`main` не защищён), общий L2; у telegram — `— (L3 ?)` и
«origin is on git.vorobyev.name — vdx reads GitHub only»; у vdx с
`VDX_OFFLINE=1` — `— (L3 ?)` и «VDX_OFFLINE is set — the hosting was not
asked». 0.30.0 (2026-10-18, m3) — тот же код (Sidetrack #6). Рабочим CLI
2026-10-15 — то же, у сета общий L0. Аудит vdx — 2,1 с против 0,9 с у
telegram: запросы к GitHub добавляют около секунды. В отчёте у «не
выполнено» причины нет — ось показывает `—` (DL #7).

Наблюдения 2026-10-15 (запросы и вывод — в DL #2):

- **GitHub отдаёт защиту публичного репо без токена.** `branches/<ветка>` —
  `protected` и `protection.required_status_checks.enforcement_level`
  (`off` / `non_admins` / `everyone`); `rules/branches/<ветка>` — правила
  рулсетов. Полная `branches/<ветка>/protection` — только с авторизацией.
  Приватный репо без токена — 404. Анонимный лимит — 60 запросов в час.
- **`gh` есть на m3, на lft нет.**
- **Хостинги проектов владельца** (реестр intercom, 29 записей):
  `git.vorobyev.name` — 9 (gitolite по ssh, HTTPS API нет), без remote — 8,
  `github.com` — 7, `gitlab.finam.ru` — 3, `git.finam.ru` — 2. Расширение для
  GitHub покрывает семь, и среди них vdx и сет.
- **Зеркала.** telegram принимает изменения в gitolite (`origin`), а CI идёт
  на приватном зеркале GitHub (`post-update` хук gitolite). Защита зеркала
  не охраняет ветку, в которую пушат.
- **vdx сам**: `main` на GitHub не защищён, рулсетов нет; push — прямо в
  `main`, выпуск тоже; гейт — локальный `pre-push`, обходимый `--no-verify`.
  С расширением у vdx будет L3 «не выполнено» вместо «неизвестно» — общий тот
  же L2. С защитой `main` и обязательной проверкой ось — L4 (L4 «не
  требуется»), и общий vdx — L4: остальные оси уже там.

**vdx под гейтом — набросок (2026-10-18, не решено; вопрос владельца
«Какой CI/CD тогда будет у нас тут?»):**

- **Что примет GitHub.** В защищённую ветку — коммит, у которого обязательные
  проверки прошли: «pushed to another branch and then merged» или «pushed
  directly to the protected branch» после них (docs GitHub «About protected
  branches», 2026-10-18; на vdx не проверено). Обход админов закрывает
  «Do not allow bypassing the above settings» (DL #3).
- **CI vdx сейчас.** `ci.yml` — `on: push: [main]` и `pull_request`;
  проверки — `cli (node 22)` и `cli (node 24)`; восемь последних прогонов —
  80–92 с (Actions API, 2026-10-18). Ветку, куда пушат до `main`, CI не видит.
- **Обычный коммит.** Push в служебную ветку (CI включить и на неё) →
  проверки этого SHA зелёные → push того же SHA в `main`: история линейная.
  Локальный `pre-push` на push в `main` повторяет то, что GitHub уже проверил;
  для `main` его пропускать, иначе ожидание удвоится. Ждать проверки на lft
  нечем (`gh` нет): команда vdx, спрашивающая проверки SHA через API, как
  `src/hosting.ts`, или `gh` на обеих станциях (nas-info). PR с auto-merge
  меняет SHA при слиянии и тоже требует `gh`.
- **Выпуск.** `vdx publish` пушит коммит версии в `main` после `npm publish`:
  под гейтом push откажет, и версия будет в npm без коммита в `main`.
  А — другой порядок: коммит версии через гейт → `npm publish` с OTP → тег.
  Б — публикует CI по тегу, trusted publishing npm: OIDC, npm ≥ 11.5.1,
  Node ≥ 22.14, `id-token: write`, настройка на npmjs.com, provenance сам
  (docs npm, 2026-10-18). У Б нет OTP: тег, запушенный агентом от имени
  владельца, публикует сам, если не поставить environment с ревьюером.
- **Порядок.** Сначала выпуск с новым потоком, пока `main` открыт, потом
  защита — иначе выпуск, который поток везёт, не запушится.

**vdx под гейтом с 2026-10-18.** Владелец включил классическую защиту `main`
через `gh` на m3; API (анонимно): `protected: true`, `enforcement_level:
everyone`, проверки `cli (node 22)` и `cli (node 24)`. `vdx push --dry-run` —
«through vdx-gate/main, then main once they pass»; аудит 0.31.0 — общий L4,
`branch-protection` L3, aligned. Первый живой `vdx push` (0.31.0, `106da5f`,
2026-10-18) положил коммит в `vdx-gate/main` и остановился на первом же
вопросе через 15 с: `check-runs` ответил 422 «No commit found for SHA» — сразу
после push в новую ветку GitHub ещё не показывал коммит; через минуту — 200 и
обе проверки `in_progress`. `main` не тронут, как и задумано. Исправление: 422
«No commit found» — проверка ещё не видна, ожидание идёт дальше (тест на
записанной последовательности); выйдет патчем. Повтор `vdx push` (0.31.0) —
коммит был уже виден: `main` взял `106da5f` после обеих зелёных проверок
(2026-10-19). У коммита — два прогона CI: на `vdx-gate/main` и снова на push
в `main` (`ci.yml` идёт и на `main`). Второй живой push (`72629ee`, 0.31.0)
остановился так же, хотя `vdx-gate/main` уже был: 422 через 15 с. Чем это
вызвано — задержкой GitHub или кешем ответа на вопрос, заданный до push, — не
установлено: у ответа 200 — `cache-control: public, max-age=60`, у 422 этого
заголовка нет. Поэтому ещё и: до push vdx спрашивает проверки, только если
`vdx-gate/<ветка>` уже на этом коммите (второй `vdx push`), — запрос, на
который GitHub ответил бы 422, не тратится из 60 в час. Выпуск 0.32.0 (lft,
2026-10-20) остановился в ожидании: один запрос не уложился в 10 с — дочерний
node получил `ETIMEDOUT` при нагрузке ~7, и vdx принял «нет ответа» за отказ;
пакет был в npm, коммит выпуска и тег — здесь, `vdx-gate/main` — на коммите с
зелёными проверками. Исправление: «нет ответа» в ожидании — спросить снова до
конца срока (отказ с кодом — по-прежнему остановка); запросу — 15 с, процессу —
20 с. Третий живой push
(`b275af3`, 0.31.0, 2026-10-19) — то же: 422 через 15 с; повтор `vdx push`
дождался обеих проверок (48 с) и довёл коммит до `main`.

**Выпущено в 0.31.0 (2026-10-18, `464d991`; решение — DL #8–#10).** На m3 и lft — 0.31.0 (`npm update -g`); `vdx push
--dry-run` там — «git push — origin/main requires no checks». `gh` на m3 не
залогинен (`gh auth status`, 2026-10-18): там `vdx push` спрашивает GitHub без
токена, как на lft. В коде:
`src/gate.ts` и `vdx push`; `vdx publish` пушит коммит выпуска через
проверки после `npm publish` (DL #9); `ci.yml` — и на `vdx-gate/**`; хук
`pre-push` уступает CI по `VDX_GATE_PUSH=1`. 444 юнит и 4 e2e, `check`
чистый. Живой прогон рабочим CLI (`--dry-run`, lft, без токена): vdx —
«git push — origin/main requires no checks»; telegram — «origin is on
git.vorobyev.name»; клон с `origin` на `microsoft/vscode` — 29 обязательных
проверок `main`. Проверки коммита `85dfd66` — обе `success` со ссылками;
несуществующий SHA — 422, «неизвестно». Попутно: распознаватель хуков
(`unsetGatingVars`, `src/hooks.ts`) считал `if [ -n "$VDX_GATE_PUSH" ]; then …
exit 0` гейтом, который без переменной ничего не делает, и ставил
`git-hygiene` ⚑; теперь блок, который только сообщает и выходит с 0, —
выход из хука, не гейт.

Решено (2026-10-15): L3 — проверка, обязательная для всех (DL #3); HTTPS
API, `gh` — только источник токена (DL #4); хостинг — `origin`, ветка — по
умолчанию (DL #5); запрос — дочерний процесс node, аудит синхронный,
`VDX_OFFLINE` (DL #6).

## Decision Log

### #1 / 2026-10-15 / Следующая работа после dogfooding — расширение хостинга

**Source:** both
**Basis:** user-stated
**Basis-detail:** на предложение «расширение хостинга для `branch-protection`
… заведу кристалл и начну с решений» владелец ответил «Да согласен давай»
(2026-10-15). Направление — его же из DL #12 кристалла гейтов: «потом
поддерживать расширения под разные git SaaS… GitHub проверять — зависимость
от gh CLI… Ну или gitlab».
**Context:** `vdx-dogfooding` достиг цели и уснул (общий L2, оси, кроме
`branch-protection`, — L4). Альтернатива — поднимать сами проекты (mediko и
echelon на L0) — работа их агентов, не vdx.
**Why:** потолок L2 — один на все проекты, и держит его только эта ось.
**Implication:** этот кристалл; первым — GitHub (DL #12 кристалла гейтов),
GitLab и gitolite — побеги.

### #2 / 2026-10-15 / Что хостинги отдают — замер

**Source:** assistant
**Basis:** observed
**Basis-detail:** запросы с lft 2026-10-15, вывод пересказан целиком (ответы
короткие; ссылки — публичное API, повторяется теми же `curl`):
- `GET https://api.github.com/repos/VoDmAl/vdx/branches/main` → 200,
  `{"protected":false,"protection":{"enabled":false,"required_status_checks":
  {"enforcement_level":"off","contexts":[],"checks":[]}}}`;
- `GET …/VoDmAl/vdx/rules/branches/main` → 200, `[]`;
- `GET …/VoDmAl/vdx/branches/main/protection` → 401 «Requires authentication»;
- `GET …/repos/FriendsOfVoDmAl/telegram.vorobyev.name` (зеркало telegram) →
  404 без токена;
- `GET https://api.github.com/rate_limit` → `x-ratelimit-limit: 60`;
- `command -v gh`: lft — нет, m3 — `/opt/homebrew/bin/gh`;
- `https://git.vorobyev.name/api/v1/version` и `/api/v4/version` — нет
  соединения; `gitolite-admin/conf/gitolite.conf`: у `echelon` и
  `telegram.vorobyev.name` — `RW+ = vdm`, у telegram
  `option hook.post-update = github-mirror-organization`;
- хостинги — `remote` из `~/.claude/vdm/intercom/_registry/*.json`, 29
  записей; remote есть у 21.

Не проверено: что `rules/branches` отдаёт анонимно для рулсета с обязательной
проверкой (у vdx рулсетов нет), и видны ли в нём bypass-акторы.
**Context:** до решений о механизме — что вообще можно узнать и без чего.
**Why:** развилка «`gh` обязателен или нет» стоит на том, читается ли защита
без токена; читается — для публичных репо.
**Implication:** токен нужен только приватным репо и для лимита; ответ
`enforcement_level` уже различает обход для админов (развилка 1).

### #3 / 2026-10-15 / L3 — только проверка, обязательная для всех

**Source:** both
**Basis:** user-stated
**Basis-detail:** вопрос «Когда засчитывать L3 у `branch-protection`, если в
настройках защиты админам разрешён обход…? Агент пушит от вашего имени, а вы
админ, так что при обходе гейт его не остановит» — владелец выбрал «Только
everyone (Recommended)» (2026-10-15). Все три значения
`enforcement_level` встречаются у публичных репо: `cli/cli` — `non_admins`,
`microsoft/vscode` — `everyone`, `nodejs/node` — `off` (запрос 2026-10-15).
**Context:** у классической защиты GitHub обязательная проверка бывает для
всех или для всех, кроме админов; у рулсета — со списком тех, кто обходит.
**Why:** ось существует, чтобы сломанное не попало в `main`. Агент работает
от имени владельца, а владелец — админ своих репо: при обходе для админов
именно агент гейта не встречает.
**Implication:** классическая защита — `enforcement_level: everyone` и хотя
бы одна проверка. Рулсет — правило `required_status_checks` хотя бы с одной
проверкой и пустой `bypass_actors`; без токена список обхода не виден (DL #6)
— тогда «неизвестно».

### #4 / 2026-10-15 / GitHub — HTTPS API, `gh` только как источник токена

**Source:** both
**Basis:** user-stated
**Basis-detail:** вопрос «Как расширение ходит в GitHub?» — владелец выбрал
«API, gh по желанию (Recommended)» (2026-10-15). Анонимные ответы для
публичных репо — DL #2.
**Context:** DL #12 кристалла гейтов предполагал зависимость от `gh`. Замер
показал, что публичному репо токен не нужен, а `gh` на lft нет.
**Why:** без `gh` работают публичные репо и машины, где его нет. Авторизация
остаётся заботой `gh`: vdx только берёт его токен. Порядок — `GH_TOKEN`,
`GITHUB_TOKEN`, `gh auth token`, без токена: так же выбирает сам `gh`, а в CI
есть `GITHUB_TOKEN`.
**Implication:** токен — дочернему процессу через переменную окружения, не
аргументом (аргументы видны в `ps`). 401, 403, 404 и отсутствие сети —
«неизвестно» с причиной; у 404 без токена причина называет `gh auth login`
и `GH_TOKEN`.

### #5 / 2026-10-15 / Хостинг оси — `origin`, ветка — ветка по умолчанию

**Source:** assistant
**Basis:** assumed
**Basis-detail:** развилка 3 — по умолчанию, владелец о ней знает (Next
actions 2026-10-15) и не возражал; не обсуждалось подробно. Не проверено,
есть ли у проектов владельца репо, где `origin` — не хостинг, принимающий
изменения.
**Context:** у репо бывает несколько remote; telegram пушит в gitolite
(`origin`), а GitHub — зеркало для CI (Sidetrack #3).
**Why:** `origin` — туда пушат, его защита и держит ветку. Ветку берём у
хостинга (`default_branch`) или из `refs/remotes/origin/HEAD`, если клон её
знает, — не `main` вслепую: у `cli/cli` — `trunk`, у telegram — `master`.
**Implication:** `origin` не на GitHub — «неизвестно: origin на <хост>»;
`origin` нет — «неизвестно: нет origin».

### #6 / 2026-10-15 / Запрос — дочерний процесс node, аудит остаётся синхронным

**Source:** assistant
**Basis:** inferred
**Basis-detail:** из кода: `audit()` синхронен, его зовут `cmdAudit`,
`cmdPublish` (`src/index.ts`) и `buildAuditPayload` (`src/mcp-server.ts`);
предикаты синхронны (`src/predicates.ts`); сеть из синхронного кода vdx уже
ходит дочерним процессом (`npm view` в `src/doctor.ts`). Анонимный GET
рулсета (`microsoft/vscode`, 7988222) не отдаёт `bypass_actors` и
`current_user_can_bypass` — наблюдение; что они видны с токеном админа — по
документации, не проверено.
**Context:** `fetch` в Node асинхронный, а цепочка аудита — нет.
**Why:** `execFileSync(process.execPath, ['--input-type=module', '-e', …])`
с таймаутом — тот же приём, что `npm view`, и ни одна сигнатура не меняется.
Отвергнуто: асинхронный аудит — три вызывающих и тесты ради одного предиката;
`curl` — ещё одна зависимость, которой на машине может не быть.
**Implication:** модуль `src/hosting.ts`; предикат зовёт его один раз за
аудит (кеш контекста). `VDX_OFFLINE=1` — хостинг не спрашивать, ось —
«неизвестно»; тесты ставят его в конфиге vitest: фикстуры лежат внутри репо
vdx, и `git remote` у них — `origin` vdx.

### #7 / 2026-10-15 / «Не выполнено» — без причины в отчёте, пока

**Source:** assistant
**Basis:** observed
**Basis-detail:** отчёт рабочего CLI по vdx 2026-10-15: строка
`branch-protection` — `| — | L4 | ⚠️ gap |`; раздел «Not checked» ось больше не
называет. У предиката тип ответа `boolean | Unknown` (`src/predicates.ts`):
причина есть только у «неизвестно».
**Context:** критерий готовности сначала требовал причину и у «нет»
(«админы обходят», «проверка не обязательна»). Для этого нужен ответ «нет с
причиной» во всём конвейере — оценщик, оценка оси, отчёт, JSON.
**Why:** без него ось уже честнее, чем было: «нет» вместо «неизвестно».
Причина у «нет» нужна не одной этой оси, и это отдельное изменение формата.
**Implication:** критерий готовности — L3 известен (да или нет); причина
«нет» — Sidetrack #4.

### #8 / 2026-10-18 / vdx живёт под гейтом: выпуск из терминала, ожидание CI — команда vdx

**Source:** both
**Basis:** user-stated
**Basis-detail:** на набросок «vdx под гейтом» («Текущая модель») и вопрос
«Если согласны на вариант А и команду для ожидания CI, начну с них. Защиту
`main` включите, когда новый поток выйдет» владелец ответил «Да, согласен на
предложение. Давай так.» (2026-10-18). Его вопрос перед этим — «Какой CI/CD
тогда будет у нас тут?».
**Context:** защита `main` с обязательной проверкой — единственное, что
поднимает vdx с общего L2 до L4; прямой push в `main` и выпуск она ломает.
Варианты выпуска — А (из терминала, OTP владельца) и Б (CI по тегу, trusted
publishing npm).
**Why:** у А подтверждение выпуска остаётся человеческим (OTP), а меняется
только `vdx publish`; у Б тег, запушенный агентом от имени владельца,
публикует сам. Ожидание CI — команда vdx: `gh` на lft нет, и тот же шаг
нужен выпуску.
**Implication:** команда `vdx push`, выпуск через гейт, CI на служебной
ветке, хук `pre-push` уступает CI; выпуск с ними — до защиты `main`
(DL #9, #10).

### #9 / 2026-10-18 / Под гейтом `npm publish` — до push коммита версии, как сейчас

**Source:** assistant
**Basis:** inferred
**Basis-detail:** из кода `executePublish` (`src/publish.ts`): Ctrl-C или
ошибка `npm publish` возвращают версию в файлах, и коммита нет — порядок
«npm первым» выбран ради этого. Набросок (DL #8) называл другой порядок:
«коммит версии через гейт → `npm publish` с OTP → тег». Не проверено на
живом выпуске под гейтом — его ещё не было.
**Context:** под гейтом коммит версии ждёт CI около полутора минут. Если он
идёт до `npm publish`, Ctrl-C на OTP оставляет в `main` версию, которой нет
в npm, и следующий `vdx publish` поднял бы её ещё раз.
**Why:** с `npm publish` первым откат при отказе остаётся тем же, что есть,
а OTP спрашивается сразу, без ожидания CI. В npm уходит то, что уже в
`main` и зелёное, плюс номер версии: под гейтом pre-flight отказывает, если
есть коммиты, которых нет в `main` (CI их не видел).
**Implication:** порядок: bump → `npm publish` → коммит и тег → коммит
через гейт → push тега → ожидание реестра. Красный CI на коммите версии
после `npm publish` — то же частичное состояние, что сейчас при отказе push:
пакет в npm, коммит и тег здесь, команда названа. Отклонение от наброска —
владельцу в отчёте.

### #10 / 2026-10-18 / `vdx push`: служебная ветка `vdx-gate/<ветка>`, проверки — у хостинга

**Source:** assistant
**Basis:** inferred
**Basis-detail:** по документации GitHub: коммит в защищённую ветку — после
того как его обязательные проверки прошли на другой ветке (набросок,
«Текущая модель»). Проверки коммита анонимно отдаёт
`GET /repos/{o}/{r}/commits/{sha}/check-runs` — у `1af1102` две, `cli (node
22)` и `cli (node 24)` (запрос 2026-10-18). Обязательные проверки ветки —
те же ответы `branches/<ветка>` и `rules/branches/<ветка>`, что читает
предикат (DL #2). Не проверено на защищённой ветке: у vdx её ещё нет.
**Context:** чем ждать CI и куда пушить до `main`.
**Why:** список проверок vdx берёт у хостинга, а не из своего конфига: это
и есть то, что GitHub потребует. Обязательных проверок нет, origin не на
GitHub, хостинг не ответил — обычный `git push`, поэтому `vdx push` можно
звать и до защиты. Служебная ветка — одна на ветку, перезаписывается
(`--force`); коммит, у которого проверки уже зелёные, идёт в `main` сразу.
Хук `pre-push` пропускает прогон по `VDX_GATE_PUSH=1`, который ставит
`vdx push`: CI делает то же, а ожидание удвоилось бы.
**Implication:** `ci.yml` — `push` и на `vdx-gate/**`; опрос проверок раз в
15 с, до 20 мин; красная проверка — отказ со ссылкой, `main` не тронут.
Без токена — около десяти запросов на push из 60 в час.

### #11 / 2026-10-19 / «Нет» с причиной — третья форма ответа предиката, `{ no }`

**Source:** assistant
**Basis:** inferred
**Basis-detail:** из кода: `Verdict = boolean | Unknown` (`src/predicates.ts`),
оценщик (`src/evaluator.ts`) и уровень оси (`src/scoring.ts`) несут причину
только у «неизвестно», отчёт (`src/report.ts`) печатает её в «Not checked».
Владелец сказал «Дальше» на предложение взять Sidetrack #4 следующим
(2026-10-19). Не проверено: читают ли поле `per_axis` чужие потребители JSON
(MCP-клиенты) строго — поле добавляется, не меняется.
**Context:** у `branch-protection` «не выполнено» показывалось `—` и `gap` без
слова о том, что не так: ветка не защищена, админы обходят, проверка не
названа, рулсет обходят (Sidetrack #4).
**Why:** наименьшее изменение — предикат, который знает причину, отвечает
`{ no: "<почему>" }`; везде, где ответ двузначный, это «нет», в комбинаторах —
то же, что `false`. Предикаты, которым сказать нечего, остаются `boolean` и не
меняются. Отвергнуто: причина у каждого предиката — двадцать текстов там, где
причину и так видно из требования уровня в сете.
**Implication:** у оси — `not_met: { level, reason }` рядом с `unknown`, в
отчёте — раздел «Not met»; `hosting.ts` называет причины. `rubric-format.md`,
`architecture.md`.

### #12 / 2026-10-20 / GitLab — да, gitolite — отложить; `git.finam.ru` — Bitbucket

**Source:** both
**Basis:** user-stated
**Basis-detail:** на вопрос «Что делаем с хостингами, кроме GitHub, для оси
branch-protection?» владелец выбрал «GitLab сделать, gitolite отложить
(Recommended)» (2026-10-20). Вопрос опирался на мои слова «GitLab — 5 рабочих
проектов (gitlab.finam.ru, git.finam.ru)», а это было неверно — наблюдение
после ответа: `https://git.finam.ru/rest/api/1.0/application-properties` —
`{"version":"5.16.1",…,"displayName":"Bitbucket"}`, ssh на 7999; GitLab —
только `gitlab.finam.ru` (`/api/v4/version` → 401, с токеном — 18.11.12-ee).
Реестр intercom: на `gitlab.finam.ru` — limeflow, ga-developer-portal,
showcase; на `git.finam.ru` — global-auth, kratos, tx-auth-widget.
**Context:** после GitHub ось `branch-protection` у рабочих проектов —
«неизвестно».
**Why:** у GitLab есть API и защищённые ветки, `glab` залогинен на
`gitlab.finam.ru` (`glab auth status`); у gitolite API нет, обязательных
проверок он сам не делает (Sidetrack #1).
**Implication:** L3 на GitLab — по DL #3: в ветку по умолчанию никто не пушит
напрямую (`push_access_levels` — только «No one»), и MR — только с успешным
пайплайном (`only_allow_merge_if_pipeline_succeeds`). GitLab узнаётся по имени
хоста, по `GITLAB_HOST` или по токену `glab` для него; токен — `glab config get
token --host` или `GITLAB_TOKEN`, только если хост — `GITLAB_HOST` (`gitlab.com`
по умолчанию, как у `glab`). Первый вариант слал `GITLAB_TOKEN` любому хосту
кроме GitHub — автоматическая проверка безопасности (2026-10-20): `origin`
называет репо, и склонированный чужой репо получил бы токен. Bitbucket Server —
новый Sidetrack #10, вопрос владельцу.

## Sidetracks

### #1. gitolite (`git.vorobyev.name`) — девять проектов владельца

**Возникло в:** DL #2
**Описание:** API у gitolite нет; права видны в `gitolite-admin`
(`RW+` — force-push), хуки на сервере — нет. Обязательной проверки gitolite
не делает, если её не поставил хук. Пока — «неизвестно: gitolite»; честное
«нет» потребует решить, откуда vdx знает про хуки.

**Status:** deferred — 2026-10-20, владелец (DL #12): «неизвестно: origin is on git.vorobyev.name» остаётся

### #2. GitLab (`gitlab.finam.ru`) — рабочие проекты

**Возникло в:** DL #2
**Описание:** пять проектов, среди них limeflow. Нужен токен (`glab` или
`GITLAB_TOKEN`); защита ветки — `protected_branches`, обязательная проверка —
«Pipelines must succeed» у MR. Второе расширение, после GitHub. (Поправка
2026-10-20: на GitLab — три, `git.finam.ru` — Bitbucket, DL #12.)

**Status:** resolved — 2026-10-20: `judgeGitlab` в `src/hosting.ts` (DL #12).
Живой прогон рабочим CLI: limeflow — «main takes direct pushes from
Maintainers — a push skips the pipeline»; ga-developer-portal и showcase — то
же и «merge requests into … do not need a passing pipeline» (у showcase — и
Instance admins, ветка `master`). Выйдет в 0.33

### #3. Зеркало: CI на GitHub, изменения принимает другой хостинг

**Возникло в:** Текущая модель
**Описание:** telegram — `origin` в gitolite, CI на зеркале GitHub. Хостингом
оси считается `origin` (развилка 3): у telegram — «неизвестно: gitolite»,
даже если зеркало защищено.

**Status:** resolved — 2026-10-15, DL #5

### #4. Причина у «не выполнено» в отчёте

**Возникло в:** DL #7
**Описание:** ось показывает `—` и `gap`, не говоря, что именно не так:
защиты нет, проверка не обязательна, админы обходят. Нужен ответ предиката
«нет с причиной» и место для него в отчёте; пригодится и другим осям.

**Status:** resolved — 2026-10-19, DL #11: `{ no: "<почему>" }`, `not_met`
у оси, раздел «Not met». Живой прогон рабочим CLI: `vdx-rubric-vodmal` — «main
is not protected, and no ruleset requires checks». Выйдет в 0.32

### #5. Комментарий оси в сете — «пока расширения для него нет»

**Возникло в:** Текущая модель
**Описание:** в `vdx-rubric-vodmal/vdx-rubric.yaml` у `branch-protection`
комментарий «Знает о защите только хостинг: пока расширения для него нет, L3
— «неизвестно» у всех». С 0.29 это не так для GitHub. Правка canonical-файла
— тег сета (patch); вместе со следующим выпуском сета.

**Status:** open

### #6. `vdx publish` не замечает выпуск без изменений

**Возникло в:** выпуск 0.30.0 (2026-10-18)
**Описание:** 0.29.0 вышел 2026-10-15; 2026-10-18 `vdx publish minor` ещё
раз запустили на m3, и вышел 0.30.0 — между `v0.29.0` и `v0.30.0` только
коммит выпуска (`git log v0.29.0..9bd6e5e`). Pre-flight проверяет чистое
дерево, версию в реестре и отставание от upstream, но не то, что с
последнего тега нечего выпускать. Вариант — вопрос в терминале с безопасным
Enter («с v0.29.0 нет коммитов — выпустить всё равно? [y/N]»), без
терминала — отказ. Попутно: реестр показал 0.30.0 примерно через 6 мин после
`npm publish` (опрос `npm view` с lft), а `vdx publish` ждёт 3 — по коду он
написал «not visible»; вывода на m3 не видно.

**Status:** resolved — 2026-10-19: проверка `changes-since-release`
(`checkChangesSinceRelease`, `src/publish.ts`): ни одного коммита в каталоге
пакета с тега текущей версии — в терминале вопрос «Release … anyway, the same
package under a new number? [y/N]», Enter ничего не выпускает; без терминала —
отказ, `--force` обходит. Живой `--dry-run`: «OK (1 commit(s) in cli/ since
v0.31.2)». Выйдет со следующим выпуском

### #7. `vdx doctor` — есть ли у vdx токен GitHub

**Возникло в:** вход в `gh` на m3 перед защитой `main` (2026-10-18)
**Описание:** владелец: «это тогда можно сделать частью doctor». В проекте с
`origin` на GitHub doctor говорит, чем vdx спросит GitHub (`GH_TOKEN`,
`GITHUB_TOKEN`, `gh auth token`) и что делать без токена: `gh` нет — nas-info,
вход недействителен — `gh auth login`. Без токена — 60 запросов в час на аудит
и `vdx push`.

**Status:** resolved — 2026-10-19: строка `GitHub token` в `vdx doctor`
(`checkGithubToken`, `src/doctor.ts`): источник токена, `/rate_limit` — лимит
и остаток или 401; без токена — `gh auth login`, без gh — установить его; по
ssh на macOS — что gh не видит keychain. Живой прогон: lft — «from gh: 5000
requests an hour»; m3 по ssh — «none» и подсказка про keychain

### #8. `gh` из ssh-сессии на m3 не видит токен

**Возникло в:** защита `main` через `gh` на m3 (2026-10-18)
**Описание:** владелец вошёл в `gh` в своём терминале на m3 («✓ Logged in as
VoDmAl»), а `ssh m3 gh auth status` пишет «The token in default is invalid»,
и `gh api` отвечает 401. Похоже, ssh-сессии не виден keychain, где `gh` держит
токен (не проверено). Тогда агенты, которых `vdx ai@m3` запускает через ssh,
без токена. Передано nas-info в брифе `gh-on-lft`.

**Status:** resolved — 2026-10-19, ответ nas-info (`gh-on-lft-outcome`):
keychain macOS открыт процессам графической сессии, сервер tmux поднят при
входе — агенты `vdx ai@m3` в tmux токен получают, голый `ssh m3 gh` — нет.
Проверено: `ssh m3 "tmux run-shell 'gh auth status'"` — «✓ Logged in …
(keyring)»

### #9. Registry показал 0.31.2 позже, чем `vdx publish` ждёт

**Возникло в:** выпуск 0.31.2 (2026-10-19, `1e2dbe6`, с lft)
**Описание:** `npm publish` прошёл в 19:02:49 UTC, гейт ждал CI около 2 мин,
потом `waitForRegistry` 180 с спрашивал `npm view …@0.31.2 --prefer-online` —
и написал «not visible after 3 min». Через пару минут `npm view` и
`registry.npmjs.org/@vodmal%2fvdx-cli` уже отдавали 0.31.2 (`latest`). Отставание
вышло больше 5 мин от publish; у 0.31.1 жалобы не было. Под гейтом ожидание
registry начинается после CI — можно считать его от publish, дать больше или
спрашивать адрес версии (`/<пакет>/<версия>`); что быстрее отдаёт новую версию —
не проверено. Выпуск не сломан: строка `!` честно говорит «npm accepted it».

**Status:** resolved — 2026-10-19: ожидание считается от `npm publish` и
длится до 10 мин (`waitForRegistry(…, since)`); строка ожидания говорит, что
Ctrl-C останавливает только его. Какой адрес registry отдаёт новую версию
раньше — не проверялось, вопрос `npm view … --prefer-online` остался. Выйдет со
следующим выпуском

### #10. Bitbucket Server (`git.finam.ru`) — три рабочих проекта

**Возникло в:** DL #12
**Описание:** global-auth, kratos, tx-auth-widget — `origin` на Bitbucket
Server 5.16.1 (2019). Ось там — «неизвестно: origin is on git.finam.ru». REST
`/rest/api/1.0/` есть; защита ветки — branch permissions, обязательная сборка —
merge checks (`/rest/api/1.0/projects/{p}/repos/{r}/settings/hooks`, плагины
сборок). Токен — HTTP access token Bitbucket; CLI вроде `gh`/`glab` у него нет.
Что именно отдаёт этот сервер — не проверено.

**Status:** open

## Next actions

Развилки — к владельцу; ответ — запись в Decision Log.

- [x] Развилка 1 — обход для админов: только `everyone` (DL #3)
- [x] Развилка 2 — HTTPS API, `gh` — источник токена (DL #4)
- [x] Развилка 3 — `origin` и ветка по умолчанию (DL #5)
- [x] Дизайн модуля — `src/hosting.ts`, дочерний процесс, `VDX_OFFLINE`
      (DL #6)
- [x] Предикат `branch_requires_checks` через расширение — классическая
      защита и рулсеты; тесты на записанных ответах (2026-10-15)
- [x] Спека: `rubric-format.md`, `architecture.md`, `maturity-rubric.md`,
      `cli/README.md`, `vdx audit --help` (2026-10-15)
- [x] Выпуск CLI (minor) и `vdx audit .` на выпущенном — 0.29.0
      (2026-10-15); на нём у vdx L3 известен и «не выполнено» (2026-10-18,
      критерий)
- [x] После выпуска: HANDOFF и «Текущая фаза» CLAUDE.md — потолок L2 теперь
      «не выполнено», пока `main` не защищён (2026-10-18)
- [x] Владелец: жить ли vdx под гейтом — да, выпуск из терминала и команда
      vdx для ожидания CI (DL #8, 2026-10-18)
- [x] `vdx push` (`src/gate.ts`), выпуск через гейт в `vdx publish`, `ci.yml`
      на `vdx-gate/**`, хук `pre-push` уступает CI; тесты (DL #9, #10;
      2026-10-18)
- [x] Выпуск с ними, пока `main` открыт; `vdx` на m3 и lft — 0.31.0
      (`464d991`, 2026-10-18)
- [x] nas-info: `gh` на lft, как `glab` — стоит, 2.102.0 (`gh-on-lft-outcome`,
      2026-10-19); вход владельца на lft — есть
- [x] Sidetrack #7: проверка токена GitHub в `vdx doctor` (2026-10-19; выйдет
      со следующим выпуском)
- [x] Sidetrack #8: `gh` из ssh на m3 — ответ nas-info, проверено (2026-10-19)
- [x] Sidetrack #9: ожидание registry — до 10 мин от `npm publish` (2026-10-19)
- [x] Владелец: защита `main` — проверки `cli (node 22)` и `cli (node 24)`,
      без обхода (DL #3); включена через `gh` на m3 (2026-10-18)
- [x] `vdx audit .` под гейтом — общий L4 (0.31.0, 2026-10-18)
- [x] Первый `vdx push` под гейтом — живая проверка: со второго раза, `106da5f`
      в `main` (2026-10-19); 422 сразу после push — исправлено, в 0.31.1
- [x] Выпуск 0.31.1 (patch) рабочим CLI, где исправление уже есть; в нём же
      vdx под старым node проекта (`b275af3`, `bin/node-guard.cjs`) —
      `8e26027` (2026-10-19); push `b4a35b1` и push выпуска прошли гейт с
      первого раза; на m3 и lft — 0.31.1
- [x] После: строка коммита — `vdx push` вместо `git push`; «Push в `main`» и
      «Выпуск CLI» в CLAUDE.md, HANDOFF (2026-10-18)
- [x] Sidetrack #1: gitolite — отложен владельцем (DL #12, 2026-10-20)
- [x] Sidetrack #2: расширение GitLab (DL #12, 2026-10-20)
- [x] Выпуск 0.33 (minor) с GitLab — 0.33.0 (`6587434`, 2026-10-20), на m3 и
      lft; аудит им: limeflow, ga-developer-portal, showcase — «нет» с причиной,
      kratos — «неизвестно: origin is on git.finam.ru»
- [ ] Sidetrack #10: Bitbucket Server — вопрос владельцу: делать ли
- [x] Sidetrack #4: причина у «не выполнено» — `{ no }`, «Not met» (DL #11,
      2026-10-19)
- [x] Выпуск 0.32 (minor) с Sidetrack #4 — 0.32.0 в npm (2026-10-20); push
      коммита выпуска остановился на `ETIMEDOUT`, доводит второй `vdx push`
- [x] 0.32.1 (patch): ожидание переживает запрос без ответа — в npm
      (`543d937`, 2026-10-20), на m3 и lft; аудит им: vdx — L4, у
      `vdx-rubric-vodmal` — «Not met» с причиной; registry — 262 с от publish
- [ ] Sidetrack #5: комментарий оси в сете — со следующим тегом сета
- [x] Sidetrack #6: вопрос `vdx publish` о выпуске без изменений (2026-10-19)
- [x] Выпуск (patch) с #6, #7, #9 — 0.31.3 (`2a48c55`, 2026-10-19); на m3 и lft
      — 0.31.3
- [x] Sidetrack #3: закрыт развилкой 3 — у зеркала ось читает `origin` (DL #5)

## References

- DL #12, #13 кристалла
  [[vdm-gates-wiring-axis/workitem|vdm-gates-wiring-axis]] — почему ось
  critical с L3 и почему «неизвестно».
- `cli/src/predicates.ts` — `branch_requires_checks`; сет — ось
  `branch-protection` в `cli/rubric/vdx-rubric.yaml`.
- GitHub REST: `GET /repos/{owner}/{repo}/branches/{branch}`,
  `GET /repos/{owner}/{repo}/rules/branches/{branch}`.
- `references/` пуст: ответы API короткие и пересказаны в DL #2 целиком,
  повторяются теми же запросами.
