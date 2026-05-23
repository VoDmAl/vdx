# Спека: формат `.vdx-overrides.yml`

Статус: **draft v0.2**. Per-project переопределения и подавления осей рубрики.
См. [../decisions.md](../decisions.md) D9.

## Расположение

`<project_root>/.vdx-overrides.yml` рядом с `mise.toml`. Закоммичен в git
(в отличие от `~/.reflexio` от claude-smart — vdx-данные репо-versioned).

## Схема

```yaml
schema_version: "0.2"
overrides:
  - axis: <axis-id>           # обязательно — id оси из baseline-рубрики
    target: L0 | L1 | L2 | L3 # опциональный, понижает требование
    suppress: true            # опциональный, mutually-exclusive с target
    reason: "<обязательная причина>"
    until: 2026-12-01         # опциональный, time-boxed (ISO-дата)
```

## Правила валидации

- Ровно одно из `target` или `suppress` per override.
- `target` не может быть **выше** уровня из baseline (только понижение).
- `reason` обязателен; без него — ошибка валидации `vdx-audit`.
- `until` — ISO-дата (день). Аудит выдаёт *красное* предупреждение, если
  override истёк (`today > until`) — заставляет вернуться к вопросу.
- `suppress: true` для **critical** оси требует подтверждения либо в командной
  строке (`vdx audit --allow-critical-suppress`), либо `enforce_critical: false`
  в manifest (по умолчанию `true`). Так нельзя случайно «выключить» tests.

## Пример

```yaml
schema_version: "0.2"
overrides:
  - axis: tests
    target: L2
    reason: "перед запуском тестов нужен реал-секрет, в плане Q4 2026"
    until: 2026-12-01

  - axis: shared-infra-drift
    suppress: true
    reason: "проект не использует общую инфру"

  - axis: docs
    target: L2
    reason: "приватный экспериментальный репозиторий, без онбординга"
```

## Поведение аудита

- Override применяется **до** скоринга по D7.
- `target` override понижает «обязательную планку» для этой оси: проект
  «дотягивает», если achieved >= override.target (не до baseline default).
- `suppress: true` исключает ось из расчёта класса (для D7-формулы знаменатель
  supporting пересчитывается).
- Истёкший `until` НЕ убирает override автоматически (чтобы не сломать
  pipeline), но помечает его красным.

## Открытые вопросы

См. [../decisions.md](../decisions.md): O17 (auto-escalate override при
закрытии оси `vdx fix`).
