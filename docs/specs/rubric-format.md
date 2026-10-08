# Спека: формат рубрики (baseline)

Статус: **schema 0.3** (vdx 0.22+). Описывает структуру файла owner-baseline. См.
[../decisions.md](../decisions.md) D1 (owner-baseline), D7 (скоринг), D11
(хранение в отдельном репо с semver-тегами). Что поменялось в 0.3 — раздел
«Schema 0.3» ниже; разбор — `docs/tasks/vdm-gates-wiring-axis/` (DL #11–#20).

## Расположение
Корневой файл репозитория-рубрики: `vdx-rubric.yaml`.
Версия задаётся git-тегами (`v0.2.0`); содержимое файла должно совпадать с
`metadata.version` (валидируется `vdx publish`).

## Схема (верхний уровень)

```yaml
schema_version: "0.3"             # версия формата (НЕ рубрики)
metadata:
  name: vdx-rubric-vodmal
  version: "1.0.0"                # совпадает с git-тегом
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
  applies_to: [<stack-id>, ...]   # optional, v0.2.2+ — см. ниже
  applies_when: <predicate-expr>  # optional, v0.3.1+ — см. ниже
  clone_check: git-hooks          # optional, schema 0.3 — пометка клона рядом с осью
  storage: level | flags          # default: level
  default_target: L4              # целевое значение для этой оси в этой версии
  fact_sources: [<path>...]       # подсказка движку

  # для storage=level:
  levels:
    L1: { requires: <predicate-expr> }
    L2: { requires: <predicate-expr> }
    L3: { requires: <predicate-expr> }
    L4: { requires: <predicate-expr> }   # или { not_required: true } — schema 0.3

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

## Schema 0.3

**Версия схемы читается строго.** CLI знает, до какой схемы читает (vdx 0.22 —
до `0.3`), и сет новее отвергает с ошибкой «обнови vdx», а не читает молча по
старым правилам. Сеты старее читаются как раньше: тот же тег — та же оценка при
любом CLI.

**Предикат отвечает «да», «нет» или «неизвестно» с причиной.** «Неизвестно» —
факт, которого vdx здесь прочесть не может: CI-система, которую он не разбирает,
защита ветки, которую знает только хостинг. Композиты трёхзначные: `any_of`
истинно только по истинной ветке, `all_of` ложно по любой ложной, иначе —
«неизвестно»; `not` оставляет «неизвестно» как есть. Подъём по уровням на
«неизвестно» останавливается: в общем уровне это «не выполнено», а отчёт
называет непроверенный уровень и причину (раздел «Not checked»). Не L0
(ложно-красное без сети) и не исключение оси (ложно-зелёное).

**`not_required: true` — уровень, на котором ось ничего не требует.**
`branch-protection` гейт — свойство L3, ниже ось уровень не ограничивает:

```yaml
levels:
  L1: { not_required: true }
  L2: { not_required: true }
  L3: { requires: { branch_requires_checks: {} } }
  L4: { not_required: true }
```

Для общего уровня такой уровень засчитан; в отчёте достижением не
показывается: незащищённый репозиторий видит «—», а не «L2». В JSON-отчёте
`achieved` — засчитанный уровень, `not_required` — список таких уровней,
`unknown` — `{ level, reason }`.

**`clone_check` — свойство клона рядом с осью.** Включены ли хуки в этом клоне
— не уровень: тот же репо и тот же тег дали бы разный отчёт по клонам. Ось
называет проверку (`git-hooks`), `vdx audit` печатает её результат пометкой
(⚑ и раздел «In this clone»), уровень не меняется. Ту же проверку печатает
строкой `vdx doctor`.

**Три предиката ушли.** `gh_workflow_blocks_pr`, `git_hook_installed`,
`command_succeeds` обещали больше, чем проверяли. Сет schema 0.3, который
называет любой из них — или незнакомое имя, — не загружается. Для сетов 0.2
они остаются в реестре как были.

### `applies_to` — stack-фильтр (v0.2.2+)

Опциональное поле `applies_to: [<stack-id>, ...]` на оси ограничивает
применимость оси набором стеков. Если задан и `ctx.stack` не входит в список,
ось получает `drift_kind: excluded`, `achieved: L0` (placeholder), и
**не учитывается в `projectLevel`** (как `suppressed`).

```yaml
- id: tests
  class: critical
  applies_to: [php, node, go, python]
  ...
```

Пример: `tests` опирается на phpunit/jest/vitest/pytest — для проекта со
`stack: meta` (документация + nested CLI без manifest в корне) ось становится
excluded, а не лживым L0.

Семантика и инварианты:
- Отсутствие `applies_to` ≡ ось применима ко всем стекам (универсальная).
- Список перечисляет конкретные stack id'ы из `autoDetectStack`: `php`,
  `node`, `go`, `python`; `monorepo`, `meta`, `unknown` обычно НЕ
  включаются.
- `excluded` ось не блокирует критический gate в `projectLevel`.
- Не пересекается с `suppress` из `.vdx-overrides.yml` (применяются независимо).
- Override в `.vdx-overrides.yml` с явным `target` НЕ обходит `applies_to`:
  axis всё равно `excluded` если stack не в списке.

### `applies_when` — predicate-фильтр (v0.3.1+)

Опциональное поле `applies_when: <predicate-expr>` даёт более точный
гейтинг, чем `applies_to`: ось применяется только если предикат истинен
относительно того же `evalCtx`, что используется для уровней. Если ложен —
ось получает `drift_kind: excluded` (та же семантика).

Применяется **после** `applies_to`: stack-фильтр срабатывает первым, и
если ось уже `excluded` по стеку, `applies_when` не вычисляется.

```yaml
- id: release-artifact
  applies_to: [node, php, ruby, python]
  applies_when:
    any_of:
      - all_of:                            # Node lib intent
          - has_file: package.json
          - not: { config_value: { path: package.json, jsonpath: private, equals: true } }
          - any_of:
              - config_value: { path: package.json, jsonpath: publishConfig, op: present }
              - config_value: { path: package.json, jsonpath: bin,           op: present }
              - config_value: { path: package.json, jsonpath: main,          op: present }
              - config_value: { path: package.json, jsonpath: exports,       op: present }
              - config_value: { path: package.json, jsonpath: module,        op: present }
      - all_of:                            # PHP lib intent
          - has_file: composer.json
          - config_value: { path: composer.json, jsonpath: name, op: present }
          - not: { config_value: { path: composer.json, jsonpath: type, op: equals, equals: "project" } }
```

Семантика и инварианты:
- Отсутствие `applies_when` ≡ ось применима ко всем проектам в пределах
  `applies_to` (текущее поведение для большинства осей).
- DSL предиката идентичен `levels.LN.requires`: `all_of`/`any_of`/`not`/
  `at_least_n_of` + базовая библиотека предикатов.
- Evaluator использует тот же `evalCtx`, что и для уровней: для осей с
  `applies_to` это `resolveSubpackageCtx(ctx, manifest)` (т.е.
  subpackage-aware), что важно для проектов вроде vdx с
  `primary_subpackage: cli`.
- `excluded`-по-`applies_when` не блокирует критический gate в
  `projectLevel` — как и `excluded`-по-`applies_to`.
- Не пересекается с `suppress` из `.vdx-overrides.yml`: override
  применяется только если ось не `excluded`.

**Когда использовать `applies_when` вместо просто `applies_to`**: когда
применимость зависит от характеристик проекта внутри стека (lib vs app,
наличие docker-compose, размер кодовой базы), не только от языка/манифеста.
Альтернатива — вынести "тип проекта" в `facts.ts` как агностичный факт
(`project_kind`) и использовать через предикат — мы не делаем это пока
только одна ось требует различения (YAGNI).

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

### Базовая библиотека

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

Ось `ci` — сигнал, по файлам GitHub Actions (schema 0.3). У других CI-систем
(GitLab CI, CircleCI) — «неизвестно»; «нет» из GHA рядом с другой системой —
тоже «неизвестно»: та может делать то, чего нет в GHA.

| Имя | Аргументы | Что проверяет |
|-----|-----------|---------------|
| `gha_tests_on_push` | pattern? | workflow, запускаемый push'ем в `main`/`master` (фильтр веток или без него), выполняет шаг тестов; шаг с `\|\| true` / `continue-on-error` не засчитывается, PR-триггер — тоже |
| `gha_runs_tasks` | tasks | на том же push'е CI вызывает каждую задачу `tasks` (или её `name:*`) через раннер проекта — `mise run`, `vdx`, `composer`, `npm run`, `yarn`, `pnpm`, `make` |
| `gha_test_matrix` | pattern? | проверяющая задача идёт по `strategy.matrix` |
| `gha_ship_needs_checks` | pattern? | каждая задача, что выкладывает или выпускает (`deploy`/`release`/`publish` в id или имени), ждёт проверяющую через `needs:` |

Ось `branch-protection` (schema 0.3):

| Имя | Аргументы | Что проверяет |
|-----|-----------|---------------|
| `branch_requires_checks` | — | основная ветка принимает изменения только после обязательной проверки. Знает только хостинг; расширения нет — «неизвестно» везде |

Ось `git-hygiene` (schema 0.3) — на общем распознавателе фреймворков хуков
(husky, lefthook, simple-git-hooks, cghooks, `.githooks`), тот же у `vdx doctor`:

| Имя | Аргументы | Что проверяет |
|-----|-----------|---------------|
| `git_hooks_arranged` | — | репо объявляет хуки, и каждый фреймворк включается шагом установки сам: husky в `prepare`/`postinstall` (под Yarn 2+ — только `postinstall`), пакеты lefthook / simple-git-hooks, `cghooks add` в composer `post-install-cmd`, `git config core.hooksPath` в шаге установки или задаче `up` |
| `git_hook_runs_task` | tasks | pre-commit или pre-push вызывает задачу словаря (`test`, `check`, их `name:*`) через раннер проекта |
| `git_hook_covers_ci` | tasks | pre-push вызывает все задачи словаря, которые CI вызывает на push в main; composer `@`-ссылки, `npm run` и mise `depends` раскрываются |

Только для сетов schema 0.2: `gh_workflow_blocks_pr` (видел лишь
`pull_request` в `on:`, а не защиту ветки), `git_hook_installed` (наличие файла
хука — не установка), `command_succeeds` (заглушка с вечным `false`).

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
