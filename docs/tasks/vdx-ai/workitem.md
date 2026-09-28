---
title: "vdx ai — запуск агента в проекте по личному профилю"
slug: vdx-ai
description: "Запускает нужного агента в нужном репо с нужными флагами, в tmux если он есть"
status: in-progress
session-type: prd-work
created: 2026-09-28
last-updated: 2026-09-28
---

# vdx ai — запуск агента в проекте по личному профилю

> Выросло из письма echelon `project-sessions-channels-flag` (intercom,
> 2026-09-28): сессии проектов, которым echelon шлёт сигналы, стартуют без флага
> канала, и сигналы молча теряются. Владелец развернул просьбу в фичу vdx: не
> скрипт, а команда `vdx ai`.

## Назначение

**Боль (из письма echelon).** `echelon watch` будит агента проекта событием
канала Claude Code (`notifications/claude/channel`). Сессия, запущенная без
`--dangerously-load-development-channels plugin:echelon@echelon`, событие молча
отбрасывает. 2026-09-28 на lft флага не было ни у одной сессии, в том числе у двух
проектов с `mail.watch`: `t23b-program` (окно 17:00–23:00 NY) и
`global-auth-gap` (будни 09:00–19:00 NY, окно уже открыто).

**Запрос владельца.** Дословно: «не хочу скрипты хочу vdx ai и чтобы он все
сделал - в нужных репах с нужными правами нужный агент (для меня - claude с
--dangerously-skip-permissions, а для другого это может быть и codex и что
угодно), в моем случае еще и внутри tmux (если он не доступен, то без него
автоматически, например)». И: «у нас есть vdx-rubric-vodmal как раз для моего».

**Критерий успеха.**
- `vdx ai [path]` запускает агента из личного профиля в каталоге проекта, с
  флагами профиля плюс условными флагами проекта.
- В профиле владельца: `claude --dangerously-skip-permissions`, tmux-сессия
  `<проект>@<машина>`; без tmux — прямой запуск в текущем терминале.
- Приёмка echelon: сессии `t23b-program` и `global-auth-gap` работают в tmux с
  флагом канала, и `ps` показывает флаг.
- Повторный `vdx ai` не плодит сессии: находит уже запущенного агента проекта.

## Текущая модель

- **Команда** `vdx ai [path] [--restart] [--dry-run] [--detach]` в CLI
  (`cli/src/ai.ts`). Своего раннера нет: vdx собирает командную строку агента и
  отдаёт её tmux или запускает напрямую.
- **Профиль личный, не общий.** Секции `agent` и `session` в
  `vdx-environment.yaml` персонального сета (`vdx-rubric-vodmal`). В CLI не
  вшивается. Поиск: `$VDX_ENVIRONMENT` → `~/.vdx-environment.yaml`. Без профиля —
  нейтральный дефолт без опасных флагов и без tmux (DL #2).
- **Условные флаги** — `agent.when[]`: предикат рубрики (`config_value`,
  `has_file`, …) по файлам проекта → добавочные `args`. Знание про echelon живёт
  в профиле, не в ядре (DL #3).
- **Окно подтверждения** флага канала появляется при каждом старте, включая
  `--continue`, и подтверждается Enter (DL #7, проверено живьём). В tmux vdx
  отвечает на него по правилу `confirm` условного флага; без tmux отвечает
  человек. На вопрос о доверии к папке vdx не отвечает (DL #7).
- **Запуск в tmux** — через login-shell пользователя, чтобы агент видел
  `.zshrc` (DL #8).
- **Идемпотентность по процессу, не по имени.** Своя сессия проекта = панель
  tmux, где запущен агент профиля с cwd внутри проекта. Имя шаблона нужно только
  для новой сессии (DL #5).
- **Дрейф флагов** у бегущего агента — отчёт и выход с ошибкой; перезапуск только
  явным `--restart`, с `resume_args` профиля (DL #5). Если с ними агент не выжил
  (продолжать нечего) — один повторный запуск без них (DL #9).
- **Версия сета** — `v0.4.0` для обоих документов (DL #10); тег на GitHub с
  2026-09-28 (`bd004f2`).
- **Состояние на 2026-09-28:** на lft обе сессии с `mail.watch` работают по
  профилю, канал echelon доходит (DL #11). CLI на lft стоит из рабочего дерева;
  на m3 vdx нет — ждём nas-info.
- **`{host}`** в имени сессии = `$VDX_HOST`, иначе короткое имя хоста (DL #6).

## Decision Log

### #1 / 2026-09-28 / Команда vdx, а не скрипт на машине

**Source:** user
**Basis:** user-stated
**Basis-detail:** «не хочу скрипты хочу vdx ai и чтобы он все сделал». Ответ на
моё предложение сделать shell-скрипт запуска рядом с `.zshrc` или в `scripts/`.
**Context:** Первый вариант — маленький скрипт вне CLI: запуск сессии агента
выглядел свойством машины, по аналогии с DL #8 кристалла `vdm-gates-wiring-axis`.
**Why:** Главная цель vdx (CLAUDE.md) — чтобы агент мог эксплуатировать любой
проект без повторного разбора. Запуск самого агента в проекте — входная точка
этого сценария. Машинная специфика (tmux, флаги, echelon) уходит в личный
профиль, а команда остаётся общей.
**Implication:** Новая команда CLI, новый документ в персональном сете. Своего
раннера по-прежнему нет: tmux и агент — готовые инструменты.

### #2 / 2026-09-28 / Профиль агента — в личном сете, не в CLI

**Source:** both
**Basis:** user-stated
**Basis-detail:** Владелец: «у нас есть vdx-rubric-vodmal как раз для моего» и
«для меня — claude с --dangerously-skip-permissions, а для другого это может быть
и codex». Механизм поиска выбрал ассистент.
**Context:** Рубрика вшита в CLI (`cli/rubric/vdx-rubric.yaml`,
`defaults.ts`), и `DEFAULT_BASELINE` уже раздаёт личный baseline всем (Sidetrack #6
кристалла `vdm-gates-wiring-axis`). Если вшить профиль так же, чужой
пользователь `npx @vodmal/vdx-cli ai` получил бы `--dangerously-skip-permissions`
без спроса.
**Why:** Выбор агента и его прав — решение человека. Опасный флаг не может быть
дефолтом, до которого человек не дотронулся. Профиль ложится в
`vdx-environment.yaml` — документ, который DL #8 кристалла
`vdm-gates-wiring-axis` уже отвёл под машинное и личное. Поиск
`$VDX_ENVIRONMENT` → `~/.vdx-environment.yaml` (путь из текста O40).
**Implication:** `vdx ai` — первый потребитель `vdx-environment.yaml`. Проверки
doctor (O40) лягут туда же позже, отдельной секцией. Без профиля vdx запускает
`claude`, если он есть, иначе `codex`, без флагов и без tmux, и подсказывает, где
лежит профиль.

### #3 / 2026-09-28 / Условие echelon — предикатом рубрики в профиле

**Source:** assistant
**Basis:** observed
**Basis-detail:** `config_value` (`predicates.ts`) с `path: signals/sources.yaml`,
`jsonpath: mail.watch` читает YAML и точечный путь. Проверено на шести
проектах: `mail.watch` есть у `t23b-program` и `global-auth-gap`; у `space-hq`
`sources.yaml` есть, а `mail.watch` нет; у `vdx`, `echelon`, `limeflow` файла нет.
**Context:** Echelon: «Источник правды — `mail.watch` в `signals/sources.yaml`
проекта. Машинного списка у echelon сейчас нет».
**Why:** Готовый предикат покрывает условие без нового кода и ровно на той
популяции, где боль (оба проекта из письма), не задевая соседний `space-hq`.
Знание «echelon будит через канал» принадлежит профилю владельца, ядро vdx о нём
не знает.
**Implication:** `agent.when[]` = `{id, if: <predicate>, args, confirm?}`.
`evalPredicate` переиспользуется как есть.

### #4 / 2026-09-28 / Диалог флага канала — при каждом старте; отвечает правило профиля

**Source:** assistant
**Basis:** inferred
**Basis-detail:** Прочитан код бинаря Claude Code 2.1.283 (`strings` по
`/usr/local/Caskroom/claude-code@latest/2.1.283/claude`). Шаг установки
вызывает `DevChannelsDialog` («WARNING: Loading development channels», кнопки
«I am using this for local development» / «Exit»), когда переданы dev-каналы,
каналы включены и провайдер first-party. Хранения согласия нет, в отличие от
`BypassPermissionsModeDialog` с `storageV5`. **Не проверено:** живой запуск,
какая клавиша подтверждает, появляется ли диалог при `--continue`.
**Context:** Echelon: «Если спрашивает, `tmux new -d` повиснет на вопросе».
**Why:** Зашивать в ядро ответ на диалог конкретного агента — значит тащить его
специфику в vdx. Правило `confirm: [{screen, keys}]` рядом с условным флагом,
который диалог и вызывает, держит знание в профиле. Отвечать автоматически
допустимо: владелец сам просит этот флаг.
**Implication:** В tmux vdx ждёт текст `screen` в `capture-pane` и шлёт `keys`.
Без tmux человек видит диалог сам. Проверить живым запуском до перезапуска
реальных сессий.
**Superseded-by:** #7

### #5 / 2026-09-28 / Своя сессия ищется по процессу агента; перезапуск только явно

**Source:** assistant
**Basis:** observed
**Basis-detail:** `tmux list-panes -a` на lft: сессия `global-auth-gap` называется
`ga-gap@lft`, а не по identity. `ps` под `pane_pid`: `t23b-program@lft` →
`/usr/local/bin/claude --dangerously-skip-permissions --continue`, `ga-gap@lft` →
`/usr/local/bin/claude --dangerously-skip-permissions`.
**Context:** Поиск по имени шаблона не нашёл бы `ga-gap@lft` и завёл бы вторую
сессию рядом с живой.
**Why:** Процесс агента с cwd внутри проекта — факт, имя — договорённость. Живую
сессию с неполными флагами vdx не трогает сам: перезапуск обрывает идущую работу,
и когда его делать, решает владелец (так же сказано в письме echelon).
**Implication:** Состояния: нет агента → создать; агент с полными флагами →
подключиться; агент без части флагов → отчёт о дрейфе, код 3, подсказка
`--restart`. `--restart` = `tmux respawn-pane -k` в той же панели с
`resume_args` (`--continue` у claude), чтобы вернулся разговор.

### #6 / 2026-09-28 / `{host}` = `$VDX_HOST`, иначе короткое имя хоста

**Source:** assistant
**Basis:** observed
**Basis-detail:** На lft `hostname -s` = `vodmal-work-imac`, а метка в именах
сессий — `lft`. Метку считает `.zshrc` владельца (`VDM_HOST_LABEL` из
`SSH_ALIAS` nas-info), но переменная не экспортирована (`typeset -g`).
**Context:** Профиль общий для m3 и lft, поэтому метка машины не может в нём
лежать.
**Why:** Значение на уровне машины передаётся через переменную окружения. Это
стандартный путь, и vdx не узнаёт про nas-info.
**Implication:** Владельцу нужна одна строка в `.zshrc`:
`export VDX_HOST=$VDM_HOST_LABEL`. Без неё имя будет
`<проект>@vodmal-work-imac` — рабочее, но не по конвенции.

### #7 / 2026-09-28 / Диалог канала подтверждён живьём; доверие к папке vdx не отвечает

**Source:** assistant
**Basis:** observed
**Basis-detail:** Тестовая tmux-сессия `vdx-aitest` в пустом каталоге scratchpad
на lft, Claude Code 2.1.283, `claude --dangerously-skip-permissions
--dangerously-load-development-channels plugin:echelon@echelon`. Экран по
`tmux capture-pane`, по порядку: (1) «Accessing workspace … Is this a project you
created or one you trust?», курсор `❯ No, exit`, второй пункт «Yes, I trust this
folder»; (2) «WARNING: Loading development channels … Channels:
plugin:echelon@echelon», курсор `❯ 1. I am using this for local development`,
`2. Exit`, подпись «Enter to confirm · Esc to cancel». Enter → рабочий экран со
строкой «Channels (experimental) messages from plugin:echelon@echelon inject
directly in this session». `ps`: `/usr/local/bin/claude
--dangerously-skip-permissions --dangerously-load-development-channels
plugin:echelon@echelon`. Затем `tmux respawn-pane -k` той же панели с
`--continue`: диалог (2) появился снова, диалога (1) не было. Сессию убил.
**Context:** DL #4 опирался на чтение кода бинаря; живьём не проверялось, какая
клавиша подтверждает и бывает ли диалог при `--continue`.
**Why:** Окно канала подтверждается одним Enter, и vdx отвечает на него по
правилу `confirm` из профиля. Окно доверия — другое дело: курсор по умолчанию на
«No, exit», так что слепой Enter закрыл бы агента, а ответ «да» снимает защиту от
чужого репозитория. Это решение человека, поэтому профиль владельца правила для
него не содержит. Отсюда общее правило: `confirm` есть только у условных флагов,
где окно ожидаемо, и vdx ждёт именно его. Если вместо него на экране что-то
другое, vdx сообщает об этом и подключает человека.
**Implication:** `keys` — список клавиш tmux (`[Enter]`, при нужде
`[Down, Enter]`). После ответа vdx ждёт, что текст ушёл с экрана, и проверяет
`ps`. `--restart` ответит на окно снова, потому что оно есть и при `--continue`.
**Supersedes:** #4

### #8 / 2026-09-28 / В tmux агент стартует внутри login-shell пользователя

**Source:** assistant
**Basis:** observed
**Basis-detail:** Тот же тест: панель запущена командой
`exec /bin/zsh -lic '<агент>; exec /bin/zsh -l'`. `ps` показал
`/usr/local/bin/claude`, то есть alias из `.zshrc` раскрылся, `.zshrc`
прочитан. Сервер tmux на lft поднят launchd (`tmux-server.sh`), его окружение не
содержит того, что `.zshrc` экспортирует (например
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`). **Не проверено** поимённо, что каждая
переменная из `.zshrc` дошла до агента.
**Context:** Команда, переданная tmux напрямую, выполняется в `$SHELL -c` без
`.zshrc`, в окружении сервера, а не того терминала, где набрали `vdx ai`.
**Why:** Владелец сейчас запускает агента руками в интерактивном шелле, и агент
видит всё, что задаёт `.zshrc`. Обёртка повторяет это без ввода с клавиатуры,
поэтому нет гонки с инициализацией шелла. После выхода агента в панели остаётся
обычный шелл, как и сейчас.
**Implication:** Без tmux vdx запускает агента напрямую: окружение уже взято из
шелла, где набрали команду.

### #9 / 2026-09-28 / Продолжать нечего — один повторный запуск без `resume_args`

**Source:** assistant
**Basis:** observed
**Basis-detail:** Сквозной прогон с настоящим Claude Code на lft (scratch-проект
`aie2e` с `mail.watch`). Первый `vdx ai` упёрся в вопрос о доверии: код 4,
последние строки панели выведены. После ручного «Yes» Claude встал на окно
канала. `vdx ai --restart` → `respawn-pane` с `--continue` → окно отвечено →
«No conversation found to continue», claude вышел. После правки та же
последовательность: «↻ nothing to resume — starting without --continue», окно
отвечено снова, `ps` показал все флаги профиля, экран — строку «Channels
(experimental) messages from plugin:echelon@echelon…». Затем повторный `vdx ai` —
«already running with the profile», новых панелей нет.
**Context:** Путь восстановления для новой папки как раз такой: первый запуск
упирается в вопрос, человек отвечает, потом `--restart`. Разговора у агента ещё
нет, и перезапуск с `--continue` оставлял проект без агента.
**Why:** Если агент с `resume_args` не выжил, терять нечего — контекста, который
они должны были вернуть, нет. Один повторный запуск без них, с явной строкой в
логе, лучше, чем проект без агента. Повтор ровно один: если агент падает и без
`resume_args`, дело не в продолжении, и vdx сообщает об отказе. Отдельно: агент
считается живым, только если процесс виден дважды с интервалом в секунду — Claude
сообщает «продолжать нечего» уже после ответа на окно.
**Implication:** Тест с поддельным агентом, который выходит при `--resume-me`,
проверен мутацией. Для `t23b-program` и `global-auth-gap` разговоры есть, и
`--continue` их вернёт; запасной путь нужен новым проектам.

### #10 / 2026-09-28 / Сет получает тег `v0.4.0`, версия рубрики поднимается вместе с ним

**Source:** assistant
**Basis:** observed
**Basis-detail:** README сета: «`metadata.version` inside vdx-rubric.yaml must match
the git tag». CLAUDE.md vdx: minor — «новая ось, новый flag»; DL #8 кристалла
`vdm-gates-wiring-axis`: «один репозиторий, один semver-тег». Литерал
`@v0.3.1` нашёлся в пяти местах vdx, включая копию в `mcp-server.ts:159` в обход
`DEFAULT_BASELINE`. Самоаудит vdx после бампа: overall L1, как и до него.
**Context:** Новый документ в сете — аддитивное изменение. Оси рубрики не
меняются.
**Why:** Одна версия на сет — правило уже записано; раздельные версии
документов пришлось бы вводить ради одного случая. Минор, потому что
добавление, а не правка предиката. Литерал в `mcp-server.ts` заменён
константой: иначе следующий бамп снова его пропустит.
**Implication:** `vdx-rubric.yaml` `metadata.version` → `0.4.0` без изменения
осей; зеркала `cli/rubric/` и `docs/specs/vdx-rubric.example.yaml`,
`DEFAULT_BASELINE`, собственный `mise.toml` vdx, `plugin/README.md` — на
`@v0.4.0`. Тег и push ждут владельца; до публикации CLI бандл-рубрика и
`DEFAULT_BASELINE` указывают на тег, которого на GitHub ещё нет.

### #11 / 2026-09-28 / Сессии перезапущены; канал echelon доходит — проверено тестовым сигналом

**Source:** both
**Basis:** observed
**Basis-detail:** Владелец выбрал «Перезапустить 2 сессии». Перед перезапуском
текст в поле ввода обеих сессий («Q1–Q8 ок, по всем твоим рекомендациям»,
«давай закоммитим») проверен по `tmux capture-pane -e`: он тусклый
(`ESC[2m`), то есть это подсказка Claude Code, а не черновик владельца;
признака идущего хода («esc to interrupt») не было. `vdx ai --restart` для
`global-auth-gap` и `t23b-program` около 12:38–12:40 EDT: окно канала отвечено,
`ps` у обеих — `/usr/local/bin/claude --dangerously-skip-permissions
--dangerously-load-development-channels plugin:echelon@echelon --continue`,
разговоры вернулись (контекст 56% и 5%, как до перезапуска). Строки «Channels
(experimental)…» в истории перезапущенных панелей нет. echelon по просьбе
положил тест `test-20260928-1243` в 12:43:25; на экране `ga-gap@lft` к 12:43:39
и `t23b-program@lft` в 12:43:45 — «← echelon: ТЕСТ канала echelon (проверка
vdx, 28.09)…», агент global-auth-gap ответил, что канал доходит.
**Context:** Приёмка echelon: сессии работают с флагом канала, и `ps` его
показывает. Флаг в `ps` ещё не значит, что событие доходит, а строки о канале
в перезапущенных сессиях не было.
**Why:** Только настоящий сигнал от echelon проверяет весь путь: wake-файл,
MCP-сервер в сессии и `notifications/claude/channel`.
**Implication:** Приёмка echelon выполнена на lft. На m3 vdx нет — установку
ведёт nas-info (бриф `vdx-on-workstations`).

## Sidetracks

### #1. vdx не установлен на lft

**Возникло в:** разведка перед реализацией, `which vdx` → not found.
**Описание:** Чтобы владелец набирал `vdx ai`, CLI должен быть на PATH: `npm i -g`
после публикации или глобальная установка из рабочего дерева. Проверка doctor
`vdx-on-path` про это и есть.

**Status:** open

### #2. У t23b-program нет remote `origin`

**Возникло в:** DL #5, вычисление `{project}`.
**Описание:** `git -C t23b-program remote get-url origin` → «No such remote».
`{project}` падает на имя каталога — `t23b-program`, совпадает с нынешним именем
сессии. Intercom поступает так же.

**Status:** resolved — покрыто тестом `projectIdentity`

### #3. HANDOFF отстал на коммит

**Возникло в:** чтение HANDOFF.md в начале сессии.
**Описание:** «Висит в рабочем дереве: правка `cli/package-lock.json`» — уже
закоммичено (`69a5438`). Поправить вместе с записью про `vdx ai`.

**Status:** resolved — HANDOFF переписан 2026-09-28

### #4. Список проектов, которым нужна живая сессия

**Возникло в:** письмо echelon: «Машинного списка у echelon сейчас нет; если он
нужен, напишите, в каком виде».
**Описание:** `vdx ai` запускает один проект. Поднять все проекты, чьё условие
выполняется (например после перезагрузки), — отдельная команда поверх этой.
Списка проектов у vdx нет, а у echelon — только `sources.yaml` по проектам.
Не делать, пока не попросят.

**Status:** open

### #5. Сессия Claude в каталоге без git регистрирует агента intercom

**Возникло в:** DL #7, тест в `scratchpad/aitest` (не git).
**Описание:** После теста `intercom directory` показал запись `aitest` без имён и
путей. Снял её `intercom.sh unregister aitest`. SKILL.md intercom обещает, что
неявная регистрация по одному имени каталога (source `cwd`) ничего не пишет;
судя по записи, SessionStart-хук этого не соблюдает. Касается `vdx ai` в любом
каталоге без git. Сообщить `ai-dev-plugins`.

**Status:** open

## Next actions

- [x] `cli/src/ai.ts`: загрузка профиля, чистый план запуска (агент, флаги,
      условия, имя сессии), юнит-тесты — 2026-09-28
- [x] tmux: поиск своей сессии по процессу, создание, ответ на диалог, проверка
      флагов через `ps`, подключение; `--restart`; прямой запуск без tmux —
      2026-09-28, 35 тестов (5+1 на изолированном tmux), мутации; живьём — DL #9
- [x] Живая проверка на lft: тестовая сессия с флагом канала — диалог, клавиша,
      `ps` (закрывает непроверенное в DL #4) — DL #7, 2026-09-28
- [x] `vdx-environment.yaml` в `vdx-rubric-vodmal` + CHANGELOG + README —
      2026-09-28, ветка `feature/vdx-environment`, не закоммичено
- [x] Коммит, тег `v0.4.0` и push `vdx-rubric-vodmal` — 2026-09-28, `bd004f2`,
      тег `v0.4.0` на GitHub
- [x] Документация: D14 в `docs/decisions.md`, спека профиля в `docs/specs/`,
      README и `cli/README.md`, PROJECT_CHANGELOG, HANDOFF (Sidetrack #3) —
      2026-09-28
- [ ] Коммит ветки `feature/vdx-ai` — с согласия владельца
- [x] Установка на lft: CLI на PATH, `~/.vdx-environment.yaml`,
      `export VDX_HOST` — 2026-09-28: симлинк профиля на клон сета; строка
      `export VDX_HOST=$VDM_HOST_LABEL` в общем `~/Dropbox/settings/bash/.zshrc`;
      CLI временно `npm i -g` из рабочего дерева
- [ ] vdx на m3 и lft через nas-info — бриф `vdx-on-workstations` отправлен
      2026-09-28, ждём ответ nas-info (у него в очереди 12 писем)
- [x] Перезапуск `t23b-program` и `global-auth-gap` через `vdx ai --restart` —
      2026-09-28, канал проверен тестовым сигналом (DL #11)
- [x] Ответ echelon письмом: как стартуют сессии, где это лежит, что проверено —
      `project-sessions-vdx-ai`, 2026-09-28; результат теста — сообщением
- [ ] Публикация CLI в npm — с согласия владельца
- [ ] Sidetrack #1: CLI на PATH на lft (закрывается пунктом установки выше)
- [x] Sidetrack #2: тест — репо без `origin` даёт `{project}` = имя каталога —
      `projectIdentity` «the t23b-program case», 2026-09-28
- [x] Sidetrack #3: поправить устаревшую строку HANDOFF про package-lock —
      блок «Активная работа» переписан, 2026-09-28
- [ ] Sidetrack #4: спросить владельца, нужен ли подъём всех проектов по условию
- [ ] Sidetrack #5: письмо `ai-dev-plugins` про регистрацию по имени каталога

## References

- Письмо echelon `project-sessions-channels-flag` — архив intercom
  `~/.claude/vdm/intercom/vdx/_done/project-sessions-channels-flag.md`. В репо не
  копируется: vdx публичный, а письмо описывает частную инфраструктуру
  владельца. Нужное для решений пересказано в «Назначении» и DL #3–#6.
- README echelon, раздел «Частый сбор и сигнал агенту (DL #46 v2)» —
  `/Users/vdm/AI Projects/echelon/README.md`.
- Конвенция tmux-сессий — `~/nas-info/docs/features/shared-terminal.md`.
- [[vdm-gates-wiring-axis/workitem|vdm-gates-wiring-axis]] — DL #8 там отводит
  `vdx-environment.yaml` под машинное и личное.
