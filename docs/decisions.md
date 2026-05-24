# Research-журнал: решения и открытые вопросы

Единый источник правды по фазе. Разделяет: что **решено**, что **открыто**, что
**наблюдалось**. Каждое решение датируется.

---

## Решённые вопросы

### D1 — Рубрика принадлежит человеку/организации, не проекту
Дата: 2026-05-22

«Эталон» — набор правил уровня человека/организации, по аналогии с готовыми
наборами rector / phpstan / psalm. Проект подключает owner-baseline и может
локально переопределять/подавлять требования (D9).
Модель: `baseline ruleset (owner)` + `per-project override layer`.

### D2 — Рубрика иерархическая: general → lang/platform-specific
Дата: 2026-05-22

Сверху общие («it-general») оси, под ними стек-специфичные реализации.
Уточнение из калибровки: для TS флаги ортогональны (не монотонная шкала как
phpstan-level), поэтому ось `static-analysis` хранится как набор флагов.

### D3 — Оседлать mise для столпа P1
Дата: 2026-05-22

vdx = тонкая обёртка: `vdx <verb>` → infra-precheck → `mise run <verb>`. Плюс
генератор `mise.toml` + детект стека + fallback на `make`/`composer`/`npm`.

### D4 — Манифест ≈ `mise.toml` + vdx-метаблок; проекция в `AGENTS.md`
Дата: 2026-05-22 · **Закрывает O3**

Машиночитаемый манифест — `mise.toml` с нормализованными глаголами +
vdx-метаблок. vdx генерирует секцию `## Commands` в `AGENTS.md` с маркерами
`<!-- vdx:commands -->`. Детали — [specs/manifest-format.md](specs/manifest-format.md).

### D5 — Аудит: оседлать сбор фактов, строить только рубрику + drift
Дата: 2026-05-22

Оседлать: **OpenSSF Scorecard** (security), **Qlty CLI** (code-quality),
**MegaLinter** (запуск линтеров), **copier** (`copier update` для scaffold-fix).
Архитектура «probes → JSON-факты → policy-движок» — из Scorecard.

### D6 — Упаковка для Claude Code = плагин (MCP + skill + hook)
Дата: 2026-05-22

Плагин Claude Code: **MCP-сервер** (6 глаголов + `list_capabilities` + audit +
record) + **skill** + **hook**. Детали — [specs/mcp-api.md](specs/mcp-api.md).

### D7 — Скоринг уровня: weighted, два класса осей
Дата: 2026-05-22 · **Закрывает O10, O11**

Оси: **critical** (must-max) = `lifecycle-interface`, `tests`, `static-analysis`,
`ci`. **Supporting** = всё остальное (≥80% на максимуме для уровня).
Формула: `max(L)`, такой что все critical ≥ L и ≥80% supporting ≥ L.

### D8 — Ось `shared-infra` пересобрана: качество подхода + автопровижининг
Дата: 2026-05-22 · **Закрывает O12**

L0 голые порты → L1 docker hardcoded → L2 shared proxy ручное → L3 + автоподъём
в `up` → L4 в отдельном версионированном репо/пакете с self-provisioning.

### D9 — Override/suppress: `.vdx-overrides.yml`, copier-style
Дата: 2026-05-22 · **Закрывает O5**

Per-project переопределения по осям с обязательным `reason` и опциональным
`until`. Детали — [specs/overrides-format.md](specs/overrides-format.md).

### D10 — Движок оценки = нативный, не OPA
Дата: 2026-05-22 · **Закрывает O8**

Для ~15 осей с правилами «значение vs порог + класс + вес» нативный оценщик
проще OPA/Rego на порядок. Если рубрика обрастёт cross-axis-правилами — миграция
на OPA возможна без слома формата.

### D11 — Baseline в отдельном git-репо, semver-теги
Дата: 2026-05-22 · **Закрывает O4**

Owner-baseline = отдельный git-репозиторий (`vdx-rubric-vodmal`), версионирование
через semver-теги (`v0.2.0`). Манифест ссылается:
`baseline: github.com/vodmal/vdx-rubric@v0.2.0`. Аудит загружает **указанную**
версию — детерминированность + контролируемое обновление через bump в манифесте.

---

## Открытые вопросы

### Активные (от vision research)
- **O6** — Кросс-стек сравнение: ось `static-analysis` хранится как набор
  флагов; общий score — доля включённых строгих флагов / максимум.
  Конкретный список флагов на стек закреплён в
  [specs/rubric-format.md](specs/rubric-format.md).
- **O7** — Точный набор глаголов. Базовый `up/down/build/test/check/fix`.
  `rebuild`/`restart`/`logs`/`ps`/`clear` — решится при первой реализации.
- **O9** — devbox/Nix поверх mise? Research склоняется: mise достаточно.

### Активные (от спеки)
- **O13** — Должны ли композитные предикаты быть Тьюринг-полны (loop'ы)? Для
  v0.2 — нет; декларативные.
- **O14** — Отношение `schema_version` ↔ `metadata.version` (формат vs содержимое).
- **O15** — `verbs` декларация vs автодискавер из `[tasks]`.
- **O16** — Формат `acknowledged_drift`: список ID или объекты с reason+until.
- **O17** — Auto-escalate override при закрытии оси `vdx fix`.
- **O18** — Streaming `vdx_audit` результата (job_id + status) vs ответ сразу.
- **O19** — Streaming output lifecycle-глаголов vs буферизованный.
- **O20** — Что делать с `drift_kind: over` (выше стандарта): игнорировать или
  предложить включить в baseline.
- **O21** — Бюджет аудита на крупном репо (<30 сек цель). Стратегии кэширования.

### Активные (от smoke v0.1 evaluator + догфудинг)
- **O25** — Mock-infra delta-style ловушка. Node-проекты, у которых mock
  сделан как отдельный docker-сервис (bookmap: `mock-bookmap-api`, директория
  `mock-server/`, `Dockerfile.mock-server`), технически реализуют L3-подход, но
  L2 (in-process mock: `msw`/`nock`/`tests/Fixtures`) у них пустой. По правилу
  «max непрерывный уровень» это даёт mock-infra L1 при фактически L3-зрелости.
  Опции: (a) добавить в L2 fallback `has_file: mock-server` или Dockerfile-
  паттерн; (b) пересмотреть L2 для Node так, чтобы он отражал «есть хоть какая-
  то изоляция внешних API»; (c) принять как фичу — Node-стек прыгает через
  in-process mock.
- **O26** — TOML round-trip с сохранением комментариев. `vdx_record_success_path`
  переписывает `mise.toml` через `smol-toml.stringify`, теряя комментарии и
  возможный порядок ключей. Это окей для bootstrap (когда файл вновь созданный),
  но плохо для update existing manifests. Кандидаты: `@iarna/toml` с custom
  patcher, или скриптовый patch-only подход (regex замена `[tasks.X]` блоков).
- **O27** — Shared-infra precheck в MCP. Lifecycle-tools сейчас не делают
  реальной проверки `is_running` (всегда false). По спеке `vdx_up` должен
  poднять shared infra (например Traefik) если `precheck: true`. Нужен механизм:
  HTTP-curl до `healthcheck_url`, либо `mise run up` в директории provider'a.
- **O29** — Поведение `vdx init` при stack=unknown. Сейчас генерится почти
  пустой `mise.toml` (`stack="unknown"`, `verbs=[]`) — корректно, но не полезно
  пользователю: нет mapping'а нативных задач, нет шансов поднять
  `lifecycle-interface` без ручной правки. Опции: (a) явно прервать с
  подсказкой передать `--stack <id>`; (b) интерактивный prompt (выбивается из
  «нет TTY» сценариев MCP); (c) ничего не делать (status quo) — пусть user
  правит `mise.toml` руками; (d) для stack=meta заюзать специальные `description-only`
  плейсхолдеры, чтобы хоть verb-имена были видны в AGENTS.md. Связан с O28.
- **O32** — Multi-subpackage monorepo (разные стеки в разных папках). Шаг K
  закрыл O31 одним полем `primary_subpackage` — но это **одно** subpackage на
  проект. Для гибрида типа `php-api/ + node-web/` (где tests/static-analysis
  должны оценивать оба) текущая модель даёт уровень только одного. Опции:
  (a) расширить поле до массива `primary_subpackages: ["php-api", "node-web"]`
  с aggregate-стратегией (`min`/`max`/`avg`); (b) per-axis маппинг в манифесте
  `[vdx.subpackages] tests = "php-api"`; (c) принять как ограничение —
  multi-stack monorepo использует override на оси. Реальных пользователей с
  таким раскладом пока нет — отложено до появления.
- **O34** — Новая ось рубрики `release-artifact` (publish-readiness).
  Наблюдение из Шага N: подготовка `cli/` к публикации в npm добавила набор
  атрибутов (`name`, `version`, `license`, `repository`, `bin`,
  `publishConfig`, `files`, `LICENSE`-файл), которые ни одна текущая ось
  не оценивает. `dependency-hygiene` смотрит lockfile, не publishability.
  Кандидат уровней: L1=поля `name`+`version`+`license` в manifest;
  L2=+`repository`, LICENSE-файл, `description`; L3=+`files`-whitelist,
  `bin`/entry-point, `publishConfig` (для scoped npm); L4=пакет реально
  опубликован и резолвится из реестра (`npm view`/`pip index`/`gem search`).
  `applies_to: [node, python, ruby, php]` (для package-manager-driven
  стеков). Семантически отдельная от `docs` (документация ≠ release).
  Пересекается с `primary_subpackage` (Шаг K) — возможно стоит ввести
  синоним `release_subpackage` или принять что они совпадают de facto.

### Закрытые

| # | Решено в |
|---|---------|
| O3 | D4 |
| O4 | D11 |
| O5 | D9 |
| O8 | D10 |
| O10 | D7 |
| O11 | D7 |
| O12 | D8 |
| O22 | Шаг D 2026-05-23 — `config_value` реализован в `predicates.ts` (JSON/TOML/YAML + ops `present`/`equals`/`gte`/`matches`) |
| O23 | Шаг D 2026-05-23 — regex `mock-infra` L3 расширен до `mock[-_]?[a-zA-Z0-9_-]*(server\|api\|service)` |
| O24 | Шаг D 2026-05-23 — флаг `phpstan_present` обёрнут в `any_of` с fallback на наличие `phpstan*.neon` |
| O28 | Шаг I 2026-05-23 — `autoDetectStack` в `facts.ts` теперь делает root-first + depth-1 scan; новая функция `findSubPackages` возвращает массив `{relPath, stack}`. См. N19. **Частично**: для оценки nested manifest'ов в предикатах нужен O30 (sub-package-aware predicates). |
| O30 | Шаг J 2026-05-23 — Добавлен `applies_to: [stack-id, ...]` filter на ось в спеке рубрики (v0.2.2). Если задан и `ctx.stack` не в списке — ось получает `drift_kind: excluded`, не учитывается в overall scoring. 5 осей помечены `[php, node, go, python]`: tests, static-analysis, code-style, dependency-hygiene, mock-infra. См. N20. **Частично**: остаётся (b) — sub-package-aware predicate evaluation для случая stack=node + nested manifest. Открыто как **O31**. |
| O31 | Шаг K 2026-05-23 — Добавлено поле `[vdx].primary_subpackage` в манифест проекта. В `audit.ts` для осей с `applies_to` evaluator подменяет `ctx.projectRoot` на subpackage (explicit-from-manifest или auto-resolve через `findSubPackages()` когда ровно один subpackage совпадает с `ctx.stack`). Owner-рубрика остаётся stack-agnostic. См. N21. **Полностью**: остаточный кейс multi-subpackage monorepo (разные стеки в разных папках) выделен в **O32**. |
| O33 | Шаг O 2026-05-23 — `stackForDir` экспортирован из `facts.ts`. В `resolveSubpackageCtx` (`audit.ts`): для explicit `primary_subpackage` теперь detect actual stack subpackage'a; для auto-resolve добавлен fallback "если ровно один subpackage с любым стеком — adopt его". Возвращаемый `subpackageCtx.stack` = stack subpackage'a (а не наследуется от root). В audit loop проверка `applies_to` сравнивается с `evalCtx.stack` (не `ctx.stack`). Эффект на vdx: 5 stack-осей больше не `excluded` — оцениваются по cli/ (static-analysis L0→**L2**, dependency-hygiene/mock-infra L0→**L1**, tests/code-style правдиво L0). Overall vdx L0→L0 (теперь capping на tests=C L0, не маска). Smoke на 3 референсах без регрессий. См. N25. |

---

## Наблюдения

### Из референсных проектов

**N1 — Дрейф паттернов через копипасту.**
`trading-tools-bookmap/misc/traefik-global/start.sh` помечен
`Based on: www.t23b.org/...`. Паттерн расползается ручным копированием.

**N2 — Расхождение словаря команд.** PHP: `composer up`. bookmap (Node):
`npm run docker:up`. Нужен нормализующий фасад.

**N3 — Shared-infra как зависимость `up`.** bookmap зависит от Global Traefik,
поднимаемого ДО `up`.

**N4 — Калибровочные референсы.** Не «эталоны», а образцы разных состояний:
- `telegram.vorobyev.name` — *экспериментально-глубокий* PHP, накопил много
  инструментария за счёт проб; местами over-engineered. Карта возможного.
- `www.t23b.org` — практический mid-уровень PHP; источник traefik-паттерна.
- `trading-tools-bookmap` — Node/TS со смешанной зрелостью.

### Из web-research 2026-05-22

**N5 — Раннеры.** mise — победитель: tasks стабильны, полиглот, делегирование
через shell-shim'ы, JSON-discovery. ~70% P1. См. landscape.md.

**N6 — Cross-repo / shared-infra gap.** Ни один раннер не моделирует «другой
репозиторий должен быть запущен». Флагман vdx.

**N7 — Версионируемой рубрики с drift локально не делает НИКТО.** Soundcheck —
мутирует стандарт вживую. IDP-скоркарды — SaaS, привязаны к каталогу.
vdx ≈ «офлайн single-developer срез IDP-скоркарда».

**N8 — Сбор фактов.** OpenSSF Scorecard, Qlty CLI, MegaLinter, copier.
Repolinter — **АРХИВИРОВАН**. SonarQube «Clean as You Code» — UX-прецедент drift.

**N9 — Агентный манифест.** AGENTS.md — де-факто стандарт, но прозой; НЕ
машиночитаем. MCP — единственный зрелый путь к программному перечислению команд.
Dagger `dagger mcp` валидирует паттерн.

**N10 — Self-improving агенты.** `self-improving-agent` (markdown в репо) vs
`claude-smart` (SQLite в $HOME + ONNX-эмбеддинги + dashboard). Ни один не
хранит команды в структурированном/исполняемом виде. Позиционирование vdx —
комплементарно: они = «личная память» (проза); vdx = «исполняемый контракт
проекта» (`mise.toml` + MCP + AGENTS.md).

**N11 — Калибровка рубрики по 3 референсам (ручная, 2026-05-22).** Замечание:
утверждение «все capped из-за `ci`» **пересмотрено в N13** после smoke evaluator
(2026-05-23). Остальные находки в силе: PHP nominal-level ≠ effective strictness
(telegram phpstan lvl 0 + bleedingEdge ≈ строже vanilla level 9). TS флаги
ортогональны — ось хранится как набор флагов. PROJECT_CHANGELOG.md —
фактическая конвенция, валидная альтернатива CHANGELOG.md. Mock-server как
docker-сервис + CI-проверка против prod-утечки (bookmap) — L4-паттерн для
`mock-infra`.

**N12 — Smoke-test нативного evaluator на 3 референсах (2026-05-23).**
Запущен v0.1 evaluator из `vdx/cli/` на калибровочных проектах.

| Проект | Manual (v0.2 ручная) | Evaluator v0.1 |
|--------|----------------------|----------------|
| telegram | L2 | **L1** |
| t23b | L2 | **L0** |
| bookmap | L1 | **L1** |

Расхождения трёх типов:
- **A. Ручная калибровка была щедрой** (rubric корректна): telegram не имеет
  bare `build`/`test`/`check` (только `:`-namespaced) — `lifecycle-interface`=L2,
  не L4; telegram без CHANGELOG — `docs`=L2; t23b без `.env.example` —
  `secrets-config`=L1; t23b CI гонит только twig-lint — `ci`=L1.
- **B. Реальные баги evaluator v0.1** (открыты как O22–O24).
- **C. Большинство осей совпадает.**

**N13 — Главный leverage point — `lifecycle-interface`, не `ci` (пересматривает N11).**
Smoke показал: все три проекта capped at L0/L1 главным образом из-за
**отсутствия нормализованного словаря глаголов** (`build`/`test`/`check` bare,
не префиксные/namespaced). Это иронично — `lifecycle-interface` это **именно то,
что vdx решает** генератором `mise.toml` (D3). Предыдущая находка про `ci` —
вторичный фактор. **Главный путь роста зрелости портфеля = установить
нормализованный фасад глаголов через `vdx init`.**

**N14 — Шаг D дотюнил evaluator (2026-05-23).** Закрыты O22 (`config_value`
реализован: JSON/TOML/YAML + ops `present`/`equals`/`gte`/`matches`), O23
(`mock-infra` regex расширен), O24 (`phpstan_present` через `any_of` с fallback
на neon-config). Smoke after:

| Проект | До | После |
|--------|----|-------|
| telegram | L1 | **L2** |
| t23b | L0 | **L1** |
| bookmap | L1 | L1 |

`reproducibility` поднялся до L2 у всех трёх (engines.node / require.php).
`static-analysis` t23b L0→L1 (phpstan-в-CI теперь засчитывается через config).
Bookmap не сдвинулся — `mock-infra` упёрся в delta-style ловушку (см. O25):
Node-стек с mock-as-docker-service не имеет L2-предиката. Главный capping-axis
по-прежнему `lifecycle-interface` (см. N13) — следующий шаг `vdx init`.

**N15 — Шаг E: `vdx init` атакует N13 (2026-05-23).** Реализован
`cli/src/init.ts`: детект стека → scan composer/npm/Makefile-задач → трёхуровневая
эвристика маппинга (exact / canonical alias / prefix-group) → render `mise.toml`
с `[tools]`/`[tasks.*]`/`[vdx]` блоком + `## Commands` секцией в `AGENTS.md`
между маркерами `<!-- vdx:commands -->`. Эффект на копиях:

| project | lifecycle-interface | reproducibility |
|---------|:-------------------:|:---------------:|
| t23b (PHP, 6/6 map) | L2 → **L4** | L2 → L3 |
| bookmap (Node, 3/6 map) | L1 → **L2** | L2 → **L4** |

Bookmap reproducibility прыгнул сразу L2→L4 потому что README уже содержал
`docker compose up` — predicate был true, но не достигался из-за разрыва на L3
(не было `mise.toml`). После init разрыв закрыт ⇒ max непрерывный = L4.
Overall у обоих остался L1 — capping переехал на `static-analysis`/`ci`/`tests`,
ровно как и предсказывалось. `vdx init` подтвердил статус **главного
leverage-инструмента** портфеля.

**N16 — Шаг F: MCP-сервер работает (2026-05-23).** `cli/src/mcp-server.ts`
на `@modelcontextprotocol/sdk@1.29` + `zod@4`, ~200 LOC. Зарегистрированы
9 tools: `list_capabilities`, `vdx_up/down/build/test/check/fix`, `vdx_audit`,
`vdx_record_success_path`. Транспорт — stdio. Запуск: `vdx-mcp --project <path>`
(или из cwd по умолчанию). Smoke на копии t23b прошёл: initialize → tools/list
→ list_capabilities возвращает stack=php, baseline=
`github.com/VoDmAl/vdx-rubric-vodmal@v0.2.1`, все 6 verbs с native commands;
vdx_audit возвращает per_axis JSON по контракту mcp-api.md (lifecycle L4
aligned, остальные gap). Lifecycle-tools — `spawn('mise', ['run', verb])` с
capture stdout/stderr/exit_code/duration_ms. Shared-infra precheck — заглушка
(is_running всегда false). `vdx_record_success_path` использует
`smol-toml.stringify` — round-trip без сохранения комментариев (см. новый O26).

**N17 — Шаг G: Claude Code плагин v0.1 (2026-05-23).** `vdx/plugin/`
содержит: `.claude-plugin/plugin.json` (manifest), `.mcp.json` (регистрирует
vdx-mcp stdio server с `${CLAUDE_PROJECT_DIR}`), `skills/vdx-discover/SKILL.md`
(discover-and-record workflow для агента в новом проекте), `hooks/hooks.json`
+ `scripts/record-success-path.sh` (PostToolUse hook на `vdx_up` — пишет
watermark в `~/.cache/vdx/last-success-path.log`). Установка локальная:
`--plugin-dir` для one-shot или `extraKnownMarketplaces` в
`~/.claude/settings.json` + `/plugin install vdx@vdx-local` для постоянного
подключения. v0.1 ограничения: `.mcp.json` хардкодит абсолютный путь до
`cli/src/mcp-server.ts` (для marketplace релиза нужен npm-пакет `vdx-cli`);
hook пока пассивный (логирование). См. `plugin/README.md`.

### Из догфудинга 2026-05-23

**N18 — Baseline-аудит vdx на самом vdx.** Запущен `vdx audit` против
`/Users/vdm/AI Projects/vdx`. Результат: **stack=`unknown`**, achieved
**L0**, 14/14 осей в gap-режиме. Распределение per-axis:

| Axis | Class | Achieved |
|------|:-----:|:--------:|
| lifecycle-interface | C | L0 |
| tests | C | L0 |
| static-analysis | C | L0 |
| ci | C | L0 |
| reproducibility | s | L0 |
| code-style | s | L0 |
| dependency-hygiene | s | L0 |
| secrets-config | s | L0 |
| git-hygiene | s | L1 |
| observability | s | L1 |
| docs | s | **L3** |
| mock-infra | s | L1 |
| shared-infra | s | L0 |
| shared-infra-drift | s | L0 |

Содержательные находки:

1. **Stack=unknown — структурная проблема, не баг.** vdx имеет
   `cli/package.json`, но детектор смотрит только в корень. Открыто как O28.
   Косвенно бьёт по всем supporting-осям, чьи предикаты опираются на
   `package.json`/`composer.json` (reproducibility, dependency-hygiene, code-style).
2. **`vdx init` на vdx бесполезен в текущем виде** — со stack=unknown
   mapping'ит 0/6 verbs, генерит `mise.toml` с `verbs=[]`. Открыто как O29.
3. **Единственная высокая ось — `docs` L3**, благодаря набору
   `README.md` + `CLAUDE.md` + `HANDOFF.md` + `PROJECT_CHANGELOG.md` + `docs/`.
   Это и единственная неконвенциональная ось — она основана на наличии
   markdown-файлов, не на manifest'ах.
4. **`lifecycle-interface` L0 на самом vdx** — буквальное подтверждение N13.
   Vdx — собственный leverage-кейс: нет нормализованного словаря команд →
   агент не знает что запускать.
5. **Догфудинг как метод подтвердил себя на первом же шаге** — за один
   baseline-аудит появились две новые открытые задачи (O28, O29) и
   калибровочное знание о meta-проектах как отдельном классе.

Следующие действия для самого vdx, в порядке цены/эффекта:
- (1) ручной `mise.toml` с tasks указывающими в `cli/` — закрывает
  lifecycle-interface до L2-L3 и даёт второй аудит для сравнения;
- (2) решить O28 (monorepo detector) — открывает корректный аудит для
  любого dev-hub проекта в будущем;
- (3) решить O29 (init при unknown).

**Вторая итерация: ручной `mise.toml` (stack=meta).** Положен корневой
`mise.toml` с тремя tasks (`build`/`test`/`check`) указывающими в `cli/`,
`[vdx].stack = "meta"`. Аудит после:

| Ось | До | После |
|-----|:--:|:--:|
| stack | unknown | **meta** (из `[vdx]`блока) |
| lifecycle-interface | L0 | **L2** (3 verbs из 6 → at_least_n_of=3) |
| overall | L0 | L0 (capped критическими tests/static/ci) |

Подтверждения и сюрпризы:
- **Evaluator честно читает `[vdx].stack`**, не настаивает на auto-detect.
  Это значит, что декларация stack — валидный механизм override'а
  детектора (полезно для O28).
- **Lifecycle-interface +2 в один Write** — N13 буквально подтверждён ещё
  раз: словарь глаголов это рычаг с самым высоким соотношением
  затрат/эффект на portfolio.
- **Все 3 критических supporting-оси (tests/static-analysis/ci) остались
  L0**. Рубрика для них опирается на stack-специфичные предикаты
  (`vitest`/`jest`/`phpunit`/`tsconfig.json`/`.github/workflows`). На
  meta-проекте без node/php-конвенциональных артефактов в корне они
  никогда не сдвинутся. Открыто как O30.

**Решение: остановить догфудинг на L0-overall, зафиксировать O30 как
открытый, идти решать O28 в следующей итерации.** Дальнейшие инвестиции в
infra vdx (vitest/eslint/CI) — после того как O28/O30 определятся.

**N19 — Шаг I: stack-detector видит depth-1 sub-packages (2026-05-23).**
`autoDetectStack` в `cli/src/facts.ts` теперь делает root-first scan, и если
manifest в корне не найден — ищет в директориях глубины 1 (с игнор-листом
`node_modules`/`vendor`/`dist`/`build`/`out`/`target`/`.git`/`.next`/
`__pycache__`/`.venv`/`venv`/`.cache`/`coverage` + всех скрытых). Если ровно
один тип стека найден — возвращает его (`php`/`node`/`go`/`python`); если
несколько разных — `monorepo`; если ничего — старое `unknown`. Доступна
новая функция `findSubPackages(projectRoot): SubPackage[]` для будущих
sub-package-aware предикатов.

Контрольные точки:
- `npx tsc --noEmit` — чисто.
- Smoke на 3 референсах (telegram/t23b/bookmap) — **никаких регрессий**, все
  три остались на тех же уровнях (L2/L1/L1) и тех же stack'ах (php/php/node).
  Detector root-first гарантирует backward compat для проектов с корневым
  manifest.
- Догфудинг (без `[vdx].stack` декларации в vdx mise.toml): detector
  возвращает **`stack=node`** через `cli/package.json` — раньше было
  `unknown`. Overall остался L0, потому что предикаты всё ещё root-only:
  rubric ищет `eslint.config.*`/`vitest.config.*`/`tsconfig.json` в корне
  vdx, а они в `cli/`. Это **граница O28 ↔ O30**: detector знает, что vdx —
  node-monorepo; предикаты ещё не умеют это использовать.

O28 закрыт частично — detection-сторона работает; sub-package-aware
predicate evaluation остаётся под O30. В текущем `mise.toml` декларация
`[vdx].stack = "meta"` оставлена — это сознательный выбор пользователя
(meta-семантика лучше чем «node» для проекта типа «документация + nested
CLI»), и evaluator её всё равно уважает поверх auto-detect.

**N20 — Шаг J: `applies_to` filter в рубрике v0.2.2 (2026-05-23).** Closed
O30 (опция d из issue). Изменения:
- `Axis.applies_to?: string[]` в `cli/src/rubric.ts`.
- В `cli/src/audit.ts`: перед `evalAxis` проверка — если `applies_to` задан
  и `ctx.stack` не входит, ось получает `drift_kind: 'excluded'`.
- `scoring.projectLevel` filter'ит excluded из visible (как suppressed).
- Новый drift_kind type union в `AxisResult`; symbol `➖` в `report.ts`.
- В canonical-рубрике v0.2.2 помечены `[php, node, go, python]`: tests,
  static-analysis (critical) + code-style, dependency-hygiene, mock-infra
  (supporting). Не помечены: lifecycle-interface, ci, reproducibility,
  secrets-config, git-hygiene, observability, docs, shared-infra,
  shared-infra-drift — они семантически универсальные.
- `metadata.version` приведён к тегу: `"0.2.0"` → `"0.2.2"` (был
  unaligned с v0.2.1 tag, заодно поправлено).
- Bump `DEFAULT_BASELINE` в `cli/src/init.ts` до `@v0.2.2`. Bump
  `baseline` в самом `vdx/mise.toml`.

Контрольные точки:
- `npx tsc --noEmit` — чисто.
- Smoke на 3 референсах: telegram L2, t23b L1, bookmap L1 — **никаких
  регрессий**. applies_to их охватывает (stack=php/node).
- Аудит vdx (stack=meta): 5 осей теперь `excluded` (tests, static-analysis,
  code-style, dependency-hygiene, mock-infra). Overall остался **L0** —
  блокер теперь `ci L0` (vdx буквально не имеет GitHub Actions). Это
  семантически правильный сигнал, а не дефект рубрики: до Шага J L0
  был лживым (3 критические оси врали), теперь L0 показывает реальное
  узкое место — отсутствие CI.

Следующий шаг — реальные тесты + CI для vdx, либо открытое **O31**
(sub-package-aware predicate evaluation), либо переписать README.

⚠️ **GitHub state**: canonical-репо тегнут v0.2.0+v0.2.1; **v0.2.2
тег ещё НЕ создан** и не push'нут на GitHub. Manifest-ссылки
`@v0.2.2` будут резолвиться неполно для downstream-проектов до этого
момента. Локально evaluator грузит из `file:///`, поэтому работает.

**N21 — Шаг K: `primary_subpackage` закрывает O31 (2026-05-23).** Добавлено
optional поле `[vdx].primary_subpackage` в `VdxManifest` (`cli/src/manifest.ts`).
В `cli/src/audit.ts` функция `resolveSubpackageCtx(ctx, manifest)` строит
derived `Ctx` с заменённым `projectRoot`:

1. **Explicit**: если `manifest.primary_subpackage` задан и папка существует —
   использует её. Если не существует — warning на stderr + fallback на root.
2. **Auto-resolve**: иначе `findSubPackages(projectRoot)` — если ровно один
   subpackage совпадает с `ctx.stack` (например stack=node + ровно один
   subpackage с `package.json`) — берёт его. Иначе fallback на root.
3. **Применение**: в основном loop по осям — для оси с `applies_to` используется
   `subpackageCtx`, для остальных — `ctx`. Оси без `applies_to`
   (lifecycle-interface, ci, reproducibility, docs, shared-infra, ...) всегда
   работают от корня — потому что эти артефакты (`.github/workflows/`,
   `README.md`, `docker-compose.yml`) живут в корне даже у monorepo-проектов.
4. **AuditResult**: новое optional поле `primary_subpackage: string` —
   возвращается клиенту (полезно для отчётов).

Owner-рубрика **не меняется** (schema_version=0.2, v0.2.2 актуальна) —
изменение чисто на стороне evaluator + манифеста.

Контрольные точки:
- `npx tsc --noEmit` — чисто.
- Smoke на 3 референсах: telegram L2, t23b L1, bookmap L1 — никаких регрессий
  (у них manifest в корне, `findSubPackages` возвращает пусто → fallback root).
- Dogfooding на копии vdx (`/tmp/vdx-o31-test`): два варианта.
  - `stack=node + primary_subpackage="cli"` (explicit): 5 stack-осей оценены
    через `cli/`. `static-analysis` L2 (tsc strict + tsconfig.json),
    `dependency-hygiene` L1 (package-lock.json), `mock-infra` L1 (always_true),
    `tests` L0 (нет vitest/tests/), `code-style` L0 (нет eslint/prettier
    конфига). Overall остался L0 (capped критическим `tests` + `ci`).
  - `stack=node` без `primary_subpackage` (auto-resolve):
    **идентичный результат** — `findSubPackages()` нашёл единственный `cli/`
    с stack=node, `resolveSubpackageCtx` подхватил его.
- Оригинальный `vdx/mise.toml` (stack=meta) не трогается — для meta-проектов
  5 осей остаются excluded (как после Шага J). Это сознательный выбор:
  vdx сам по себе — meta-репо «документация + nested CLI», и оценивать его
  как обычный node-проект через cli/ — натяжка.

**Семантический результат**: для node/php/go/python-проектов с manifest в
subpackage (типичный паттерн — `cli/`, `api/`, `web/`, `server/`) теперь
evaluator даёт **реальные** уровни вместо false-L0. Это и был последний
блокер «реалистичного аудита» из cycle'а N18→N19→N20→N21.

Шаг K не требует bump'а рубрики — формат рубрики не менялся.
Тег `v0.2.2` push'нут на GitHub 2026-05-23.

**N22 — Шаг L: CI workflow для vdx (2026-05-23).** Добавлен
`.github/workflows/ci.yml` (push на main + pull_request → setup-node@v4 +
`npm ci` + `npm test` в `cli/`). В `cli/package.json` добавлен alias
`"test": "tsc --noEmit"` — нужен и для regex L2 рубрики, и для семантики
«npm test = quality gate».

Effect на vdx audit:

| Ось | До Шага L | После Шага L |
|-----|:--:|:--:|
| ci | L0 | **L3** |
| overall | L0 | L0 |

`ci` поднялся через все три уровня в один Write:
- **L1**: `has_file .github/workflows` ✓
- **L2**: regex `(phpstan\|phpunit\|composer test\|npm test\|jest\|pytest)`
  совпадает с `run: npm test` в yml ✓
- **L3**: `gh_workflow_blocks_pr` (есть workflow с `pull_request` trigger) +
  отсутствие `\|\| true` в yml ✓
- **L4**: требует matrix/sentry-release/check_name=deploy — пока нет.

Overall остался L0, но capping переехал. До Шага J: lying-L0 на критических
осях (5 stack-specific врали). После Шага J: реальный L0 на critical `ci`.
После Шага L: critical всё в порядке (lifecycle L2, ci L3, 3 excluded), но
overall L0 из-за supporting — 4 из 7 на L0 (reproducibility, secrets-config,
shared-infra, shared-infra-drift). Это **правда**: vdx сам не имеет
docker-compose / Dockerfile / Makefile / `.env.example` / traefik-конфига —
он meta-репо с документацией и nested CLI. Рубрика честно это показывает.

Для подъёма vdx до L1 overall нужно либо:
- (a) добавить Dockerfile/Makefile (reproducibility L1) + .env.example
  (secrets-config L2) — это даст 5/7 supporting ≥ L1 = 71%, всё ещё < 80%;
- (b) override-логика: пометить shared-infra/shared-infra-drift как
  suppressed для meta-стека через `.vdx-overrides.yml` (semантически:
  «у meta нет shared-infra, не учитывайте»);
- (c) принять L0 как честную оценку meta-стека и зафиксировать в README.

(c) — наиболее в духе принципа «честный аудит». Откладываем.

Workflow push'нут на GitHub 2026-05-23 — Actions tab активен. Локальный
аудит видит файл независимо от push'а.

**N23 — Шаг M: ci L4 через matrix (2026-05-23).** В `.github/workflows/ci.yml`
добавлен `strategy.matrix.node-version: [20, 22]` + `fail-fast: false`.
Workflow прогоняет typecheck на двух LTS-версиях node. Audit на vdx: `ci`
L3 → **L4** (предикат L4 `file_contains: matrix:` ✓). Overall vdx остался L0
по той же причине (4 supporting-оси на L0 — meta-репо без docker/.env/compose).
**ci — первая ось vdx на max**.

**N24 — Шаг N: CLI как npm package @vodmal/vdx-cli@0.2.0 (2026-05-23).**
Подготовка к publish открыла два класса проблем, ни один из которых не был
очевиден до публикации:

1. **Subpackage publish ≠ subpackage evaluation entry.** `cli/` теперь играет
   обе роли (был только evaluation entry в Шаге K). Для будущих проектов эти
   роли могут разделиться (Python: `src/pkg/` для дев + `dist/*.whl` для
   publish). Открыто как **O34** (release-artifact как новая ось рубрики).

2. **Bundled рубрика — снимок canonical на момент release.** Пакет
   содержит `rubric/vdx-rubric.yaml` (mirror v0.2.2). Снимает зависимость
   npm-installed CLI от наличия локального `vdx-rubric-vodmal`-репо.
   Trade-off: версия bundled-рубрики де-факто связана с версией npm-пакета —
   каждый bump canonical потребует republish CLI. Обход — runtime-загрузка
   из git-ref, но `loadRubric` пока только file paths.

Технический рецепт (publish TypeScript CLI без build, через tsx loader):
1. `tsx` переезжает в `dependencies` (не devDeps).
2. `bin/*.cjs` обёртки: `require('tsx/esm/api').register()` БЕЗ
   `{ namespace: ... }` — namespace изолирует loader так, что type-only
   cross-module exports не резолвятся (был detour в этой сессии).
3. `src/defaults.ts` резолвит bundled-файлы через
   `path.dirname(fileURLToPath(import.meta.url))`.
4. `package.json`: `type: module`, `bin: { vdx: './bin/vdx.cjs', ... }`,
   `files: ['src', 'rubric', 'bin', 'LICENSE', 'README.md']`,
   `publishConfig: { access: 'public' }` (для scoped).
5. Smoke: `npx -y -p @vodmal/vdx-cli vdx` из чистой `/tmp/`-директории —
   подтверждает что плагинный сценарий работает end-to-end.

Эффект на плагин: `plugin/.mcp.json` теперь не зависит от абсолютного пути —
`command: npx, args: ['-y', '-p', '@vodmal/vdx-cli@latest', 'vdx-mcp',
'--project', '${CLAUDE_PROJECT_DIR}']`. Плагин **marketplace-ready** — single-
line install через `~/.claude/settings.json` без локальной копии vdx.

Open после Шага N: **O33** (subpackage stack lift для applies_to-осей) и
**O34** (release-artifact ось). Audit vdx не изменился (overall L0,
14 осей те же значения) — publish не трогает рубрику.

**N25 — Шаг O: O33 закрыт через stack lift в subpackage-ctx (2026-05-23).**
Изменения в `cli/src/`:

1. `facts.ts`: `stackForDir(dir)` экспортирован (был private).
2. `audit.ts/resolveSubpackageCtx`:
   - explicit `primary_subpackage`: detect actual stack через `stackForDir(abs)`;
   - auto-resolve: если matching по `ctx.stack` пуст и `subs.length === 1` —
     adopt single subpackage любого стека (новая логика O33);
   - возвращаемый `subpackageCtx.stack` = stack subpackage'a (не root).
3. `audit.ts` loop: `evalCtx` определяется первым, проверка `applies_to`
   сравнивается с `evalCtx.stack` (а не `ctx.stack`).

**vdx-self-audit ДО → ПОСЛЕ:**

| Ось | До O33 | После O33 |
|-----|:--:|:--:|
| tests (C) | excluded | **L0** (gap, правдиво — нет vitest) |
| static-analysis (C) | excluded | **L2** (tsc strict в cli/) |
| code-style (S) | excluded | L0 (нет eslint/prettier) |
| dependency-hygiene (S) | excluded | **L1** (lockfile есть) |
| mock-infra (S) | excluded | **L1** |
| overall | L0 (4 supporting capping) | L0 (tests=C + supporting capping) |

**Семантический сдвиг**: O33 — это не лифт оценки, а **fix integrity**.
До: 5 осей маскировались `excluded`, не учитывались в scoring → overall L0
capping был на 4 supporting-L0. После: маска снята, появилась реальная
критическая планка `tests=L0` (которая до этого была невидима). Путь к
L1 overall теперь требует реальные тесты (vitest), а не просто 1-2
supporting-фикса. Это правильная семантика — рубрика должна быть честной.

Smoke на 3 референсах без регрессий (telegram L2 / t23b L1 / bookmap L1).
Каждый из этих проектов имеет manifest в корне → ctx.stack === root, нет
nested subpackages → нечего lift'ить.

Edge case (потенциальная регрессия): репо с manifest в корне + один
nested subpackage с другим стеком. До O33: applies_to-оси оценивались
на root (где manifest есть). После O33: всё ещё на root (так как `matching
=== 1` срабатывает первым — есть match по ctx.stack). Логика "adopt
single non-matching subpackage" работает только когда matching пуст. ОК.
