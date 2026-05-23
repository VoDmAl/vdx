# Спека: формат манифеста проекта

Статус: **draft v0.2**. Манифест возможностей проекта — то, что агент читает,
чтобы эксплуатировать проект без анализа. См. [../decisions.md](../decisions.md)
D4 (манифест = `mise.toml` + vdx-метаблок), D6 (MCP-сервер vdx читает этот блок).

## Расположение

В корневом `mise.toml` проекта — таблица `[vdx]` с подтаблицами. mise сам этот
блок игнорирует (это custom data); vdx читает.

## Полная схема

```toml
# mise.toml

[tools]
php = "8.5"
node = "22"

[tasks.up]
description = "Start the project locally"
run = "docker compose up -d"

[tasks.down]
run = "docker compose down"

[tasks.test]
run = "composer test"

# ... аналогично build/check/fix

# === vdx metadata ===
[vdx]
schema_version = "0.2"
baseline = "github.com/vodmal/vdx-rubric@v0.2.0"
stack = "php"                        # php | node | python | go | mixed
primary_language = "PHP"
verbs = ["up", "down", "build", "test", "check", "fix"]

[vdx.shared_infra]
provider = "github.com/vodmal/traefik-global@v1.0.0"
precheck = true                      # vdx up автоматически поднимает infra
healthcheck_url = "https://traefik.localhost.lime.co"

[vdx.success_path]
last_verified = "2026-05-22"
verified_by = "claude-code"
host_os = "macos-25"
notes = "tested in Ghostty + OrbStack"

[vdx.audit]
last_run = "2026-05-22T14:30:00Z"
baseline_version_at_run = "v0.2.0"
achieved_level = "L2"
acknowledged_drift = []              # axis_ids, дрейф осознанно зафиксирован
```

## Поля

- `schema_version` — версия формата манифеста.
- `baseline` — ссылка на owner-рубрику + версия. Формат `host/owner/repo@tag`
  (как Go modules). Аудит загружает **именно эту** версию (D11).
- `stack` — общая характеристика; влияет на стек-специфичные оси.
- `verbs` — список стандартных глаголов, которые проект **обязуется** выставить.
  Если задача `up` определена в `[tasks]`, она должна быть в `verbs`. vdx-audit
  падает при расхождении.
- `[vdx.shared_infra]` — декларация зависимости от общей инфры (D8). `precheck:
  true` → `vdx up` сам поднимает её перед `mise run up`.
- `[vdx.success_path]` — для self-improving discovery: hooks (D6) пишут сюда
  после успешной верификации команд (фиксация мгновенно-работающего пути).
- `[vdx.audit]` — последний результат аудита: watermark для drift-алгоритма.

## Проекция в AGENTS.md (D4)

vdx-cli умеет регенерировать секцию `## Commands` в `AGENTS.md` (или создать
файл) на основе манифеста. Секция помечена парой маркеров `<!-- vdx:commands -->`
и `<!-- /vdx:commands -->` — между ними содержимое управляется vdx; вне маркеров
файл под контролем человека.

Пример секции:

```markdown
<!-- vdx:commands -->
## Commands

This project follows the vdx lifecycle interface
(baseline: github.com/vodmal/vdx-rubric@v0.2.0).

| Verb | What it does | Native command |
|------|--------------|----------------|
| `mise run up`    | Start project locally | `docker compose up -d` |
| `mise run down`  | Stop project          | `docker compose down`  |
| `mise run test`  | Run tests             | `composer test`        |
| `mise run check` | Quality checks (no edits) | `composer check`   |
| `mise run fix`   | Auto-fixes             | `composer fix`        |
| `mise run build` | Build assets/db        | `composer build`      |
<!-- /vdx:commands -->
```

Команда регенерации — `vdx sync-agents`. CI можно настроить так, чтобы рассинхрон
falsified коммит.

## Жизненный цикл манифеста

1. **Bootstrap** (`vdx init`):
   определяет стек по `composer.json`/`package.json`/`go.mod`/etc., генерирует
   начальный `mise.toml` с шеллящими задачами поверх существующих
   `composer scripts` / `npm scripts` / `Makefile`. Добавляет `[vdx]` блок и
   секцию в `AGENTS.md`.
2. **Discover-and-record** (нет манифеста, агент в проекте):
   vdx skill через Claude Code анализирует проект, находит native команды,
   проверяет работоспособность (`mise run up` → `curl healthcheck`), и через
   hook вызывает `vdx_record_success_path` (см. mcp-api.md) — манифест появляется,
   следующая сессия начинается мгновенно.
3. **Update**: автор правит `mise.toml` напрямую; `vdx sync-agents` обновляет
   проекцию в `AGENTS.md`.

## Открытые вопросы

См. [../decisions.md](../decisions.md): O15 (`verbs` декларация vs автодискавер),
O16 (формат `acknowledged_drift`).
