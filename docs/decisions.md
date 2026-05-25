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

### D12 — `publish` как 7-й lifecycle verb, lib-gated, subverb-style
Дата: 2026-05-24 · Research: [docs/research/publish-deploy.md](research/publish-deploy.md)

vdx core словарь расширен с 6 до 7 глаголов: + `publish`. Применяется к
библиотекам (`applies_when: lib intent` — переиспользует O35 сигналы:
Node `!private + bin/main/exports/module/publishConfig`; PHP composer
`type ≠ project`; и т.п.). Apps получают error + указатель на будущий
`vdx deploy` (D13).

**Subverb-style** (вдохновлено пользовательским паттерном `build:db:migration`):
- `vdx publish [patch|minor|major]` — full default pipeline (vdx
  институциализирует stack-specific impl: Node = `npm version X && npm publish && git push --follow-tags`;
  PHP = edit composer.json + git tag + push; Python = build + twine + tag).
  Транзакционно: bump→pre-flight→upload→commit/tag/push в одной
  операции с rollback при upload-failure.
- `vdx publish:bump <spec>` — only bump version.
- `vdx publish:upload` — only push artifact.
- `vdx publish:tag` — only git tag + push --tags.
- `vdx publish:notes` — only generate release notes.

**Pre-flight gating** через рубрику (новый use case — рубрика становится
**executable contract**):
- `rubric.tests < L2` → error
- `rubric.release-artifact < L3` → error
- `rubric.ci < L2` → error (с `--no-ci-check` opt-out)
- `working_tree.dirty` → error
- `published_version >= local_version` → error (registry collision)
- `git.head_commit != git.tag(version)` → **warning** by default, `--strict` для error (skipped когда arg-form задаёт version в pipeline)

`--force` обходит refuses_if (для escape-hatch false-negatives applies_when).
`[tasks.publish]` в `mise.toml` overrides default vdx pipeline (D3
escape hatch). Conventional-commits — **opt-in**, auto-detect с
threshold; используется для CHANGELOG/notes если есть.

**Monorepo** — defer. MVP делает single-package; для `.changeset/` —
proxy в существующие tools. Native monorepo-aware publish — D14+.

**Phasing implementation**:
- **Phase 1 (MVP)** — Node only (наш own use case: vdx-cli).
- **Phase 2** — PHP + Python defaults.
- **Phase 3** — Cargo, Ruby, Go, Java.
- Sub-verbs parallel с phases.

**Связанные deferred items**: O36 (release-workflow ось — после ship +
N≥3 lib calibration), O37 (`vdx bump` как отдельный 8-й verb, если
поле-feedback покажет необходимость cross-stack normalized bump).

**Архитектурный riск D7** (vocabulary fix at 6) — mitigated через
extension protocol: minor `schema_version` bump, `applies_when`
defaults, backward-compat (старые manifests без `publish` continue
работать).

См. полный research, OQ1-OQ7 resolutions и landscape в
[docs/research/publish-deploy.md](research/publish-deploy.md).

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
- ~~**vitest для evaluator**~~ — закрыто 2026-05-24 (Шаг P). См. N26.
- ~~**O35**~~ — закрыто Шагом S 2026-05-24 (см. N29, рубрика v0.3.1).
- ~~**D12**~~ — закрыто 2026-05-24 как Decided (см. секцию выше).
- **O36** — `release-workflow` ось (orthogonal к `lifecycle-interface`).
  Открыто 2026-05-24 как deferred-after-D12 (см. OQ2 в research-doc).
  Измеряет качество release-процесса (automated CHANGELOG, semver
  enforcement, idempotency, signing). L1: documented release script;
  L2: + automated CHANGELOG; L3: + semver enforcement (conventional-commits
  linted); L4: + signing/provenance (Sigstore/GPG/npm provenance/PyPI
  Trusted Publishing). Условие добавления: D12 implementation ship'нут +
  N≥3 lib-проектов для калибровки.
- **O37** — `vdx bump` как 8-й lifecycle verb (вместо subverb формы).
  Открыто 2026-05-24 как deferred (см. OQ4 в research-doc). Сейчас bump
  в scope D12 через subverb `vdx publish:bump` и arg-form
  `vdx publish patch|minor|major`. Если поле-feedback покажет, что
  пользователи хотят cross-stack normalized bump **отдельно** от
  publish (например, для preview-deploys без publish) — выделяем как
  отдельный verb.
- **O38** — Native monorepo-aware `vdx publish` (D14+). Открыто
  2026-05-24 как deferred (см. OQ6 в research-doc). MVP D12 делает
  single-package; для известных layouts (`.changeset/`, pnpm
  workspaces) — proxy в existing tools. Native dependency-aware
  ordering, batched git tags, per-package CHANGELOG — после
  появления реальных monorepo в портфолио + закрытия O32.
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
- ~~**O29**~~ — закрыто Шагом T 2026-05-24 (см. N30).
- **O32** — Multi-subpackage monorepo (разные стеки в разных папках). Шаг K
  закрыл O31 одним полем `primary_subpackage` — но это **одно** subpackage на
  проект. Для гибрида типа `php-api/ + node-web/` (где tests/static-analysis
  должны оценивать оба) текущая модель даёт уровень только одного. Опции:
  (a) расширить поле до массива `primary_subpackages: ["php-api", "node-web"]`
  с aggregate-стратегией (`min`/`max`/`avg`); (b) per-axis маппинг в манифесте
  `[vdx.subpackages] tests = "php-api"`; (c) принять как ограничение —
  multi-stack monorepo использует override на оси. Реальных пользователей с
  таким раскладом пока нет — отложено до появления.
- ~~**O34**~~ — закрыто Шагом R 2026-05-24 (см. N28, рубрика v0.3.0).
- **O40** — Rubric-driven `vdx doctor` (long-term architectural). Шаг Z
  (2026-05-24) реализовал `vdx doctor` как hardcoded checks-array в
  `cli/src/doctor.ts` (Node/git/mise/npm-auth/container-runtime/Claude-Code-plugin)
  по YAGNI-принципу. Концептуально doctor близок к audit: тоже набор
  предикатов с outcome'ами. Open: мигрировать на rubric-driven схему —
  внешний `vdx-environment.yaml` с YAML-описанием checks, переиспользовать
  `evaluator.ts` + `predicates.ts`, добавить новые predicates
  (`binary_in_path`, `version_at_least`, `file_contains_in_home`).
  **Триггер**: N≥10 checks или потребность пользовательской кастомизации
  через `~/.vdx-environment.yaml`. **Развилка**: либо rubric раздваивается
  на project-axes и environment-checks (два shape), либо унификация через
  axes с simplified-levels (binary present + optional version-level).
  Решение откладывается до накопления реальных use-case'ов от живого
  использования doctor.
- **O41** — `vdx doctor --fix` (auto-remediation mode). После Z.3 (cli-table3
  rework, 2026-05-25) пользователь отметил, что текстовые `remedy` в
  таблице — это «копировать руками неудобно; зачем такие remedy, когда
  он [vdx] может попробовать сам всё исправить». Пример: для
  `claude-plugin warning` правильный flow — это две Claude Code команды
  (`/plugin marketplace add VoDmAl/vdx` + `/plugin install vdx@vdx`),
  которые vdx может выполнить сам, если ему дали Claude Code на PATH.
  Open вопросы: (a) границы «безопасно auto-fix» vs «требует
  подтверждения» (npm i -g трогает global, alias правит ~/.zshrc — оба
  side-effects на пользовательский env); (b) per-check fix-стратегия —
  каждый check описывает свой `fix()` (parallel hardcoded checks-array)
  или fix описывается декларативно в YAML (зависит от O40); (c)
  interactive vs `--yes` flag; (d) idempotency contract — `--fix`
  второй раз не должен дублировать alias-line. **Триггер**: после ≥1
  итерации О40 (rubric-driven doctor), или раньше — если копирование
  remedy станет постоянной болью.

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
| O34 | Шаг R 2026-05-24 — Добавлена ось `release-artifact` (supporting, `applies_to: [node, php, ruby, python]`) в canonical-рубрику v0.3.0. L1: required-поля (name+version+license / name+license). L2: + description+repository+LICENSE. L3: + files+entry-point / autoload+type. L4: + publishConfig+homepage+bugs / extra.publish. Эффект на vdx: release-artifact L4 на cli subpackage (cli уже publish-ready). Эффект на референсы: telegram L2→L1 регрессия (PHP app не publish-ready) — fair signal, design issue открыт как O35. См. N28. |
| O35 | Шаг S 2026-05-24 — В `Axis` добавлено optional поле `applies_when: <Predicate>`. В `audit.ts` после `applies_to`-фильтра evaluator проверяет `applies_when` относительно `evalCtx`; если predicate=false → `drift_kind: excluded` (та же семантика, что и `applies_to`-non-match). Применено к `release-artifact` в canonical-рубрике v0.3.1: any_of [Node lib signal (НЕ private + bin/main/exports/module/publishConfig), PHP lib signal (composer.json + name + type≠project)]. Эффект на референсы: telegram восстановлен L1→**L2** (release-artifact теперь excluded, capping вернулся к ci), t23b/bookmap unchanged. Эффект на vdx-cli (subpackage): release-artifact остаётся L4. См. N29. |
| O29 | Шаг T 2026-05-24 — `vdx init` получил три улучшения: (a) опциональный override `--stack <id>` (`planInit({stack})`), (b) для `stack=meta` авто-резолв `primary_subpackage` через `findSubPackages()` если найден ровно один nested manifest + scanning тасков и tools на subpackage-ctx, (c) ясные warnings в STDERR + TODO-комментарий в сгенерированный `mise.toml` при stack=unknown/monorepo без override. `InitPlan` расширен полями `stackOverridden`/`primarySubpackage`/`warnings`. Для meta runCommand префиксится `cd <subpackage> &&`. Smoke: vdx (как meta) генерит `primary_subpackage="cli"` + `run = "cd cli && npm run test"`. См. N30. |

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

(Снято после push'a v0.2.2 — см. позднейшую отметку в шаге J.)

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

**N26 — Шаг P: vitest на evaluator, tests axis L0 → L3 (2026-05-24).**
Добавлен vitest + 47 unit-тестов на pure-модули `scoring.ts` (16 кейсов:
delta-style levels, weighted flags, projectLevel weighted_two_class) и
`predicates.ts` (31 кейс через фикстуры `tests/fixtures/node-with-vitest`,
`php-with-phpstan`, `empty`). Конфиг: `cli/vitest.config.ts` + scripts
`test`, `test:unit`, `coverage` в `package.json`. `test` теперь = `vitest
run` (вместо `tsc --noEmit`), typecheck вынесен отдельной командой.
`.github/workflows/ci.yml` обновлён: typecheck и unit tests как два
раздельных шага в CI.

**vdx-self-audit ДО → ПОСЛЕ (stack=meta, primary_subpackage=cli):**

| Ось | До Шага P | После Шага P |
|-----|:--:|:--:|
| tests (C) | L0 (нет vitest) | **L3** |
| overall | L0 | L0 |

`tests` прошёл три уровня одним коммитом:
- L1: `package_present: { name: vitest, ecosystem: npm }` ✓
- L2: `has_task: test:unit` ✓
- L3: `has_task: coverage` ✓
- L4: e2e/mutation/playwright — overkill для CLI, не идём.

**Семантический сдвиг overall L0 (без изменения числа)**: capping
переехал с `tests=C L0` на supporting. После Шага P 5 из 10 supporting
осей остаются на L0 (reproducibility, code-style, secrets-config,
shared-infra, shared-infra-drift) — 5/10 = 0.5 < 0.8 supporting_threshold
→ overall L0. Чтобы поднять до L1 теперь нужно добить 3 supporting
оси (`.env.example` → secrets-config; eslint+prettier → code-style;
Makefile/Dockerfile → reproducibility), а не критические — это сильно
другая работа, чем добивать tests.

Smoke на 3 референсах без регрессий (telegram L2 / t23b L1 / bookmap L1).
Vitest добавлен только в `cli/devDependencies`, в `files`-whitelist
не входит (только `src`, `rubric`, `bin`, `README.md`, `LICENSE`) —
published npm-пакет не толстеет.

**N27 — Шаг Q: supporting лифт + overrides, overall L0 → L1 (2026-05-24).**
Добавлены три минимальных артефакта плюс per-project overrides:

1. `Makefile` в корне vdx — `build`/`test`/`check`/`audit`/`smoke`
   таргеты как алиасы на `mise run` или `npm` команды внутри `cli/`.
   Делает `reproducibility` L1 (предикат `has_file: Makefile`).
2. `cli/.editorconfig` — `root = true` + UTF-8/LF/2-space defaults +
   tab override для Makefile. Subpackage-ctx из Шага K направляет
   ось `code-style` на cli/, поэтому конфиг лежит там, не в root.
   Делает `code-style` L1 (предикат `has_file: .editorconfig`).
3. `.vdx-overrides.yml` в корне — три `suppress: true` для осей,
   которые описывают класс проектов, в который vdx не входит:
   - `secrets-config` — vdx-CLI не имеет runtime env-config (только
     опциональный `VDX_RUBRIC`, документирован в cli/README.md);
   - `shared-infra` — vdx не сервис, не потребляет shared reverse
     proxy / external networks;
   - `shared-infra-drift` — нет `misc/traefik-global/`, ось не
     применима (sub-axis работает только при наличии копии).

**vdx-self-audit ДО → ПОСЛЕ:**

| Ось | До Q | После Q |
|-----|:--:|:--:|
| reproducibility (S) | L0 | **L1** (Makefile) |
| code-style (S) | L0 | **L1** (.editorconfig) |
| secrets-config (S) | L0 | **suppressed** |
| shared-infra (S) | L0 | **suppressed** |
| shared-infra-drift (S) | L0 | **suppressed** |
| mock-infra (S) | L1 | **L2** (case-insensitive FS, см. ниже) |
| **overall** | **L0** | **L1** |

Supporting visible после suppression: 7 (вместо 10). Все 7 на L1+ →
ratio = 1.0 ≥ 0.8 threshold по D7. Critical min L2 — выше L1.
Smoke на 3 референсах без регрессий (telegram L2 / t23b L1 / bookmap L1).

**Наблюдение N27a — case-insensitive FS даёт false positive на macOS**.
`mock-infra` L2 предикат `has_file: tests/Fixtures` (capital F) совпал с
`cli/tests/fixtures/` (lowercase) из-за case-insensitive APFS. На Linux
CI этот match не сработает, `mock-infra` вернётся к L1. Overall L1
сохранится в любом случае (supporting margin 1.0 → 0.857 = 6/7 при
выпадении одной оси, всё ещё ≥ 0.8). Решение: оставить как есть.
Альтернатива — переименовать фикстуру (`tests/Fixtures` → `tests/case-fx`),
но рубрика-предикат сам по себе хрупкий — он завязан на PHP-конвенцию
PSR-4 capital-cased директорий, и спорить с case sensitivity FS на
evaluator-уровне не стоит. Возможно стоит в спеке предикатов сделать
`has_file` case-sensitive явно (через `fs.readdirSync` + сравнение
имён), но это отдельная задача — открыто как наблюдение, не задача.

**Семантика L1**: vdx теперь дотягивается до **«reproducible»**
уровня — есть один документированный путь (`make build`/`make test`),
есть единый стиль (.editorconfig для cli/), знание о неприменимых
осях зафиксировано в overrides. Это первая реальная overall-планка
vdx после A–P (где capping был сначала на 4 supporting-L0, потом на
tests-L0, теперь на 5 supporting-L0 ушёл за overrides).

**Что не сделано**: эталонной planке L2 нужно 6/7 supporting на L2+
(сейчас только docs L3 и mock-infra L2 = 2/7 = 0.29). Чтобы L2:
prettier+eslint конфиг → code-style L2; engines.node на root-уровне
(не cli/) → reproducibility L2; mock-infra стабильно через msw → L2
на Linux тоже. Это сильно больше работы — отложено.

**N28 — Шаг R: O34 закрыт через ось `release-artifact`, рубрика v0.3.0 (2026-05-24).**
Новая ось `release-artifact` (supporting, `applies_to: [node, php, ruby,
python]`) добавлена в canonical-рубрику. Уровни:

- **L1**: required-поля (`name`+`version`+`license` для npm;
  `name`+`license` для composer).
- **L2**: + `description`+`repository`+LICENSE-файл (npm) или
  `description`+LICENSE (composer).
- **L3**: + `files` whitelist + entry-point (`bin`/`main`/`exports`) —
  npm; `autoload`+`type` — composer.
- **L4**: + `publishConfig`+`homepage`+`bugs` — npm;
  `extra.publish` — composer.

`metadata.version` bumped `0.2.2` → `0.3.0`. Mirror'нуто в
`cli/rubric/vdx-rubric.yaml` (bundled) и `docs/specs/vdx-rubric.example.yaml`.
`DEFAULT_BASELINE` в `cli/src/init.ts` → `@v0.3.0`. README'и обновлены.

**Эффект на vdx (cli subpackage)**: release-artifact **L4** — все
четыре уровня. cli/package.json уже имел все нужные поля
(publishConfig.access, homepage, bugs) из подготовки к публикации на
npm. Это первая ось vdx, которая дошла до L4 благодаря публикации;
ci L4 был через `matrix.node-version`, release-artifact L4 — через
**факт публикации**. Overall vdx сохранился L1 (8/8 supporting на L1+).

**Эффект на калибровочные референсы (РЕГРЕССИЯ telegram)**:

| project | до v0.3.0 | после v0.3.0 | release-artifact |
|---------|:--:|:--:|:--:|
| telegram (PHP) | L2 | **L1** | L1 (no publish metadata) |
| t23b (PHP) | L1 | L1 | L1 |
| bookmap (Node) | L1 | L1 | L1 |

Telegram упал L2→L1 потому что новая supporting ось добавилась в
counting (10 → 11 supporting), а у telegram release-artifact = L1.
Раньше для L2 был достаточен ratio supporting ≥ L2 ≥ 0.8, теперь
release-artifact L1 валит supporting на L2. **Это правда** —
telegram это PHP-приложение без publish-lifecycle.

**Design issue → O35**: ось применяется слишком широко.
`applies_to: [node, php, ...]` ловит и библиотеки, и приложения.
Не каждый node-проект публикуется — для апов release-artifact
сейчас даёт fair-but-noisy сигнал, а должен либо excluded, либо
self-skipped. Нужен `applies_when: <predicate>` или auto-detection
"app vs library" (например `package.json.private == true` →
excluded; `composer.json.type` отсутствует или `"project"` →
excluded). Workaround сейчас: апп-проекты suppress'ят
`release-artifact` через `.vdx-overrides.yml`. Открыто как O35.

**Семантика семвер-bump'а**: minor (0.2.2 → 0.3.0), а не patch —
новая ось это **новая фича рубрики**, изменение поведения для
проектов, которые попадают под `applies_to`. Не breaking — старые
manifest-ссылки `@v0.2.2` продолжают работать на старой рубрике
без оси. Major bump зарезервирован для переименований/удалений
осей или изменения `schema_version`.

Smoke на 3 референсах **выявил design issue (telegram regression)**
до публикации тега — это правильный workflow: concrete instance
ловит abstract flaw (паттерн s1-72). Тег `v0.3.0` push'ится после
коммита.

**N29 — Шаг S: O35 закрыт через `applies_when`, рубрика v0.3.1 (2026-05-24).**

Изменения в evaluator (`cli/src/`):

- `rubric.ts`: в `Axis` добавлено optional поле
  `applies_when?: Predicate`. Тип `Predicate = unknown` (тот же DSL,
  что и `levels.LN.requires`), парсер не трогался.
- `audit.ts`: в audit loop после `applies_to`-фильтра новый шаг —
  `if (axis.applies_when && !evalPredicate(axis.applies_when, evalCtx))
  → drift_kind: excluded`. Использует `evalCtx` (тот же, что для
  предикатов оси), а не root ctx — это важно для проектов с
  subpackage'ем (vdx).

Изменения в canonical-рубрике v0.3.1:

```yaml
- id: release-artifact
  applies_to: [node, php, ruby, python]
  applies_when:
    any_of:
      # Node lib: НЕ private + entry-point/publish-signal
      - all_of:
          - has_file: package.json
          - not: { config_value: { path: package.json, jsonpath: private, equals: true } }
          - any_of:
              - config_value: { path: package.json, jsonpath: publishConfig, op: present }
              - config_value: { path: package.json, jsonpath: bin,           op: present }
              - config_value: { path: package.json, jsonpath: main,          op: present }
              - config_value: { path: package.json, jsonpath: exports,       op: present }
              - config_value: { path: package.json, jsonpath: module,        op: present }
      # PHP lib: composer.json + name + type ≠ project
      - all_of:
          - has_file: composer.json
          - config_value: { path: composer.json, jsonpath: name, op: present }
          - not: { config_value: { path: composer.json, jsonpath: type, op: equals, equals: project } }
```

**Эффект на калибровочные референсы (smoke verified)**:

| project | release-artifact до v0.3.1 | после v0.3.1 | overall |
|---------|:--:|:--:|:--:|
| telegram (PHP app, `type: project`) | L1 | **excluded** | L1 → **L2** (восстановлен) |
| t23b (PHP app, `type: project`) | L1 | **excluded** | L1 (unchanged) |
| bookmap (Node app, `private: true`) | L1 | **excluded** | L1 (unchanged) |
| vdx (meta, subpkg=cli, Node lib) | L4 | **L4** aligned | L1 (unchanged) |

Telegram восстановлен — `release-artifact` excluded возвращает
overall к L2 (capping снова на ci). Это закрывает регрессию из N28.
vdx-cli держит L4: имеет `bin`+`publishConfig`+`!private` — все
сигналы lib-intent присутствуют.

**Semver**: patch (0.3.0 → 0.3.1) — bugfix design issue из N28, без
breaking change. Manifest-ссылки `@v0.3.0` продолжают работать без
applies_when (apps получают L1 как раньше); проекты могут поднять
ссылку до `@v0.3.1` чтобы получить чистый excluded.

**Дизайн-выбор positive signals only**: applies_when формулирован
как detection lib-intent (имеется ли намерение публиковать), а не
detection app-state. Преимущество: новые сигналы (например
`module` для ESM-only) легко добавлять `any_of`-веткой;
недостатки — проекты без явных сигналов (PHP lib без `type`
declaration — default library) корректно проходят через
`type ≠ project` (negation, не equality).

**Тестирование**: 5 новых unit-тестов в `cli/tests/unit/audit.test.ts`
+ 2 новые фикстуры (`node-publishable-lib`, `php-app-project`).
Покрытие: Node lib evaluated, Node app excluded, PHP lib evaluated,
PHP app excluded, `applies_to` срабатывает раньше `applies_when`
(unrelated stack остаётся excluded). Все 52 теста (47 старых + 5 новых)
проходят.

**O35 (alternative considered)**: введение ось-агностичного факта
`project_kind: 'app' | 'lib' | 'meta'` через `facts.ts` (как
`autoDetectStack`). Это было бы полезно и для других осей (mock-infra,
secrets-config). Решено НЕ делать сейчас по принципу YAGNI: пока
только одна ось требует app/lib различения, predicate-based
гейтинг компактнее. Если появится 2+ оси с тем же требованием —
вынести в `project_kind` факт.

**N30 — Шаг T: O29 закрыт через `vdx init --stack` + meta-subpackage handling (2026-05-24).**

Три изменения в `cli/src/init.ts` + `cli/src/index.ts`:

1. **`planInit(projectRoot, { stack?, baseline? })`** — добавлен
   optional `stack` override. CLI: `vdx init <path> --stack <id>`.
   Когда задан И отличается от `autoDetectStack` → ставится
   `stackOverridden: true`, warnings подавляются (вы знаете, что
   делаете).

2. **`stack=meta` ветка** — при detected/forced `meta` вызывается
   `findSubPackages(projectRoot)`:
   - Ровно 1 subpackage → ставится `primarySubpackage`, scanning
     тасков (`listAllTasks`) и pkgManager-detection идут на
     subpackage-ctx (`scanRoot = projectRoot/subpkg`), `scanStack`
     = subpackage'a stack. В `[vdx]` блок mise.toml записывается
     `primary_subpackage = "..."`. `runCommand` для каждого verb
     префиксится `cd <subpkg> &&` (через helper
     `renderRunCommandInSubpackage`).
   - 0 subpackages → warning "stack=meta, nested manifest не найден".
   - >1 subpackages → warning со списком, primary не выбран.

3. **Warnings + TODO comment** — при detected `unknown`/`monorepo`
   без override planInit добавляет warnings в `InitPlan.warnings`.
   `renderMiseToml` для этих stack'ов вставляет TODO-комментарий
   перед `[vdx]` блоком. `cmdInit` печатает warnings в STDERR.

`InitPlan` интерфейс расширен полями: `stackOverridden: boolean`,
`primarySubpackage: string | null`, `warnings: string[]`.

**Smoke verified**:

| сценарий | результат |
|----------|-----------|
| `vdx init /tmp/empty` | stack=unknown, warning, TODO в mise.toml, verbs=[] |
| `vdx init /tmp/empty --stack node` | stack=node, no warning, no TODO, verbs=[] (пустая дир) |
| `vdx init <repo> --stack meta` (с single subpkg) | stack=meta, primary_subpackage=cli, runCommand=`cd cli && npm run test`, verbs=["test"] |

**Тесты**: 5 новых unit-тестов в `cli/tests/unit/init.test.ts`:
- unknown без override → warning + TODO
- unknown + override → no warning
- meta + empty → warning "nested manifest не найден"
- meta + single subpkg фикстура (`meta-single-subpkg/api`) →
  primary_subpackage + `cd api && ...` runCommand
- regression: node fixture без override работает как раньше

Все 57 тестов (52 + 5 init) проходят.

**Дизайн-выбор `cd <subpkg> &&` для meta runCommand**:
Альтернатива `mise run -C <subpkg>` требует `mise.toml` в subpkg —
нет смысла дублировать. `cd && ...` — universal, работает с любым
shell-runner'ом mise (default sh).

**Альтернатива не выбрана — интерактивный prompt при unknown**:
plan'ировался как опция (b) в O29, но отвергнут потому что vdx
запускается в MCP/CI без TTY. Warning-and-continue даёт worka из
обеих сторон: user видит сигнал, autonomous-сценарий получает stub
для дальнейшего ручного редактирования.
