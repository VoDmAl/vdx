# Спека: MCP API vdx

Статус: **draft v0.2**. Контракт MCP-сервера vdx — то, что Claude Code (и любой
MCP-клиент) видит как инструменты. См. [../decisions.md](../decisions.md) D6.

## Транспорт

JSON-RPC 2.0 через stdio (стандарт MCP). Конфигурируется в Claude Code как часть
vdx-плагина (D6).

## Tools

### Lifecycle-глаголы (6 шт)

Все принимают одинаковую форму:

```typescript
input:  { args?: string[] }     // дополнительные args пробрасываются в mise
output: {
  ok: boolean,
  exit_code: number,
  stdout: string,
  stderr: string,
  duration_ms: number
}
```

- `vdx_up` — запуск проекта: precheck `shared_infra` → `mise run up`.
- `vdx_down`, `vdx_build`, `vdx_test`, `vdx_check`, `vdx_fix` — аналогично.

### `list_capabilities`

Самый частый вызов агента, входящего в проект.

```typescript
input: {}
output: {
  schema_version: string,
  stack: string,
  baseline: string,                  // "github.com/.../...@v0.2.0"
  verbs: Array<{
    name: string,
    has_manifest: boolean,           // в [tasks] существует
    native_command: string | null    // или null если только в манифесте
  }>,
  shared_infra: {
    provider: string,
    precheck: boolean,
    is_running: boolean              // живая проверка
  } | null,
  last_verified: string | null
}
```

Один вызов — и агент знает всё, что нужно для эксплуатации проекта.

### `vdx_audit`

```typescript
input: {
  baseline?: string,                 // override, default = из mise.toml
  format?: "json" | "markdown"       // default: json
}
output: {
  baseline: string,                  // фактически использованная версия
  achieved_level: string,            // "L0".."L4"
  per_axis: Array<{
    axis_id: string,
    class: "critical" | "supporting",
    achieved: string,                // "L0".."L4"
    target: string,                  // из рубрики (после override)
    drift_kind: "aligned" | "gap" | "over",
    evidence: Array<{
      predicate: string,
      result: boolean,
      detail?: string
    }>
  }>,
  overrides: Array<{
    axis_id: string,
    kind: "target" | "suppress",
    reason: string,
    until?: string,
    expired?: boolean
  }>,
  expired_overrides: string[],
  watermark?: {
    baseline_at_last_audit: string,
    achieved_at_last_audit: string,
    changed_since: string[]          // axis_ids, у которых baseline поднял планку
  }
}
```

См. drift-algorithm.md.

### `vdx_record_success_path`

Вызывается из vdx skill после успешной верификации найденных команд.

```typescript
input: {
  verbs: Array<{ name: string, command: string }>,
  shared_infra?: { provider: string, precheck: boolean },
  notes?: string
}
output: {
  ok: boolean,
  manifest_path: string,
  agents_md_updated: boolean
}
```

Записывает задачи в `[tasks]` секцию `mise.toml`, обновляет `[vdx]` и
`[vdx.success_path]`. Если `AGENTS.md` существует — обновляет секцию
`<!-- vdx:commands -->`.

## Ошибки

Стандартные JSON-RPC error codes плюс расширения:

| Code | Значение |
|------|----------|
| -32001 | manifest absent (fallback path активен) |
| -32002 | baseline version unavailable (offline + не закэширован) |
| -32003 | audit failed (probe error в одном из движков) |
| -32004 | critical-axis suppression без `enforce_critical: false` |
| -32005 | shared_infra precheck failed |

## Открытые вопросы

См. [../decisions.md](../decisions.md): O18 (streaming результата `vdx_audit`),
O19 (streaming output для lifecycle-глаголов).
