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
- **O28** — Stack-detector в monorepo / meta-репо. `autoDetectStack` смотрит
  только в корень проекта; если manifest (`package.json`/`composer.json`/`go.mod`)
  лежит в sub-пакете (как `vdx/cli/package.json`), детектор возвращает
  `unknown` и downstream init/audit теряют 70% сигнала. Опции: (a) глубина-1
  scan под корнем с агрегатом stack=mixed; (b) флаг `--manifest-root <path>`
  или поле в `.vdx-overrides.yml`; (c) поддержать особый stack=`meta` для
  документационных/dev-hub репо (vdx сам, docs-only репо), где конвенциональные
  предикаты не применяются. Открыт догфудингом на vdx (N18).
- **O29** — Поведение `vdx init` при stack=unknown. Сейчас генерится почти
  пустой `mise.toml` (`stack="unknown"`, `verbs=[]`) — корректно, но не полезно
  пользователю: нет mapping'а нативных задач, нет шансов поднять
  `lifecycle-interface` без ручной правки. Опции: (a) явно прервать с
  подсказкой передать `--stack <id>`; (b) интерактивный prompt (выбивается из
  «нет TTY» сценариев MCP); (c) ничего не делать (status quo) — пусть user
  правит `mise.toml` руками; (d) для stack=meta заюзать специальные `description-only`
  плейсхолдеры, чтобы хоть verb-имена были видны в AGENTS.md. Связан с O28.
- **O30** — Стек-нейтральные предикаты для `stack: meta`. Текущая рубрика
  v0.2.1 на критических осях (`tests`, `static-analysis`, `ci`) и большинстве
  supporting опирается на stack-специфичные артефакты (`vitest`/`phpunit`/
  `tsconfig.json`/`.github/workflows/*.yml`). Meta-проекты типа vdx —
  документация + nested CLI — на таких осях всегда L0 даже когда инструмент
  внутри cli/ полностью покрыт. Опции: (a) добавить меta-специфичные level-
  предикаты (e.g. `tests`: «есть исполняемый `cli/smoke.sh` ИЛИ test runner
  в любом sub-package»); (b) рекурсивная агрегация — оценить cli/ как
  sub-проект и поднять scores наверх; (c) принять как фичу — meta-проекты
  capped на нейтральных осях, это правильное сообщение про инвестицию в
  собственную инфру; (d) ввести `applies_to: [php, node, go]` фильтр на ось,
  чтобы для meta-стека ось `excluded` а не «L0». Догфудинг N18 показал, что
  опция (c) самая дешёвая и не размывает рубрику; (d) даёт более честный
  отчёт без false-L0; (a) и (b) усложняют логику движка.

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
