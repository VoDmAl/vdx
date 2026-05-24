# Журнал изменений проекта

Значимые изменения vdx. Формат записи: заголовок + 1–2 предложения + ссылки.

## 2026-05-24

### Шаг Q: supporting лифт — overall L0 → L1
Добавлены три минимальных артефакта + 3 override'а:
- `Makefile` в корне — алиасы на mise commands (`build`, `test`, `check`,
  `audit`, `smoke`) → `reproducibility` L0→L1.
- `cli/.editorconfig` — стандартные правила (2-space, LF, UTF-8) →
  `code-style` L0→L1 (subpackage-ctx направляет на cli/).
- `.vdx-overrides.yml` — `suppress: true` для трёх осей, не применимых
  к meta-проекту: `secrets-config` (нет runtime env), `shared-infra`
  (vdx не сервис), `shared-infra-drift` (нет misc/traefik-global).

vdx-self-audit: **overall L0 → L1**. Supporting visible (7 = 10 - 3
suppressed): 7/7 на L1+ = 1.0 ≥ 0.8 threshold. Critical min L2.

`mock-infra` неожиданно L1 → L2 — false positive из-за `cli/tests/fixtures/`
матчащегося под `has_file: tests/Fixtures` на case-insensitive APFS. На
Linux CI это вернёт L1, overall всё равно L1 (supporting margin большой).
См. N27 в [docs/decisions.md](docs/decisions.md).

### External-facing docs переведены на английский
`README.md` (главный), `vdx-rubric-vodmal/README.md` и
`vdx-rubric-vodmal/CHANGELOG.md` переведены на английский — для npm/GitHub
discoverability. Внутренние документы (`HANDOFF.md`, `CLAUDE.md`,
`docs/*`, `PROJECT_CHANGELOG.md`) остаются на русском. `cli/README.md` и
`plugin/README.md` уже были на английском.

### Шаг P: vitest на evaluator (tests axis L0 → L3, ось `release-artifact` остаётся открытой как O34)
В `cli/` добавлен vitest + 47 unit-тестов на `scoring.ts` и `predicates.ts`
(plus фикстуры в `tests/fixtures/`). `package.json` scripts: `test`
теперь = `vitest run` (раньше `tsc --noEmit`), `typecheck` отдельно
= `tsc --noEmit`, добавлены `test:unit` и `coverage`. CI workflow
обновлён: typecheck + unit tests как раздельные шаги.

Эффект на vdx audit (stack=meta, primary_subpackage=cli):

| Ось | До Шага P | После Шага P |
|-----|:--:|:--:|
| tests (C) | L0 | **L3** |
| overall | L0 | L0 |

`tests` прошёл L1 (`package_present: vitest`), L2 (`has_task: test:unit`),
L3 (`has_task: coverage`) в один commit. L4 (e2e/mutation) — overkill для CLI.
Overall остаётся L0 — теперь capping на supporting (5 из 10 supporting L0:
reproducibility, code-style, secrets-config, shared-infra,
shared-infra-drift). Smoke на 3 референсах без регрессий (L2/L1/L1).
См. [docs/decisions.md](docs/decisions.md) N26.

## 2026-05-23

### Шаг O: O33 закрыт — subpackage stack lift для applies_to-осей (@vodmal/vdx-cli@0.2.1)
`stackForDir` экспортирован из `cli/src/facts.ts`. В `resolveSubpackageCtx`
(`cli/src/audit.ts`): для explicit `primary_subpackage` detect actual stack
subpackage'a; для auto-resolve добавлен fallback "если ровно один subpackage
с любым стеком — adopt его". Возвращаемый `subpackageCtx.stack` = stack
subpackage'a (а не наследуется от root). Проверка `applies_to` в audit loop
теперь сравнивается с `evalCtx.stack`. Эффект на vdx-self-audit: 5
stack-осей больше не excluded — static-analysis L0→**L2**, dependency-hygiene/
mock-infra L0→**L1**, tests/code-style **L0** правдиво (нет vitest/eslint).
Overall vdx L0→L0, но capping переехал с 4 supporting-L0 на критическую
tests=L0 — **fix integrity**, не лифт. CLI bump v0.2.0→v0.2.1. Smoke на 3
референсах без регрессий. См. [docs/decisions.md](docs/decisions.md) N25 +
закрытие O33.

### Шаг N: CLI выложен на npm как @vodmal/vdx-cli@0.2.0
TypeScript CLI вынесен в публикуемый npm-пакет с bin entries (`vdx`, `vdx-mcp`).
`tsx` переехал в `dependencies` + `bin/*.cjs` обёртки регистрируют ESM-loader
in-process (`require('tsx/esm/api').register()`, без `namespace` —
namespace изолирует loader так, что type-only cross-module exports ломаются).
Bundled рубрика в `cli/rubric/vdx-rubric.yaml` снимает зависимость от
локального canonical-репо при инсталляции через npm; путь резолвится через
`src/defaults.ts` (по `import.meta.url`). `plugin/.mcp.json` переключён с
абсолютного пути на `npx -y -p @vodmal/vdx-cli@latest vdx-mcp` — плагин теперь
marketplace-ready (нет привязки к локальному рабочему дереву). Открыто
**O33** (subpackage с другим стеком должен contributить applies_to-осям
parent'а: текущая `audit.ts` проверка excluded стоит до subpackage-ctx) и
**O34** (новая ось `release-artifact`: name/version/license/repository/bin/
publishConfig/registry-resolves). См. [docs/decisions.md](docs/decisions.md)
N24, O33, O34.

### Шаг M: ci L4 через matrix node [20, 22]
В `.github/workflows/ci.yml` добавлен `strategy.matrix.node-version: [20, 22]`
с `fail-fast: false`. Typecheck гоняется на двух LTS-версиях node параллельно.
Audit на vdx: `ci` L3 → **L4** (предикат `file_contains: matrix:` совпадает) —
первая ось vdx на max. Overall L0 без изменений (4 supporting на L0 — meta-репо).
См. [docs/decisions.md](docs/decisions.md) N23.

### Шаг L: CI workflow для vdx (ci axis L0 → L3)
Добавлен `.github/workflows/ci.yml` (push main + pull_request → setup-node@v4,
`cd cli && npm ci && npm test`). В `cli/package.json` добавлен alias
`"test": "tsc --noEmit"` (нужен и для regex `npm test` в L2-предикате, и для
семантики «npm test = quality gate»). Effect: `ci` ось v0.2.2 поднялась с
**L0 до L3** в один Write — workflow есть (L1), regex `npm test` совпадает
(L2), `pull_request` trigger без `|| true` (L3). L4 требует matrix/sentry —
пока не делаем. Overall vdx остался L0 — теперь capping переехал на 4
supporting-оси (reproducibility/secrets-config/shared-infra/shared-infra-drift),
которые у meta-репо буквально пустые. Это правдивая оценка, не lying-L0.
См. [docs/decisions.md](docs/decisions.md) N22.

### Шаг K: primary_subpackage в манифесте (O31 закрыт)
Добавлено optional поле `[vdx].primary_subpackage` в `VdxManifest`
(`cli/src/manifest.ts`). В `cli/src/audit.ts` функция `resolveSubpackageCtx`
строит derived `Ctx` с заменённым `projectRoot` для осей с `applies_to`:
explicit-from-manifest либо auto-resolve через `findSubPackages()` когда
ровно один subpackage совпадает с `ctx.stack`. Owner-рубрика не менялась.
Smoke на 3 референсах без регрессий (telegram L2, t23b L1, bookmap L1 —
manifest в корне, fallback на root). Dogfooding на копии vdx
(stack=node+subpkg=cli): 5 stack-осей теперь оценены реально вместо
excluded — `static-analysis` L2 (tsc strict), `dependency-hygiene` L1
(lockfile), `mock-infra` L1, `tests`/`code-style` остались L0 (правдиво:
нет vitest/eslint). Оригинальный `vdx/mise.toml` остаётся `stack=meta`
(сознательный выбор). Остаточный кейс multi-subpackage monorepo выделен
как **O32**. См. [docs/decisions.md](docs/decisions.md) N21 + закрытие O31,
[docs/specs/manifest-format.md](docs/specs/manifest-format.md) описание поля.

### README rewrite под текущее состояние (A–J)
Снят устаревший статус «спека ядра в процессе / следующая фаза — реализация».
Добавлены: секция «Двух-репо структура» (vdx + vdx-rubric-vodmal с ссылками на
GitHub), хронология шагов A–J, обновлённая таблица спеки с applies_to,
честный раздел «Догфудинг» (overall L0 = реальное узкое место ci, 5 осей
excluded для stack=meta) вместо обещания L4. Vision-секция (Проблема,
Замысел, защищаемое ядро, архитектура, сценарии) — без изменений.

### Шаг J: applies_to filter в рубрике (O30 закрыт, v0.2.2)
Добавлено optional `applies_to: [<stack-id>, ...]` поле на ось. Если задан и
текущий stack не в списке — ось получает `drift_kind: excluded`, не учитывается
в overall scoring. Помечены 5 stack-specific осей `[php, node, go, python]`:
critical (tests, static-analysis) + supporting (code-style, dependency-hygiene,
mock-infra). Canonical rubric bumped: `vdx-rubric-vodmal@v0.2.2` (тег ещё НЕ
push'нут на GitHub, см. ⚠️ в N20). Изменения evaluator: `Axis.applies_to`,
новый `drift_kind: 'excluded'`, `projectLevel` фильтрует excluded из visible.
Smoke без регрессий (telegram L2, t23b L1, bookmap L1). Аудит vdx: 5 осей
excluded; overall L0 теперь по реальной причине — отсутствие CI у vdx (lying
L0 на 3 критических осях устранено). Spec: `docs/specs/rubric-format.md`
обновлён. См. [docs/decisions.md](docs/decisions.md) N20 + закрытие O30,
[docs/specs/rubric-format.md](docs/specs/rubric-format.md) секция applies_to.

### Шаг I: monorepo/subpackage stack detection (O28 закрыт)
`autoDetectStack` в `cli/src/facts.ts` теперь делает root-first scan +
depth-1 fallback под игнор-листом (`node_modules`/`vendor`/`dist`/...).
Новая функция `findSubPackages(projectRoot): SubPackage[]` для будущих
sub-package-aware предикатов. Smoke на 3 референсах без регрессий
(telegram L2, t23b L1, bookmap L1). Auto-detect на vdx (без `[vdx].stack`):
было `unknown`, стало **`node`** через `cli/package.json`. Overall у vdx
остаётся L0 потому что предикаты пока root-only — это уже территория O30.
См. [docs/decisions.md](docs/decisions.md) N19 + закрытие O28.

### Шаг H: догфудинг vdx на самом vdx
Baseline `vdx audit` на `/Users/vdm/AI Projects/vdx`: stack=`unknown`,
achieved **L0**, 14/14 осей в gap. Положен корневой `mise.toml` (написан
руками — `vdx init` бесполезен при unknown, см. O29) со `stack="meta"` и
тремя tasks (`build`/`test`/`check`) указывающими в `cli/`. Второй
аудит: stack→**`meta`** (evaluator подхватил из `[vdx]`-блока),
lifecycle-interface L0→**L2**, overall остаётся L0 (capped tests/static/
ci — meta-стек на этих осях слепой, см. O30). Открыты три задачи:
**O28** (monorepo/subpackage stack detection), **O29** (init при
unknown), **O30** (стек-нейтральные предикаты для meta).
См. [docs/decisions.md](docs/decisions.md) N18 + O28/O29/O30,
[mise.toml](mise.toml).

### Шаг G: Claude Code плагин v0.1
`vdx/plugin/`: `.claude-plugin/plugin.json`, `.mcp.json` (регистрирует MCP
server из cli/), `skills/vdx-discover/SKILL.md` (discover-and-record
workflow для агента), `hooks/hooks.json` + `scripts/record-success-path.sh`
(PostToolUse hook на `vdx_up`). Установка: `--plugin-dir` или
`extraKnownMarketplaces` в `~/.claude/settings.json`. Инструкция —
`plugin/README.md`. См. [docs/decisions.md](docs/decisions.md) N17.

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
