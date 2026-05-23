# Журнал изменений проекта

Значимые изменения vdx. Формат записи: заголовок + 1–2 предложения + ссылки.

## 2026-05-23

### Шаг F: MCP-сервер vdx (9 tools) работает
`cli/src/mcp-server.ts` (~200 LOC) на @modelcontextprotocol/sdk@1.29 +
zod@4: stdio-транспорт + 9 зарегистрированных tools (list_capabilities,
6×lifecycle vdx_*, vdx_audit, vdx_record_success_path). Smoke на t23b-копии:
initialize+tools/list+list_capabilities+vdx_audit все вернули корректный
JSON по контракту mcp-api.md. Запуск: `vdx-mcp --project <path>` или из
cwd. Открыты O26 (TOML round-trip без потери комментариев), O27 (реальный
shared-infra precheck). См. [docs/decisions.md](docs/decisions.md) N16,
[cli/src/mcp-server.ts](cli/src/mcp-server.ts).

### Инициализирован git-репо vdx + workflow для двух репо
`git init` в `/Users/vdm/AI Projects/vdx` (commit 119b15b, 30 файлов).
В CLAUDE.md добавлена секция «Внешний репо: vdx-rubric-vodmal» с правилами
синхронизации: canonical-файл правится в vdx-rubric-vodmal, mirror в
docs/specs/vdx-rubric.example.yaml, semver-bump при изменении canonical.

### Шаг E: реализован `vdx init` — главный leverage-инструмент (N13)
Новый модуль `cli/src/init.ts` (~280 LOC): автодетект стека + три-уровневая
эвристика маппинга composer/npm/Makefile-задач в стандартные 6 глаголов
(up/down/build/test/check/fix), генератор `mise.toml` с `[tools]`/`[tasks.*]`/
`[vdx]` блоком и `## Commands` секции в `AGENTS.md` между маркерами.
Команда `vdx init <path>` поддерживает `--dry-run`, `--force`, `--baseline`.
Verify на копиях: t23b lifecycle L2→L4, reproducibility L2→L3; bookmap
lifecycle L1→L2, reproducibility L2→L4 (прыжок через ранее «разорванный» L3).
См. [docs/decisions.md](docs/decisions.md) N15, [cli/src/init.ts](cli/src/init.ts).

### vdx-rubric-vodmal v0.2.1 опубликован на GitHub
Внешний репо переехал в **github.com/VoDmAl/vdx-rubric-vodmal** (public).
Manifest-ссылки теперь могут использовать
`baseline: github.com/VoDmAl/vdx-rubric-vodmal@v0.2.1`.

### Шаг D: дотюнен evaluator v0.2 (O22/O23/O24 закрыты)
Реализован `config_value` в `cli/src/predicates.ts` (JSON/TOML/YAML lookup +
operators `present`/`equals`/`gte`/`matches`); добавлены `readYaml`/`readStructured`/
`resolveConfigPath` в `cli/src/facts.ts`. В `vdx-rubric-vodmal/vdx-rubric.yaml`
расширены: regex `mock-infra` L3 (теперь матчит `mock-bookmap-api` и подобные)
и flag `phpstan_present` (любой из composer-пакета или конфига `phpstan*.neon`).
Smoke: telegram **L1→L2**, t23b **L0→L1**, bookmap L1 (упёрся в delta-ловушку
mock-infra — заведён O25). Главный capping-axis остаётся `lifecycle-interface`
(N13) → следующий Шаг E: `vdx init`. См. [docs/decisions.md](docs/decisions.md)
закрытые O22/O23/O24 + N14, [HANDOFF.md](HANDOFF.md).

### Создан HANDOFF.md для продолжения в новой сессии
Top-level [HANDOFF.md](HANDOFF.md) — карта артефактов, принятые решения,
главные находки, гочи, 4 предложенных следующих шага (D/E/F/G), полезные
команды. CLAUDE.md теперь ссылается на HANDOFF в самом верху для новых сессий.

### Шаг C: нативный evaluator v0.1 (TS), smoke на 3 референсах, главная находка
В `vdx/cli/` написан минимальный TS evaluator (~600 LOC): YAML rubric loader,
mise.toml/composer/npm/Makefile tasks aggregator, 11 предикатов (3 заглушки),
delta-style уровни, D7 скоринг, markdown-отчёт. Smoke-результат: telegram L1,
t23b L0, bookmap L1 — ниже моей ручной калибровки. Главная находка (N13):
**главный leverage point — `lifecycle-interface`, не `ci`** (все capped
отсутствием bare-глаголов `build`/`test`/`check`). Это иронично — именно то,
что vdx и решает. Открыты O22-O24 (баги/расширения evaluator). Спека ядра
готова к фазе MCP-обёртки.

### Шаг B: создан внешний репо `vdx-rubric-vodmal` локально, тегирован v0.2.0
Локация `/Users/vdm/AI Projects/vdx-rubric-vodmal/`. Содержимое: `vdx-rubric.yaml`
(переехавший из `docs/specs/vdx-rubric.example.yaml` с очищенным header'ом),
`README.md`, `CHANGELOG.md`, `.gitignore`. Commit `c963b95`, аннотированный тег
`v0.2.0`. Push на GitHub не делал — выходит за пределы локальной работы (требует
явной авторизации). Манифесты проектов смогут ссылаться как
`baseline: github.com/vodmal/vdx-rubric-vodmal@v0.2.0` после push.

### Шаг A: полный draft `vdx-rubric.yaml` v0.2 (14 осей, инстанс)
Все 14 осей рубрики выписаны в `docs/specs/vdx-rubric.example.yaml` по спеке
`rubric-format.md`: предикаты на каждый уровень с использованием базовой
библиотеки (has_task, has_file, file_contains, package_present, config_value,
tsc_flag, gh_workflow_blocks_pr и др.). Static-analysis оформлена через
`storage: flags` с per-stack списками для PHP и Node (D2). Уточнена семантика:
`levels.LN.requires` — это ДЕЛЬТА относительно L(N−1), уровень = максимальный
непрерывный (фиксация в `rubric-format.md` и `drift-algorithm.md`). Следующий
шаг — B (отдельный репо `vdx-rubric-vodmal` + тег v0.2.0).

## 2026-05-22

### P-D9/10/11 промочены в D9/10/11; выложена спека ядра (5 документов)
Закрыты последние «proposed» — D9 (`.vdx-overrides.yml` для override/suppress),
D10 (нативный оценщик предикатов вместо OPA), D11 (baseline в отдельном
git-репо с semver-тегами). Создан `docs/specs/` с 5 черновиками: rubric-format
(predicate DSL + структура owner-baseline), manifest-format (`[vdx]` блок в
`mise.toml` + AGENTS.md projection), overrides-format, mcp-api (6 глаголов +
list_capabilities + audit + record_success_path), drift-algorithm (D7-скоринг +
watermark по SonarQube «Clean as You Code»). Появились открытые вопросы
реализации O13–O21. См. [docs/specs/](docs/specs/) и
[docs/decisions.md](docs/decisions.md).

### D7 (скоринг) + D8 (shared-infra пересобрана) + P-D9/10/11 (override / движок / baseline-storage)
Приняты D7 (weighted scoring: critical = lifecycle/tests/static/ci must-max,
supporting = ≥80%) и D8 (ось `shared-infra` = качество подхода + автопровижининг;
L4 = отдельный версионированный репо с self-provisioning). Под скоринг
пересчитана калибровка: все три референса упираются в ось `ci` (нет реального
PR-гейтования) — главный рычаг роста. Telegram переклассифицирован: НЕ эталон,
а экспериментально-глубокий проект с over-engineering местами. Предложены
P-D9 (`.vdx-overrides.yml` для override/suppress), P-D10 (нативный оценщик
вместо OPA), P-D11 (baseline в отдельном git-репо с semver-тегами). Закрыты
O4/O5/O8/O10/O11/O12. См. [docs/decisions.md](docs/decisions.md),
[docs/maturity-rubric.md](docs/maturity-rubric.md).

### Калибровка рубрики v0.2 по 3 референсам
Reverse-инжиниринг 3 параллельными агентами (telegram L4 / t23b mid / bookmap Node).
Рубрика откалибрована до v0.2: введена новая ось `shared-infra-drift` (эмпирически
подтверждена через `Based on: www.t23b.org/...` в bookmap), ось `ci` теперь
проверяет *реальное гейтование* (не наличие workflow — bookmap имел 5-stage
pipeline с `|| true` в тестах), ось `static-analysis` хранится как набор флагов
(TS флаги ортогональны, в отличие от phpstan-level), `PROJECT_CHANGELOG.md`
признан валидной альтернативой CHANGELOG. Новые открытые вопросы O11 (скоринг
уровня) и O12 (метрика shared-infra-drift). См.
[docs/maturity-rubric.md](docs/maturity-rubric.md) и
[docs/decisions.md](docs/decisions.md) N11.

### Пересмотр замысла подтверждён · D3–D6 приняты · README переписан
Пользователь принял пересмотр vision по итогам research. P-D3…P-D6 промочены в
[D3–D6](docs/decisions.md): mise как раннер, манифест = `mise.toml` + проекция в
`AGENTS.md`, аудит = Scorecard+Qlty+MegaLinter+copier, упаковка = Claude Code
плагин (MCP + skill + hook). Self-improvement (Claude Code auto-memory уже это
делает) убран из заголовка; новизна vdx = структурированный исполняемый
манифест + версионируемая рубрика с drift + shared-infra оркестрация.
[README.md](README.md) перезаписан под новый vision; [landscape.md](docs/landscape.md)
обогащён колонкой «чего НЕ делает» для каждого инструмента.

### Web-research завершён — пересмотр замысла
3 параллельных агента верифицировали ландшафт. Major findings: mise покрывает ~70%
столпа P1; идея «кэшировать success path» уже не нова (Claude Code auto-memory);
версионируемой рубрики с drift локально не делает никто (даже Soundcheck).
Замысел сужен до защищаемого ядра из 4 пунктов; предложены решения P-D3…P-D6
(оседлать mise/Scorecard/Qlty/MegaLinter/copier, упаковка — плагин Claude Code).
См. [docs/decisions.md](docs/decisions.md), [docs/landscape.md](docs/landscape.md),
[docs/decision.md](docs/decision.md).

### Развилки research зафиксированы (D1, D2) + research-журнал
Заведён [docs/decisions.md](docs/decisions.md) — единый журнал «решено / открыто /
наблюдалось». Решено: D1 — рубрика принадлежит человеку/орг (baseline + per-project
override), D2 — рубрика иерархическая (general → стек-специфика), фасад `vdx <verb>`.
Находка N1: паттерн traefik-global расползается копипастой между проектами без
версии — иллюстрация проблемы дрейфа. Добавлена ось `shared-infra`.

### Инициализация проекта (фаза research + спека)
Создан каркас проекта vdx — единый интерфейс жизненного цикла + версионируемая
рубрика зрелости для проектов на любом стеке, с акцентом на машиночитаемый слой
для AI-агента. Зафиксированы два столпа (P1 — глаголы, P2 — рубрика) и фаза
«сначала research». См. [README.md](README.md), [CLAUDE.md](CLAUDE.md),
[docs/maturity-rubric.md](docs/maturity-rubric.md), [docs/landscape.md](docs/landscape.md).
