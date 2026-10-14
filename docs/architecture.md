# Архитектура CLI

Карта `cli/` — что где лежит и как идёт вызов. Решения и их причины — в
[decisions.md](decisions.md), форматы — в [specs/](specs/), состояние — в
[HANDOFF.md](../HANDOFF.md).

## Вход

`bin/vdx.cjs` и `bin/vdx-mcp.cjs` — запускалки на CommonJS: регистрируют `tsx`
и импортируют `src/index.ts` или `src/mcp-server.ts`. Сборки нет, пакет везёт
исходники TypeScript (`files` в `package.json`: `src`, `rubric`, `bin`), поэтому
`tsx` — зависимость пакета, а не разработки.

`src/index.ts` разбирает аргументы и раздаёт команды:

| Команда | Куда |
|---|---|
| `vdx up\|down\|build\|test\|check\|fix` | `run.ts` проверяет, что задача есть в `mise.toml`, затем `mise run <verb>` |
| `vdx audit` | конвейер аудита (ниже) |
| `vdx init` | `init.ts` |
| `vdx doctor` | `doctor.ts` |
| `vdx publish` | `publish.ts` |
| `vdx ai[@host]` | `ai.ts` |

Свой раннер vdx не держит: глаголы исполняет mise (D3).

## Конвейер аудита

```
rubric.ts      сет: YAML → оси, уровни, предикаты (schema 0.3)
manifest.ts    манифест проекта ([_.vdx] в mise.toml, старый [vdx]) и .vdx-overrides.yml
audit.ts       контекст каждой оси: корень или подпакет мета-репо (applies_to)
evaluator.ts   дерево предиката: any_of / all_of / at_least_n_of / not, сахар { has_task: "up" }
predicates.ts  реестр предикатов: факт → true | false | unknown
facts.ts       чтение проекта: файлы, JSON / YAML / TOML, задачи, стек; кеш на контекст
scoring.ts     уровень оси и общий уровень (критичные + 80 % вспомогательных)
report.ts      markdown, ansi, json
```

Аудит читает сет из пакета (`rubric/vdx-rubric.yaml`), или из `--rubric`, или из
`VDX_RUBRIC` (`defaults.ts`). Строка `baseline` манифеста — это подпись в отчёте:
по ней сет не скачивается.

У мета-репо половины видят файлы друг друга: в `facts.ts` `locate` ищет
недостающий файл в другой половине (`fallbackRoot`), а задачи берутся только
свои (`ownCtx`) — `manifest-format.md`, DL #5 кристалла `vdx-dogfooding`.

Предикат, который vdx проверить не может (хостинг, CI не на GitHub Actions),
отвечает `unknown`. Уровень на нём останавливается, и отчёт называет причину
(`rubric-format.md`).

Распознаватели, на которые опираются предикаты:

- `gha.ts` — workflows GitHub Actions для оси `ci`: что идёт на push в `main`,
  какие шаги тестовые, где сбой замаскирован;
- `hooks.ts` — фреймворки git-хуков (husky, lefthook, simple-git-hooks,
  cghooks, `.githooks/`): кто их ставит и что они зовут, для `git-hygiene`;
- `vocabulary.ts` — какие задачи проекта зовёт командная строка через его
  раннер (mise, npm, composer, make…).

## Остальные команды

- `init.ts` — сопоставляет глаголы словаря задачам проекта (точное имя, алиас,
  группа) и пишет `mise.toml` с блоком `[_.vdx]`.
- `doctor.ts` — отчёт о машине и клоне. `clone-checks.ts` — проверки клона,
  общие для `doctor` и пометки ⚑ в `audit` (`clone_check` оси).
  `personal-hooks.ts` — личные хуки владельца в `~/.gitconfig`
  (`hook.<имя>.*`, Git 2.54+). `author.ts` — автор коммитов в `.git/config`.
- `publish.ts` — выпуск одной командой: pre-flight, bump, `npm publish`, тег,
  push, ожидание реестра.
- `ai.ts` — запуск агента в tmux по личному профилю (`vdx-environment.yaml`),
  с машиной и разговором; `conversations.ts` — разговоры Claude Code проекта и
  машина, на которой каждый запускали.
- `mcp-server.ts` — MCP по stdio: `list_capabilities`, `vdx_audit`, глаголы,
  `vdx_record_success_path` (`specs/mcp-api.md`).

`narrow.ts` — сужение `unknown`: всё разобранное из чужих файлов и пойманные
ошибки проверяются на входе (DL #8 `vdx-dogfooding`).

## Тесты

- `tests/unit/` — vitest (`npm test`): по модулю (`audit.test.ts`) и по темам
  (`schema-03.test.ts`, `ci-signal.test.ts`); `cli.test.ts` запускает сам
  `bin/vdx.cjs`. Фикстуры — `tests/fixtures/`.
- `tests/e2e/` — пакет, каким его отдаёт npm: `npm pack`, установка во
  временный префикс, оба бинарника (`npm run test:e2e`, свой
  `vitest.e2e.config.ts`).
- `smoke.sh` — аудит трёх калибровочных проектов по локальным путям
  (`mise run test:smoke`, не в CI).

`mise run check` — `tsc` (с тестами), Prettier, ESLint, knip. CI и хук
`pre-push` зовут `check`, `test` и `test:e2e`.

## Где менять

| Что | Где |
|---|---|
| Новая проверка в рубрике | предикат в `predicates.ts` + тест; ось — в репо сета `vdx-rubric-vodmal`, потом копия в `cli/rubric/` и зеркало `docs/specs/` (CLAUDE.md) |
| Новое поле манифеста | `manifest.ts`, `specs/manifest-format.md` |
| Формат отчёта | `report.ts` |
| Флаг команды | `index.ts` (разбор и `--help`), затем модуль команды; примеры в `.md` — в том же коммите |
