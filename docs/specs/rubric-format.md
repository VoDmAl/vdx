# Спека: формат рубрики (baseline)

Статус: **draft v0.2**. Описывает структуру файла owner-baseline. См.
[../decisions.md](../decisions.md) D1 (owner-baseline), D7 (скоринг), D11
(хранение в отдельном репо с semver-тегами).

## Расположение
Корневой файл репозитория-рубрики: `vdx-rubric.yaml`.
Версия задаётся git-тегами (`v0.2.0`); содержимое файла должно совпадать с
`metadata.version` (валидируется `vdx publish`).

## Схема (верхний уровень)

```yaml
schema_version: "0.2"             # версия формата (НЕ рубрики)
metadata:
  name: vdx-rubric-vodmal
  version: "0.2.0"                # совпадает с git-тегом
  description: "Personal maturity rubric"
  owner: vodmal
  homepage: "https://github.com/vodmal/vdx-rubric"

scoring:                          # D7
  formula: weighted_two_class
  supporting_threshold: 0.8

levels:                           # L0..L4 определения
  L0: { name: chaos,        description: "..." }
  L1: { name: reproducible, description: "..." }
  L2: { name: testable,     description: "..." }
  L3: { name: gated,        description: "..." }
  L4: { name: exemplar,     description: "..." }

axes:                             # массив осей (см. ниже)
  - id: lifecycle-interface
    class: critical
    ...
```

## Описание оси

```yaml
- id: <kebab-case>
  class: critical | supporting    # D7
  description: "..."
  storage: level | flags          # default: level
  default_target: L4              # целевое значение для этой оси в этой версии
  fact_sources: [<path>...]       # подсказка движку

  # для storage=level:
  levels:
    L1: { requires: <predicate-expr> }
    L2: { requires: <predicate-expr> }
    L3: { requires: <predicate-expr> }
    L4: { requires: <predicate-expr> }

  # для storage=flags (D2 — TS флаги ортогональны):
  stack_implementations:
    php: { flags: [...], level_thresholds: { L4: 0.85, L3: 0.65, ... } }
    node: { flags: [...], level_thresholds: { ... } }
```

### Семантика уровней — delta-style

`levels.LN.requires` описывает ТОЛЬКО **дельту** относительно L(N−1). Уровень
оси вычисляется как **максимальный непрерывный** уровень:

```
achieved = "L0"
for L in [L1, L2, L3, L4]:
  if eval_predicate(axis.levels[L].requires, ctx):
    achieved = L
  else:
    break    # разрыв в цепи — выше не идём
```

Это позволяет писать каждый уровень компактно (только то, что добавляется), без
повторения нижних условий. L0 не описывается — это «всегда true», fallback.

## Predicate-выражение

Единый формат `{ fn: name, args: {...} }` плюс сахарные краткие формы.

```yaml
# Канонический вид
requires:
  fn: all_of
  args:
    - { fn: has_task, args: { task: up } }
    - { fn: has_task, args: { task: down } }

# Сахар (эквивалентно)
requires:
  all_of:
    - has_task: up
    - has_task: down
```

### Базовая библиотека (v0.2)

| Имя | Аргументы | Что проверяет |
|-----|-----------|---------------|
| `always_true` | — | для L0 |
| `has_task` | task | задача с именем `task` в mise.toml / composer scripts / npm scripts / Makefile |
| `has_task_matching` | pattern | regex-имя задачи |
| `has_file` | path | файл/директория от корня проекта |
| `file_contains` | path, pattern | regex-match в файле |
| `package_present` | name, ecosystem? | composer/npm/pip пакет |
| `config_value` | path, jsonpath, op | значение в JSON/YAML/TOML |
| `tsc_flag` | name, equals? | флаг в `tsconfig.json` `compilerOptions` |
| `phpstan_level_at_least` | n | level в `phpstan.neon` |
| `gh_workflow_blocks_pr` | check_name? | анализ `.github/workflows/*.yml` + branch protection |
| `git_hook_installed` | hook | husky/lefthook/cghooks с `hook` |
| `command_succeeds` | cmd | escape-hatch, sandboxed shell |

### Композитные

- `all_of: [...]`
- `any_of: [...]`
- `at_least_n_of: { n, predicates: [...] }`
- `not: <predicate>`

## Пример: ось `lifecycle-interface`

```yaml
- id: lifecycle-interface
  class: critical
  description: "Стандартный словарь глаголов"
  storage: level
  default_target: L4
  fact_sources: [mise.toml, composer.json, package.json, Makefile]
  levels:
    L4:
      requires:
        all_of:
          - has_task: up
          - has_task: down
          - has_task: build
          - has_task: test
          - has_task: check
          - has_task: fix
          - any_of:
              - has_task_matching: "check:before:.*"
              - has_task_matching: "build:.*"
    L3:
      requires:
        all_of:
          - has_task: up
          - has_task: down
          - has_task: build
          - has_task: test
          - has_task: check
          - has_task: fix
    L2:
      requires:
        at_least_n_of:
          n: 3
          predicates:
            - has_task: up
            - has_task: down
            - has_task: build
            - has_task: test
    L1:
      requires:
        any_of:
          - has_file: docker-compose.yml
          - has_file: Makefile
    L0:
      requires: { fn: always_true }
```

## Пример: стек-специфика — `static-analysis` через флаги

```yaml
- id: static-analysis
  class: critical
  storage: flags
  default_target: L4
  description: "Эффективная строгость, не nominal level (D2-уточнение)"
  stack_implementations:
    php:
      flags:
        - { id: phpstan_present,        target: true, weight: 1.0 }
        - { id: phpstan_bleeding_edge,  target: true, weight: 0.5 }
        - { id: phpstan_strict_rules,   target: true, weight: 1.0 }
        - { id: phpstan_symplify_rules, target: true, weight: 0.5 }
        - { id: psalm_present,          target: true, weight: 1.0 }
        - { id: type_coverage_active,   target: true, weight: 0.5 }
      level_thresholds: { L4: 0.85, L3: 0.65, L2: 0.35, L1: 0.10 }
    node:
      flags:
        - { id: tsc_strict,                    target: true, weight: 1.0 }
        - { id: no_unchecked_indexed_access,   target: true, weight: 1.0 }
        - { id: exact_optional_property_types, target: true, weight: 0.5 }
        - { id: no_implicit_override,          target: true, weight: 0.3 }
        - { id: eslint_flat,                   target: true, weight: 1.0 }
        - { id: eslint_type_checked,           target: true, weight: 1.0 }
      level_thresholds: { L4: 0.85, L3: 0.65, L2: 0.35, L1: 0.10 }
```

Каждый `flag.id` соответствует короткому встроенному предикату (`phpstan_present`
≈ `package_present(phpstan/phpstan)`). Полный mapping — в коде движка.

## Открытые вопросы

См. [../decisions.md](../decisions.md): O13 (Тьюринг-полнота композитов — нет в
v0.2), O14 (отношение `schema_version` ↔ `metadata.version`).
