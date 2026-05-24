# vdx

**Тонкая надстройка над существующими инструментами: единый словарь команд +
версионируемая рубрика зрелости с детектом дрейфа + структурированный манифест
для AI-агента.**

> Рабочее название. Можно переименовать.

---

## Проблема

AI снял потолок параллельности: вместо одного основного стека (PHP) — десятки
продуктов одновременно на PHP, Node, Python, Go. Из этого растут две боли:

1. **Операционное трение.** В каждом проекте свой способ «поднять / остановить /
   пересобрать / прогнать тесты». Глубина и словарь команд скачут от проекта к
   проекту.
2. **Дрейф качества.** Нет объективной меры зрелости. Когда личный стандарт
   качества растёт, старые проекты молча отстают, и узнать об этом негде.

## Замысел

vdx собирается как **«комбайн»** из готовых инструментов. Свой код — только то,
чего нет ни у кого, и собственно из-за чего vdx существует.

### Защищаемое ядро — 4 вещи

| # | Что | Почему этого нет в готовом |
|---|-----|----------------------------|
| 1 | Нормализованный словарь глаголов `up / down / build / test / check / fix` | раннеры (mise/Task/just) не задают стандартного словаря |
| 2 | **Версионируемая рубрика зрелости + drift-движок** | Soundcheck/Cortex/OpsLevel мутируют стандарт вживую; локально и на чужих репах не работают |
| 3 | **Shared-infra оркестрация** (Global Traefik как зависимость `up`) | ни один раннер не моделит cross-repo зависимости |
| 4 | Структурированный исполняемый манифест для AI-агента | AGENTS.md намеренно проза; Claude Code auto-memory тоже пишет прозой |

> **Чего vdx делать НЕ будет:**
> — собственный task-runner (mise делает это полиглотно и стабильно);
> — собственный «discover-and-cache» loop как идею (Claude Code auto-memory
>   нативно пишет находки между сессиями; новизна vdx — что фиксированный путь
>   *структурированный и исполняемый*, а не проза).

## Архитектура

| Слой | Инструмент | Решение |
|------|-----------|---------|
| Раннер задач | **mise** | [D3](docs/decisions.md) |
| Манифест возможностей | `mise.toml` + vdx-метаблок; проекция в `AGENTS.md ## Commands` | [D4](docs/decisions.md) |
| Сбор фактов для аудита | OpenSSF Scorecard · Qlty CLI · MegaLinter (планово) | [D5](docs/decisions.md) |
| Scaffold-fix на своих | copier (`copier update`, 3-way merge) — планово | [D5](docs/decisions.md) |
| Упаковка для Claude Code | плагин: MCP-сервер + skill + hook | [D6](docs/decisions.md) |

Полные обоснования и открытые вопросы — в [docs/decisions.md](docs/decisions.md).

## Сценарии

**Знакомый стек.** `vdx up` → infra-precheck → `mise run up` → нативная команда.
Мгновенно.

**Незнакомый стек через Claude Code.** Агент через MCP знает 6 глаголов проекта,
вызывает их без чтения docker-файлов. `vdx audit` оценивает по *твоей* рубрике
даже в незнакомом тулинге.

**Манифеста ещё нет.** `vdx` падает в fallback — детектит
`make`/`composer`/`npm`, вызывает напрямую. Агент по итогам фиксирует найденный
success path в `mise.toml` через hook — следующий запуск уже мгновенный.

**Дрейф.** Owner-рубрика ушла вперёд → `vdx audit` показывает разрыв со старым
проектом. На своих — `copier update` накатывает шаблонные исправления;
на чужих — read-only отчёт.

## Двух-репо структура

| Репо | Что | Релиз |
|------|-----|-------|
| **[vdx](https://github.com/VoDmAl/vdx)** (этот) | dev-hub: research, спека, evaluator (`cli/`), Claude Code плагин (`plugin/`) | меняется часто |
| **[vdx-rubric-vodmal](https://github.com/VoDmAl/vdx-rubric-vodmal)** | canonical owner-baseline рубрики (`vdx-rubric.yaml`) | semver-теги (`v0.2.2`+) |

Manifest-ссылки в проектах вида `baseline: github.com/VoDmAl/vdx-rubric-vodmal@v0.2.2`
ведут на конкретный semver-тег canonical-репо. Правила синхронизации между двумя
репо — в [CLAUDE.md](CLAUDE.md) («Внешний репо»).

## Текущий статус: ядро работает + CLI на npm, рубрика v0.2.2

Спека D1–D11 принята, ядро реализовано шагами A–N за одну сессию (см.
[PROJECT_CHANGELOG.md](PROJECT_CHANGELOG.md)):

- **Шаг A** — рубрика v0.2 + draft спеки (формат, predicate DSL, drift-алгоритм).
- **Шаг B** — canonical-репо `vdx-rubric-vodmal` опубликован на GitHub.
- **Шаг C** — нативный evaluator (TypeScript, ~600 LOC в `cli/src/`).
- **Шаг D** — evaluator дотюнен по smoke-тестам на 3 референсах.
- **Шаг E** — `vdx init`: автодетект стека → mapping нативных задач в 6 глаголов
  → генерация `mise.toml` + `AGENTS.md ## Commands`.
- **Шаг F** — MCP-сервер `vdx-mcp` на stdio с 9 tools.
- **Шаг G** — Claude Code плагин `vdx/plugin/` (`.claude-plugin/`, `.mcp.json`,
  skill, hook).
- **Шаг H** — догфудинг: vdx сам имеет корневой `mise.toml`, baseline-аудит.
- **Шаг I** — stack-detector видит depth-1 sub-packages (monorepo / dev-hub).
- **Шаг J** — `applies_to` filter в рубрике v0.2.2: stack-нерелевантные оси
  получают `drift_kind: excluded`, не учитываются в overall.
- **Шаг K** — `[vdx].primary_subpackage` + `resolveSubpackageCtx` (O31 закрыт).
- **Шаг L** — `.github/workflows/ci.yml` + `npm test` alias (ci L0→L3).
- **Шаг M** — `matrix.node-version: [20, 22]` (ci L3→L4, первая ось vdx на max).
- **Шаг N** — CLI выложен на npm как
  **[@vodmal/vdx-cli](https://www.npmjs.com/package/@vodmal/vdx-cli)**;
  плагин теперь marketplace-ready (`npx -y -p @vodmal/vdx-cli@latest vdx-mcp`).

### Research-артефакты
| Артефакт | Файл | Статус |
|----------|------|--------|
| Onboarding для новой сессии | [HANDOFF.md](HANDOFF.md) | актуален |
| Research-журнал (Decided / Open / Observed) | [docs/decisions.md](docs/decisions.md) | актуален |
| Обзор аналогов (что делает / не делает) | [docs/landscape.md](docs/landscape.md) | актуален |
| Рубрика зрелости v0.2 (калибровано) | [docs/maturity-rubric.md](docs/maturity-rubric.md) | актуален |
| Решение build-vs-adopt | [docs/decision.md](docs/decision.md) | актуален |
| Журнал изменений | [PROJECT_CHANGELOG.md](PROJECT_CHANGELOG.md) | ведётся |

### Спека ядра (v0.2.2)
| Документ | Что специфицирует |
|----------|-------------------|
| [docs/specs/rubric-format.md](docs/specs/rubric-format.md) | Формат `vdx-rubric.yaml` owner-baseline + predicate DSL + `applies_to` |
| [docs/specs/manifest-format.md](docs/specs/manifest-format.md) | `[vdx]` блок в `mise.toml` + проекция `AGENTS.md` |
| [docs/specs/overrides-format.md](docs/specs/overrides-format.md) | `.vdx-overrides.yml` для per-project переопределений |
| [docs/specs/mcp-api.md](docs/specs/mcp-api.md) | Контракт MCP-сервера vdx |
| [docs/specs/drift-algorithm.md](docs/specs/drift-algorithm.md) | Алгоритм расчёта уровня + drift |
| [docs/specs/vdx-rubric.example.yaml](docs/specs/vdx-rubric.example.yaml) | Mirror canonical-инстанса (для документации) |

## Догфудинг

vdx сам аудитится своей же рубрикой. Декларация в [mise.toml](mise.toml):
`stack = "meta"` (документация + nested CLI в `cli/`).

Текущая позиция: **overall L0**. Реальный блокер — ось `ci` (vdx не имеет
GitHub Actions). 5 stack-специфичных осей (tests, static-analysis, code-style,
dependency-hygiene, mock-infra) корректно получают `drift_kind: excluded` для
meta-стека и не учитываются в overall. Lifecycle-interface = L2 (3 глагола из
6: build, test, check — up/down/fix отсутствуют преднамеренно, vdx — не сервис).

Следующие шаги в `vdx`: настоящие тесты (vitest), CI-workflow, sub-package-aware
predicates (O31) для аудита nested `cli/` как Node-проекта. Полный список
открытых вопросов — в [docs/decisions.md](docs/decisions.md) и
[HANDOFF.md](HANDOFF.md).
