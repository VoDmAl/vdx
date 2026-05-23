# Спека: алгоритм детекта дрейфа

Статус: **draft v0.2**. Как vdx считает дрейф проекта от текущего baseline и от
своего предыдущего состояния. См. [../decisions.md](../decisions.md) D7 (скоринг),
D8 (shared-infra), D9 (overrides), D10 (нативный оценщик).

## Входные данные

1. **Baseline @ version** — owner-рубрика по `baseline:` из манифеста проекта на
   конкретный semver-тег (D11). Если тег не в кэше — `git clone --depth 1` репо
   рубрики, кэш `~/.cache/vdx/rubrics/<owner>/<repo>@<tag>/`.
2. **Project facts** — выход аудит-движка: совокупность результатов предикатов
   на проекте (читает файлы, парсит конфиги, при необходимости вызывает
   shell-команды).
3. **Overrides** — `.vdx-overrides.yml` (D9).
4. **Watermark** *(опционально)* — последнее состояние из `[vdx.audit]` в
   манифесте: `baseline_version_at_run`, `achieved_level`.

## Алгоритм (high-level)

```
1. Load baseline_current at baseline.version from manifest.
   Validate metadata.version == git tag.

2. Apply overrides:
     for each override in .vdx-overrides.yml:
       if override.suppress: mark axis suppressed
       if override.target:   axis.target_for_project = override.target
       if override.until and today > override.until: mark expired (визуально, не блокирует)

3. For each axis in baseline_current.axes:
     skip if suppressed
     facts = run_predicates(axis.fact_sources, project_root)
     achieved = evaluate_axis(axis, facts)             # см. ниже по storage
     target = override.target or axis.default_target
     drift_kind:
       achieved == target → aligned
       achieved <  target → gap
       achieved >  target → over

4. Compute project_level via D7:
     for L in [L4, L3, L2, L1, L0]:
       critical_ok    = all(a.achieved >= L for a in axes if a.class == 'critical' and not suppressed)
       supporting_ok  = share(a.achieved >= L for a in axes if a.class == 'supporting' and not suppressed) >= 0.8
       if critical_ok and supporting_ok: return L

5. (опционально) Watermark drift:
     if manifest [vdx.audit] exists and baseline_version_at_run != baseline.version:
       baseline_prev = load(baseline_version_at_run)
       changed_axes = [a.id for a in baseline_current.axes
                       if axis_target(a) > axis_target(baseline_prev[a.id])]
       report: "baseline raised bar on axes [X, Y]"

6. Emit report.
```

## Predicate evaluation (нативный движок, D10)

Реализация — рекурсивный визитор по предикатному дереву:

```python
def eval_predicate(p, ctx):
    if 'all_of' in p:        return all(eval_predicate(q, ctx) for q in p['all_of'])
    if 'any_of' in p:        return any(eval_predicate(q, ctx) for q in p['any_of'])
    if 'at_least_n_of' in p:
        results = [eval_predicate(q, ctx) for q in p['at_least_n_of']['predicates']]
        return sum(results) >= p['at_least_n_of']['n']
    if 'not' in p:           return not eval_predicate(p['not'], ctx)

    # leaf
    fn, args = parse_leaf(p)
    return REGISTRY[fn](args, ctx)
```

`REGISTRY` — словарь предикат-функций (см. rubric-format.md).
Контекст `ctx` содержит `project_root`, `stack`, кэш чтений файлов.

## Per-axis storage modes

### `storage: level` — delta-style (максимальный непрерывный уровень)

```
achieved = "L0"
for L in [L1, L2, L3, L4]:
  if eval_predicate(axis.levels[L].requires, ctx):
    achieved = L
  else:
    break    # разрыв — выше не идём
```

`levels.LN.requires` описывает только дельту относительно L(N−1). См.
rubric-format.md «Семантика уровней — delta-style».

### `storage: flags`

```
flags_def = axis.stack_implementations[ctx.stack].flags
implemented_weight = sum(f.weight for f in flags_def if check_flag(f, ctx) == f.target)
total_weight       = sum(f.weight for f in flags_def)
ratio              = implemented_weight / total_weight

achieved = "L0"
for L in [L4, L3, L2, L1]:
  if ratio >= axis.stack_implementations[ctx.stack].level_thresholds[L]:
    achieved = L; break
```

## Drift kinds

| `drift_kind` | Семантика | Эффект на exit code | UX |
|-------------|-----------|---------------------|------|
| `aligned`   | achieved == target | OK | зелёное |
| `gap`       | achieved < target  | critical → fail, supporting → warn | жёлтое/красное |
| `over`      | achieved > target  | OK | синее, «впереди стандарта» |

Для **critical** оси `gap` → exit ≠ 0. Для **supporting** → предупреждение.

## Watermark — "Clean as You Code"-style (фаза 2)

UX-прецедент SonarQube: старый код не валит сборку, новый — да. В vdx:

- Если baseline ушёл с `v0.1` → `v0.2`, и проект был сертифицирован на `v0.1`
  как L3, аудит на `v0.2` показывает:
  ```
  Project was certified L3 at baseline v0.1.
  Baseline v0.2 raised bar on axes: tests, shared-infra.
  You are L2 now. To regain L3: close gaps on [tests, shared-infra].
  ```
- Это **не критическая ошибка** — она показывает «куда подтянуться», чтобы
  остаться на прежнем уровне. Полезно при bump-е baseline в манифесте.

## Производительность

Целевой бюджет: **<30 сек** на средний репо для `vdx_audit`. Оптимизации:

- Файлы читаются один раз и кэшируются на сессию аудита.
- `command_succeeds` предикат — последняя линия защиты (escape-hatch), не дешёвый.
- Тяжёлые движки (phpstan, Qlty CLI) запускаются параллельно через mise tasks.
- Результат кэшируется по `(project_hash, baseline_version)`; повторный аудит
  без изменений — мгновенный (читает кэш).

## Открытые вопросы

См. [../decisions.md](../decisions.md): O20 (что делать с `over`), O21 (бюджет
аудита на крупном репо).
