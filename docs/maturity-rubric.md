# Рубрика зрелости — v0.2 (откалибровано по 3 референсам)

Статус: **калибровано** по фактам из 3 проектов (2026-05-22). Версия рубрики — `0.2`.
Скоринг — weighted с двумя классами осей (D7).

> Калибровочные референсы — НЕ «эталоны», а образцы разных состояний реального
> мира. См. [decisions.md](decisions.md) N4.

## Модель

- **Оси** (dimensions). Каждая имеет **целевое значение** на уровень и **класс**:
  `critical` (must-max) или `supporting` (допускается провис).
- **Иерархия осей** (D2): общие («it-general») оси сверху, стек-специфичные
  реализации под ними.
- **Владелец рубрики** (D1) — человек/организация. Проект подключает
  owner-baseline и может локально переопределять/подавлять оси (D9).
- Рубрика **версионируется** semver-тегами (P-D11). Проект указывает версию;
  аудит сверяет с *этой* версией.
- **Скоринг** (D7): уровень проекта = `max(L)`, такой что все critical ≥ L и
  ≥80% supporting ≥ L.

## Уровни

| Уровень | Название | Смысл |
|---------|----------|-------|
| L0 | Хаос | Не поднимается, знание в голове |
| L1 | Воспроизводимый | Поднимается одной задокументированной командой |
| L2 | Тестируемый | Тесты есть; единый словарь `up/test/build` |
| L3 | Защищённый | Статанализ + стиль + CI-гейты на PR (реальные!) |
| L4 | Образец | Полная глубина: хуки, mock-инфра, observability, версионированная общая инфра |

---

## Общие оси

| Ось | Класс | L0 | L1 | L2 | L3 | L4 |
|-----|-------|----|----|----|----|----|
| **lifecycle-interface** | **critical** | Хаос | bare-вызовы (`npm install && node ...`) | 3-4 глагола (up/down/build) | Полный `up/down/build/test/check/fix` | + иерархия (`check:before:commit/push`, `build:*`, `test:*`) |
| **tests** | **critical** | Нет | Один прогон | unit/integration разделены | + coverage measured | + threshold + e2e + mutation |
| **static-analysis** | **critical** | Нет | Один линтер базово | tsc strict / phpstan low | + полная строгость (см. стек) | + двойной слой (phpstan+psalm / tsc+eslint+typed-rules) + кастомные метрики |
| **ci** | **critical** | Нет | Только deploy | check/test есть | + **реально гейтит** PR (нет `\|\| true`!) | + matrix + блок merge + sentry release |
| **reproducibility** | supporting | Прозой | docker-compose | + version диапазон | + pinned versions (`.tool-versions` / `mise.toml`) | + onboarding одной командой |
| **code-style** | supporting | Нет | Маньяк | Форматтер настроен | enforced в `check` | + комбинация (ECS+PHPCS / prettier+eslint-stylistic) |
| **dependency-hygiene** | supporting | Lockfile не закоммичен | Lockfile | + `audit` / `security-advisories` | + Renovate/Dependabot | + require-checker / deptrac / knip + jack/outdated |
| **secrets-config** | supporting | Секреты в репо | `.env` | `.env.example` | + linter | + vault/sops |
| **git-hygiene** | supporting | Нет | `.gitignore` | husky/lefthook/cghooks установлен | + pre-commit + pre-push + commit-msg | + post-commit + post-merge |
| **observability** | supporting | Нет | print/console.log | structured logging | + Sentry/error tracking | + healthcheck + uptime monitor + auto-release |
| **docs** | supporting | Нет | README базово | + структурированный `docs/` | + `CLAUDE.md` + `CHANGELOG` (или `PROJECT_CHANGELOG.md`) | + ADR + onboarding.md + architecture.md |
| **mock-infra** | supporting | Внешние API в тестах | hand-rolled fixtures | mock-сервер (`msw`/nock) | + dedicated docker-сервис | + CI-валидация что mock не утечёт в prod |
| **shared-infra** | supporting | Голые порты, конфликты | Docker, hardcoded порты | Shared proxy (Traefik/nginx-proxy) — ручное | + автоподъём в `up` (precheck) | + **отдельный версионированный репо/пакет** с self-provisioning |
| **shared-infra-drift** | supporting | Никогда не сверялось | Скопировано без pointer | Pointer-комментарий (`Based on:`) | + хеш-сверка с источником | + автообновление от источника (n/a если shared-infra уже L4) |

> Принципиальные изменения v0.2 vs v0.1:
> - ось `ci` проверяет **реальное гейтование**, не наличие workflow;
> - ось `static-analysis` хранится как **набор флагов**, не одно число;
> - ось `shared-infra` пересобрана: качество подхода + автопровижининг (D8);
> - добавлена ось `shared-infra-drift` как подось `shared-infra`.

---

## Стек-специфичные реализации

### PHP

| Ось | L2 | L3 | L4 |
|-----|----|----|----|
| static-analysis | phpstan level 5-6 | phpstan level 7-8 | phpstan **level 0 + bleedingEdge + strict-rules + symplify-rules** *или* level 9, **+ psalm errorLevel 2** |
| code-style | rector | + ecs *или* phpcs | + ecs **и** phpcs (двойной слой) |
| dep-hygiene | composer audit | + roave/security-advisories + composer-require-checker | + deptrac + jack + pdepend |
| metrics | — | — | comments-density, class-leak, lines, type-coverage, cognitive-complexity, unused-public |
| git-hooks | — | brainmaestro/composer-git-hooks pre-commit | + pre-push + commit-msg + post-commit + post-merge |
| modernization | — | rector с framework sets | + LevelSetList UP_TO_PHP_NN + CODE_QUALITY + DEAD_CODE + TYPE_DECLARATION |

### Node / TypeScript

| Ось | L2 | L3 | L4 |
|-----|----|----|----|
| static-analysis | `tsc --strict` | + `noUncheckedIndexedAccess` | + `exactOptionalPropertyTypes`, `noImplicitOverride`, **+ ESLint flat config с `@typescript-eslint/recommended-type-checked`** |
| code-style | — | prettier *или* biome | prettier/biome + ESLint stylistic |
| dep-hygiene | npm audit | + Renovate/Dependabot | + knip + depcheck |
| git-hooks | — | husky/lefthook pre-commit | + pre-push + commit-msg |
| tests | jest/vitest | + Playwright/Cypress | + Stryker mutation |

> **D2-уточнение**: PHP `phpstan level` — *монотонная* шкала. TS флаги
> *ортогональны*. Поэтому ось `static-analysis` = набор флагов, не одно число.
> Кросс-стек сравнение (O6) — через долю включённых строгих флагов / максимум.

---

## Калибровка по референсам (2026-05-22)

| Ось | Класс | telegram (PHP, эксперим.) | t23b (PHP, mid) | bookmap (Node/TS) |
|-----|-------|---------------------------|-----------------|-------------------|
| lifecycle-interface | **C** | **L4** (иерархия check:before:*) | **L4** (up/down/build:*/test:*/check:*/fix) | L3 (docker:* без test/check/fix наверху) |
| tests | **C** | L3 (unit+integration, нет threshold) | **L4** (Unit + Integration + Functional + E2E + Jest) | **L1** (фреймворк есть, тестов нет) |
| static-analysis | **C** | **L4** (phpstan lvl 0 + bleedingEdge + symplify + psalm) | L3 (phpstan lvl 6, без psalm) | L2 (`strict` без orthogonal флагов, без ESLint) |
| ci | **C** | **L2** (нет PR-гейтов, реально гейтит pre-push) | **L2** (composer validate + twig lint) | **L2** (видимость L4, test обёрнут в `\|\| true`) |
| reproducibility | s | L2 | L2 | L2 |
| code-style | s | **L4** (ECS + PHPCS) | L1 (только twig lint) | **L0** |
| dependency-hygiene | s | **L4** minus deptrac (отключён) | L2 | **L1** (lock в .gitignore) |
| secrets-config | s | L3 (.env.example + lintnet) | L2 | L2 |
| git-hygiene | s | **L4** (cghooks полный набор) | **L0** | **L0** |
| observability | s | **L4** (Sentry + Monolog + Sentry release в CI) | L3 (Sentry + Monolog + Cronitor) | L3 (Sentry + Winston + healthcheck) |
| docs | s | L3 (нет CHANGELOG) | **L4** (PROJECT_CHANGELOG + docs/ + CLAUDE) | **L4** (40+ файлов + PROJECT_CHANGELOG + CLAUDE) |
| mock-infra | s | **L4** (phiremock через supervisorctl) | **L0** | **L4** (docker-сервис + CI-проверка против prod-утечки) |
| shared-infra | s | L1 (локальный supervisord) | L2 (есть Traefik-pattern, ручное поднятие) | L3 (Traefik + автоподъём в `docker-up.sh`) |
| shared-infra-drift | s | n/a | n/a (источник) | **L2** (есть pointer `Based on:`, нет хеш-сверки) |

### Уровень по D7 (weighted scoring)

| Проект | Критические | Supporting (≥80% на уровне) | **Итог** |
|--------|-------------|-----------------------------|----------|
| **telegram** | lifecycle L4, tests L3, static L4, **ci L2** | большинство L3-L4 | **L2** (capped by ci) |
| **t23b** | lifecycle L4, tests L4, static L3, **ci L2** | смешанно (git-hygiene L0, mock-infra L0) | **L2** (capped by ci) |
| **bookmap** | lifecycle L3, **tests L1**, static L2, ci L2 | смешанно | **L1** (capped by tests) |

**Главный сигнал калибровки**: все три проекта **упираются в `ci`-ось при L3+**.
Локальные git-hooks (telegram) и обёртки `|| true` (bookmap) не считаются за CI.
Это самый высокий рычаг для роста зрелости портфеля проектов.

---

## Открытые вопросы

Ведутся в [decisions.md](decisions.md). Активные после v0.2: O6 (конкретный
список флагов на стек), O7 (точный набор глаголов), O9 (devbox/Nix поверх mise).
Остальные закрыты решениями D1–D8 и предложениями P-D9–P-D11.
