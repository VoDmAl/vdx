# vdx-cli — Native predicate evaluator (v0.1)

Минимальный аудит-движок для рубрики `vdx-rubric-vodmal`. Шаг C плана
реализации (см. `../docs/decisions.md` D10 — нативный оценщик, не OPA).

## Установка

```bash
cd "$(realpath .)"
npm install
```

## Запуск

```bash
npx tsx src/index.ts audit /path/to/project
# или
npm run audit -- /path/to/project --json
```

По умолчанию рубрика читается из
`/Users/vdm/AI Projects/vdx-rubric-vodmal/vdx-rubric.yaml`. Override:
`--rubric /alt/path.yaml`.

## Smoke-тест

```bash
npm run smoke
```

Прогоняет аудит на трёх калибровочных референсах
(telegram / t23b / bookmap). Ожидаемо все capped at L2 на оси `ci`.

## Структура

- `src/rubric.ts`     — типы + YAML-загрузчик
- `src/manifest.ts`   — парсинг `[vdx]` блока в `mise.toml` + `.vdx-overrides.yml`
- `src/facts.ts`      — fact source loaders (tasks, packages, configs)
- `src/predicates.ts` — registry предикатов (v0.1: 11 функций)
- `src/evaluator.ts`  — рекурсивный evaluator + сахарная нотация
- `src/scoring.ts`    — delta-style для уровней, flags для гибкой оси
- `src/audit.ts`      — оркестратор: применяет overrides + считает уровень (D7)
- `src/report.ts`     — markdown / JSON формат отчёта
- `src/index.ts`      — CLI entry

## Что НЕ реализовано в v0.1

- `config_value`, `command_succeeds` предикаты — заглушки с warning.
- Загрузка baseline из git-репо по `baseline:` ссылке — пока только local file.
- Watermark drift (фаза 2 из drift-algorithm.md).
- MCP-server обёртка (D6 — следующий шаг).
