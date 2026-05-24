# vdx — Handoff (2026-05-24, после A–X.1.c: @vodmal/vdx-cli@0.4.0 опубликован — D12 прошёл real-world validation)

Документ-onboarding для продолжения работы в новой чистой сессии. Читать
**первым** перед всем остальным.

---

## TL;DR за 30 секунд

**vdx** — тонкая надстройка над mise: единый словарь команд
(`up/down/build/test/check/fix`) + версионируемая рубрика зрелости с drift-детектом
+ исполняемый манифест для AI-агента. Свой код только в 4 пунктах ядра
(см. [README.md](README.md)).

**Где мы сейчас**: 25 шагов пройдены (A–W + X.1.a + X.1.b + X.1.c). Owner-
рубрика на **github.com/VoDmAl/vdx-rubric-vodmal@v0.3.1**. CLI на npm как
**[@vodmal/vdx-cli@0.4.0](https://www.npmjs.com/package/@vodmal/vdx-cli)**
(опубликован в Шаге X.1.c через `vdx publish minor` на самом себе).
DEFAULT_BASELINE `@v0.3.1`. **D12 MVP для Node прошёл real-world validation**.

**Шаг X.1.c (2026-05-24)** — первый real-world dogfood D12. Cleanup
устаревших `@v0.2.1` baseline-refs в README/plugin/docs + критбаг в
`mcp-server.ts:159` (commit `515cfe8`). Затем `npx tsx cli/src/index.ts
publish minor` из vdx root: 4/4 pre-flight OK → bump `cli/package.json`
0.3.0 → 0.4.0 → `npm publish` с интерактивным OTP → commit `cd3eca9
release: v0.4.0` → tag `v0.4.0` → `git push --follow-tags`. `npm view
@vodmal/vdx-cli version` подтверждает `0.4.0`. Side-finding: post-handoff
audit показал что rubric tags v0.3.0/v0.3.1 на vdx-rubric-vodmal уже на
remote — HANDOFF числил их как open blocker, stale (`s1-187`).

**Шаг X.1.b (2026-05-24)** — execute pipeline: `executePublish()` делает
bump package.json → `npm publish` (irreversible, через `execFileSync` с
inherit-stdio для OTP) → revert на failure → `git add/commit/tag`.
Не пушит — это решение пользователя. `delegated-to-mise` ветка exec'ает
`mise run publish`. D12 MVP для Node end-to-end закрыт.

**Шаг X.1.a (2026-05-24)** — D12 MVP первая часть: `vdx publish
<patch|minor|major>` + 4 pre-flight check'а + рендер plan. **Без**
execute pipeline (npm publish + git commit/tag) — это X.1.b.
Файлы: `cli/src/publish.ts` (~270 строк), `cli/tests/unit/publish.test.ts`
(11 кейсов), dispatch в `index.ts`. Pre-flight: working-tree-clean,
lib-intent (applies_when), release-artifact ≥ L3, registry-collision
(`npm view <pkg> version`). `[tasks.publish]` в mise.toml →
**delegating to mise** (D3 escape hatch). Effective stack резолвится
через `primary_subpackage` — vdx root (meta) корректно publish'нул бы
cli/ как Node. Security: `execFileSync` (argv-array, без shell-injection).
76 тестов проходят (65→76).

**Шаг W (2026-05-24)** — `vdx init` transparency + monorepo fallback
(O39 закрыт). Догфудинг на 3 калибровочных проектах показал что эвристика
mapVerb **работала**, но не показывала почему/из чего выбран скрипт, и
не подхватывала monorepo-style `server:test`. Изменения:
- `selectVerbTask(verb, tasks): { task, reason, alternatives }`:
  exact → alias → prefix-group → **suffix-group** (новый шаг для
  `<dir>:test` / `:lint`).
- `VerbMapping` обогащён `reason` + `alternatives[]`.
- Расширены Node-aliases (`vitest`, `tsc`, `typecheck`, `eslint`,
  `prettier:check`, `prettier:fix`, etc).
- Plan-output: колонка `Reason` + блок `Alternatives considered`.
- `mise.toml`: комментарий `# vdx: matched "<task>" via <reason>; alt: ...`
  перед каждым `[tasks.X]` если reason ≠ exact или alt непустые.
Эффект: telegram/t23b 6/6 (видны альтернативы), bookmap **3/6 → 4/6**
(`test` через suffix-group). 8 новых тестов; 65/65 проходят.
Smoke L2/L1/L1 без регрессий.

**Шаг V (2026-05-24)** — research-финализация **D12** (publish verb):
3 параллельных landscape-агента (Node / PHP+Python / cross-stack+deploy),
все 7 OQ resolved, D12 принято в Decided секцию. Краткое:
- `vdx publish` как **7-й lifecycle verb**, lib-gated через
  `applies_when` (переиспользует O35).
- **Subverb-style** + **arg-form**: `vdx publish [patch|minor|major]`
  делает full default pipeline; `:bump`/`:upload`/`:tag`/`:notes` для
  granular.
- **vdx институциализирует stack-specific defaults** (npm/composer/twine/cargo/gem) — user не учит ecosystem-specific commands.
- **Pre-flight gating через рубрику** — рубрика становится executable
  contract (новый use-case).
- `deploy` → D13 (отложен). `release` meta-verb отвергнут.
- 3 новых deferred items: **O36** (release-workflow ось), **O37**
  (`vdx bump` standalone), **O38** (native monorepo publish, D14+).
- Implementation phased: MVP=Node, Phase 2=PHP+Py, Phase 3=Cargo/Ruby/Go/Java.

Подробно: [docs/decisions.md](docs/decisions.md) → D12 секция;
[docs/research/publish-deploy.md](docs/research/publish-deploy.md) —
полный research + OQ1-OQ7 resolutions.
External-facing docs (главный README, vdx-rubric-vodmal README/CHANGELOG)
переведены на английский 2026-05-24; внутренние (HANDOFF, CLAUDE,
PROJECT_CHANGELOG, docs/) — русский.

**Шаг P / vitest**: добавлен vitest + 47 unit-тестов на `scoring.ts` и
`predicates.ts` (через фикстуры `tests/fixtures/`). `package.json` scripts:
`test` = `vitest run`, `typecheck` отдельно, `test:unit` + `coverage`
добавлены. CI workflow обновлён — typecheck и тесты как раздельные шаги.

vdx сейчас: stack=meta, lifecycle L2, **tests L3**, **ci L4**,
**release-artifact L4**, overall **L1**. Per-axis после R:
- tests **L3** (vitest + test:unit + coverage)
- ci L4 (matrix node 20/22)
- **release-artifact L4** (publishConfig + homepage + bugs в cli/)
- lifecycle-interface L2 (3 verb'а: build/test/check)
- static-analysis **L2** (tsc strict через cli/)
- reproducibility **L1** (Makefile)
- code-style **L1** (cli/.editorconfig)
- dependency-hygiene **L1** (lockfile)
- mock-infra **L1** (на Linux) / L2 (на macOS, case-FS false positive)
- observability **L1**, git-hygiene **L1**, docs **L3**
- secrets-config / shared-infra / shared-infra-drift — **suppressed**
  через `.vdx-overrides.yml` (vdx — meta-CLI, эти оси не применимы).

Supporting visible = 8 (11 - 3 suppressed), все на L1+ → ratio 1.0 ≥ 0.8.
Critical min L2 ≥ L1. **Overall L1**. Две оси на L4 (ci, release-artifact).

Чтобы L2 overall: нужно 6/7 supporting на L2+ (сейчас только docs L3 и
mock-infra L2 = 2/7 = 0.29). Это сильно больше работы — prettier+eslint,
engines.node на root, стабильный mock-infra на Linux. Отложено.

**Следующий шаг** (приоритеты после X.1.c):
- **Шаг X.2 — Subverbs**: `publish:bump`, `publish:upload`,
  `publish:tag`, `publish:notes` для granular control.
- **Шаг X.3 — Phase 2**: PHP (composer.json edit) + Python
  (`pyproject.toml`).
- **Шаг X.4 — Phase 3**: Cargo/Ruby/Go/Java.
- **O25** — mock-infra delta-trap (Node-проекты с docker-mock).
- **O26/O27** — TOML round-trip, shared-infra precheck.
- **O32** — multi-subpackage monorepo (отложено до реальных пользователей).
- **O36** — release-workflow ось (после D12 ship + N≥3 lib).
- **O37** — `vdx bump` как standalone verb (после поля-feedback).
- **O38** — native monorepo-aware publish (D14+).
- **supporting L2** (отложено) — prettier+eslint, engines.node, etc.

---

## Карта артефактов

### Основной проект (этот репо)
```
vdx/
├── README.md                   ← публичное описание проекта (vision + статус)
├── CLAUDE.md                   ← правила для агента (ограничения + ссылки)
├── HANDOFF.md                  ← ЭТОТ ФАЙЛ
├── PROJECT_CHANGELOG.md        ← хронология (свежее сверху)
├── mise.toml                   ← догфудинг (stack=meta, 3 verbs → cli/) ← Шаг H
├── docs/
│   ├── decisions.md            ← ⭐ ИСТОЧНИК ПРАВДЫ: Decided D1–D11, Open O6/7/9/13–24, Observed N1–N13
│   ├── landscape.md            ← обзор аналогов (делает/не делает) — верифицирован 2026-05-22
│   ├── maturity-rubric.md      ← рубрика v0.2 калибровано
│   ├── decision.md             ← итог build-vs-adopt
│   └── specs/                  ← спека ядра v0.2 (draft)
│       ├── rubric-format.md         ← формат owner-baseline + predicate DSL
│       ├── manifest-format.md       ← [vdx] блок в mise.toml + AGENTS.md projection
│       ├── overrides-format.md      ← .vdx-overrides.yml schema
│       ├── mcp-api.md               ← MCP API контракт
│       ├── drift-algorithm.md       ← скоринг D7 + drift
│       └── vdx-rubric.example.yaml  ← полный инстанс v0.2 (14 осей)
└── cli/                        ← TypeScript evaluator v0.1 (шаг C)
    ├── README.md
    ├── package.json
    ├── tsconfig.json
    ├── smoke.sh                ← `bash smoke.sh` гонит аудит на 3 референсах
    └── src/                    ← 9 модулей, ~600 строк
```

### Внешний репо (созданный в шаге B)
```
/Users/vdm/AI Projects/vdx-rubric-vodmal/   ← локально, тег v0.2.0
├── vdx-rubric.yaml             ← канонический файл рубрики
├── README.md
├── CHANGELOG.md
└── .gitignore
```
Push на GitHub НЕ делали — требует авторизации пользователя.

### Калибровочные референсы (НЕ эталоны)
- `/Users/vdm/PhpstormProjects/git.vorobyev.name/telegram.vorobyev.name` — PHP,
  экспериментально-глубокий, местами over-engineered. evaluator: **L1**.
- `/Users/vdm/PhpstormProjects/git.vorobyev.name/www.t23b.org` — PHP, mid;
  ИСТОЧНИК паттерна `misc/traefik-global`. evaluator: **L0**.
- `/Users/vdm/AI Projects/trading-tools-bookmap` — Node/TS, смешанное;
  имеет копию `misc/traefik-global` из t23b. evaluator: **L1**.

---

## Принятые решения (коротко, полная версия в decisions.md)

| ID | Дата | Решение |
|----|------|---------|
| D1 | 2026-05-22 | Owner-рубрика как набор правил человека/орг |
| D2 | 2026-05-22 | Иерархия: general → стек-специфика |
| D3 | 2026-05-22 | Раннер — оседлать **mise** (не свой) |
| D4 | 2026-05-22 | Манифест ≈ `mise.toml` + `[vdx]` блок; проекция в `AGENTS.md` |
| D5 | 2026-05-22 | Аудит — оседлать Scorecard/Qlty/MegaLinter/copier; своё только rubric+drift |
| D6 | 2026-05-22 | Упаковка для Claude Code — плагин (MCP + skill + hook) |
| D7 | 2026-05-22 | Скоринг weighted, два класса: critical (must-max) + supporting (≥80%) |
| D8 | 2026-05-22 | Ось `shared-infra` = качество подхода + автопровижининг (не drift-файлов) |
| D9 | 2026-05-22 | Override = `.vdx-overrides.yml` copier-style |
| D10 | 2026-05-22 | Движок оценки — нативный, не OPA |
| D11 | 2026-05-22 | Baseline-рубрика в отдельном git-репо с semver-тегами |

---

## Главные находки (must-read для контекста)

1. **N1 / N3** — паттерн `misc/traefik-global` физически скопирован из t23b в
   bookmap (комментарий `Based on:`). Буквальное доказательство дрейфа.
2. **N7** — версионируемой рубрики с drift локально не делает никто. vdx ≈
   офлайн single-developer срез IDP-скоркарда (Soundcheck/Cortex/OpsLevel/Port).
3. **N9** — AGENTS.md прозой; MCP — единственный зрелый путь к программному
   перечислению команд для агента.
4. **N10** — `self-improving-agent` (markdown) и `claude-smart` (SQLite + ONNX)
   уже занимают «личную память». vdx комплементарен: они = проза, vdx =
   исполняемый контракт проекта.
5. **N12 — Smoke evaluator на 3 референсах**: telegram L1, t23b L0, bookmap L1.
6. **⭐ N13 — Главный leverage point — `lifecycle-interface`, не `ci`**. Все три
   проекта capped из-за отсутствия bare-глаголов. Это именно то, что vdx решает.
7. **N18 — Догфудинг показал три новые ямы**: detector слепнет на nested
   manifest (O28), init бесполезен при stack=unknown (O29), meta-стек capped
   на критических осях из-за stack-специфичных предикатов (O30). vdx сейчас
   stack=meta, lifecycle L2, overall L0.
8. **N19 — Шаг I закрыл O28-A (detection)**. `autoDetectStack` теперь
   root-first + depth-1 fallback; vdx auto-detect: `unknown` → `node`. Но
   предикаты пока root-only — sub-package-aware evaluation остаётся под O30.
9. **N20 — Шаг J закрыл O30 (applies_to filter, рубрика v0.2.2)**. 5
   stack-specific осей помечены `[php, node, go, python]`; stack=meta
   получает `excluded` на них. Lying-L0 устранён, остался реальный L0 у
   vdx из-за отсутствия CI. Sub-package-aware predicate evaluation
   переехал в **O31**.

---

## Что делать дальше — 4 предложенных шага

### Шаг D — Дотюнить evaluator v0.2 ✅ (2026-05-23)

O22/O23/O24 закрыты. Smoke: telegram L1→**L2**, t23b L0→**L1**, bookmap L1.
Новый Open: **O25** — Node-проекты с mock-as-docker-service не имеют
mock-infra L2 предиката (delta-style ловушка). См. N14 в decisions.md.

### Шаг E — `vdx init` ✅ (2026-05-23)

Реализован в `cli/src/init.ts` + `vdx init <path>` в `index.ts`. Флаги
`--dry-run`, `--force`, `--baseline <ref>`. Эффект на копиях:
t23b lifecycle L2→**L4**, bookmap lifecycle L1→**L2**, reproducibility
L2→**L4**. См. N15 в decisions.md.

### Шаг F — MCP-сервер ✅ (2026-05-23)

Реализован в `cli/src/mcp-server.ts`. 9 tools: `list_capabilities`,
`vdx_up/down/build/test/check/fix`, `vdx_audit`, `vdx_record_success_path`.
Запуск: `vdx-mcp --project <path>` (или из cwd). Конфиг в Claude Code:
```json
{ "mcpServers": { "vdx": { "command": "npx", "args": ["-y", "tsx",
  "/Users/vdm/AI Projects/vdx/cli/src/mcp-server.ts",
  "--project", "/path/to/project"] } } }
```
Открыто: O26 (TOML round-trip с комментариями), O27 (реальный shared-infra
precheck). См. N16.

### Шаг G — Claude Code плагин ✅ (2026-05-23)

`vdx/plugin/`: manifest, MCP config, skill, hook. Установка локально через
`--plugin-dir` либо `extraKnownMarketplaces` в `~/.claude/settings.json`.
Marketplace-release требует выноса CLI в npm package. См. N17 +
[plugin/README.md](plugin/README.md).

### Шаг H — Догфудинг на самом vdx ✅ (2026-05-23)

Baseline-аудит → положен корневой `mise.toml` (написан руками, stack=meta,
3 verbs → `cli/`) → второй аудит. Результаты:

| Этап | stack | lifecycle-interface | overall |
|------|:-----:|:-------------------:|:-------:|
| baseline | unknown | L0 | L0 |
| после mise.toml | **meta** | **L2** | L0 |

Открыты три задачи: **O28** (monorepo detector), **O29** (init при unknown/
meta), **O30** (стек-нейтральные предикаты для meta). См. N18 +
расширение O28/O29/O30 в [docs/decisions.md](docs/decisions.md).

### Шаг I — Monorepo/subpackage stack detection ✅ (2026-05-23)

`autoDetectStack` в `cli/src/facts.ts` теперь root-first + depth-1 fallback
с игнор-листом (`node_modules`/`vendor`/`dist`/...). Новая функция
`findSubPackages(projectRoot): SubPackage[]` для будущих sub-package-aware
предикатов. Smoke без регрессий (telegram L2, t23b L1, bookmap L1).
Auto-detect на vdx без декларации: `unknown` → **`node`** через `cli/`.
**O28 закрыт частично** — detection-сторона работает; predicate-evaluation
sub-package-aware остаётся под O30. См. N19.

### Шаг J — applies_to filter (O30 закрыт, рубрика v0.2.2) ✅ (2026-05-23)

В `Axis` добавлено optional поле `applies_to: [<stack-id>, ...]`. Если задан
и `ctx.stack` не в списке — ось получает `drift_kind: excluded`, не
учитывается в overall scoring. В canonical-рубрике v0.2.2 помечены 5 осей
`[php, node, go, python]`: critical (tests, static-analysis) + supporting
(code-style, dependency-hygiene, mock-infra). Аудит vdx (stack=meta): 5
осей корректно excluded; overall L0 теперь по реальной причине (`ci L0`,
у vdx буквально нет GitHub Actions). Lying-L0 на 3 критических осях
устранён. Sub-package-aware predicate evaluation для stack=node + nested
manifest — переехало в **O31**. См. N20.

Тег `v0.2.2` push'нут на GitHub 2026-05-23 — manifest-ссылки `@v0.2.2`
резолвятся.

### Шаг K — `primary_subpackage` (O31 закрыт) ✅ (2026-05-23)

Добавлено optional поле `[vdx].primary_subpackage` в `VdxManifest`
(`cli/src/manifest.ts`). В `cli/src/audit.ts` новая функция
`resolveSubpackageCtx(ctx, manifest)` строит derived `Ctx` с заменённым
`projectRoot` для осей с `applies_to`. Приоритет: explicit-from-manifest →
auto-resolve через `findSubPackages()` когда ровно один subpackage с
`stack === ctx.stack` → fallback на root. Owner-рубрика без изменений
(формат не менялся, v0.2.2 актуальна).

Контрольные точки:
- `npx tsc --noEmit` — чисто.
- Smoke на 3 референсах: L2/L1/L1 — никаких регрессий (у них manifest в
  корне, `findSubPackages` пустой → fallback на root).
- Dogfooding (копия vdx, stack=node + primary_subpackage=cli):
  `static-analysis` L2 (tsc strict), `dependency-hygiene` L1 (lockfile),
  `mock-infra` L1, `tests`/`code-style` L0 (правдиво — нет vitest/eslint).
  Без `primary_subpackage` поля — идентичный результат через auto-resolve.
- Оригинальный `vdx/mise.toml` (stack=meta) не трогался — 5 осей excluded,
  как после Шага J.

Остаточный кейс multi-subpackage monorepo выделен как **O32**.

### Шаг L — CI workflow для vdx (ci axis L0 → L3) ✅ (2026-05-23)

Создан `.github/workflows/ci.yml` (push на main + pull_request → setup-node@v4 +
`cd cli && npm ci && npm test`). В `cli/package.json` добавлен alias
`"test": "tsc --noEmit"` — нужен и для regex L2 рубрики, и для семантики
«npm test = quality gate».

Эффект на vdx audit (без изменений в evaluator/рубрике):

| Ось | До Шага L | После Шага L |
|-----|:--:|:--:|
| ci | L0 | **L3** |
| overall | L0 | L0 |

`ci` прошёл все три уровня в один Write — L1 (workflow exists), L2 (`npm test`
matches regex), L3 (`pull_request` trigger без `\|\| true`). Overall остался
L0, но capping переехал на 4 supporting-L0 (reproducibility, secrets-config,
shared-infra, shared-infra-drift). Это правдиво — meta-репо без
docker/.env/compose. См. N22.

Workflow push'нут на GitHub 2026-05-23 — Actions tab активен.

### Шаг M — ci L4 через matrix ✅ (2026-05-23)

В `.github/workflows/ci.yml` добавлен `strategy.matrix.node-version: [20, 22]`
+ `fail-fast: false`. Typecheck гоняется параллельно на двух LTS. Audit на
vdx: `ci` L3 → **L4** (предикат `file_contains: matrix:` совпадает). Это
первая ось vdx, достигшая max. Overall L0 без изменений. См. N23.

### Шаг N — CLI выложен на npm как @vodmal/vdx-cli@0.2.0 ✅ (2026-05-23)

`cli/` стал публикуемым npm-пакетом. Изменения:

- `tsx` переехал в `dependencies`; новые `bin/vdx.cjs` и `bin/vdx-mcp.cjs`
  обёртки регистрируют ESM loader через `tsx/esm/api.register()` **без**
  `{ namespace: ... }` (namespace изолирует loader так, что type-only
  cross-module exports ломаются — это был detour).
- Bundled рубрика в `cli/rubric/vdx-rubric.yaml` (mirror canonical v0.2.2).
  Резолвится через `cli/src/defaults.ts` от `import.meta.url`. Env override:
  `VDX_RUBRIC=/path/to/rubric.yaml`.
- `cli/package.json`: scope `@vodmal/vdx-cli`, `version: 0.2.0`, MIT
  LICENSE, `repository`, `homepage`, `bugs`, `bin: { vdx, vdx-mcp }`,
  `files: [src, rubric, bin, README.md, LICENSE]`, `publishConfig.access:
  public` (scoped → нужен явный access).
- `plugin/.mcp.json` переключён с хардкод-пути на
  `npx -y -p @vodmal/vdx-cli@latest vdx-mcp --project ${CLAUDE_PROJECT_DIR}`.
  Плагин **marketplace-ready**: один config-файл, без локального клона vdx.
- `plugin/.claude-plugin/plugin.json` bumped до v0.2.0.

Контрольные точки:
- `npx tsc --noEmit` чисто.
- Smoke на 3 референсах через `node bin/vdx.cjs` — без регрессий
  (telegram L2, t23b L1, bookmap L1).
- `npm publish` (требует 2FA / OTP — выполнял пользователь).
- `npx -y -p @vodmal/vdx-cli vdx` из чистой `/tmp/`-директории — usage
  печатается, bundled рубрика подхватывается, end-to-end ОК.

Открыто после Шага N:
- **O33** — subpackage с другим стеком должен contributить applies_to-осям
  parent'а (закрыто в Шаге O — см. ниже).
- **O34** — новая ось рубрики `release-artifact` (publish-readiness):
  name/version/license/repository/bin/publishConfig/files + registry-
  resolves. vdx-как-проект сам бы выиграл от этой оси. См. N24.

### Шаг O — O33 закрыт (subpackage stack lift), @vodmal/vdx-cli@0.2.1 ✅ (2026-05-23)

Изменения в evaluator:

- `cli/src/facts.ts`: `stackForDir` экспортирован (был private).
- `cli/src/audit.ts/resolveSubpackageCtx`:
  - для explicit `primary_subpackage` — detect actual stack через
    `stackForDir(abs_path)`;
  - для auto-resolve — fallback "если `matching` пуст и `subs.length === 1`,
    adopt single subpackage с любым стеком";
  - возвращаемый `subpackageCtx.stack` = stack subpackage'a (а не наследует
    от root).
- `cli/src/audit.ts` audit loop: `evalCtx` определяется первым, проверка
  `applies_to` сравнивается с `evalCtx.stack` (не `ctx.stack`).

CLI bump v0.2.0 → **v0.2.1**, опубликован на npm.

vdx-self-audit ДО → ПОСЛЕ:

| Ось | До O33 | После O33 |
|-----|:--:|:--:|
| tests (C) | excluded | **L0** (правдиво — нет vitest) |
| static-analysis (C) | excluded | **L2** (tsc strict в cli/) |
| code-style (S) | excluded | L0 |
| dependency-hygiene (S) | excluded | **L1** (lockfile) |
| mock-infra (S) | excluded | **L1** |
| overall | L0 (4 supporting capping) | L0 (tests=C + supporting capping) |

**Семантика**: O33 — не лифт, а **fix integrity**. Маска `excluded` снята,
появилась реальная критическая планка `tests=L0`. Путь к L1 теперь требует
real tests (vitest), не 1-2 supporting-фикса. Smoke на 3 референсах без
регрессий. См. N25.

Open после Шага O:
- **O34** — release-artifact ось (см. N24).
- **vitest** — критический для L1 (раньше excluded, теперь tests=C L0).
- **supporting лифт** — .env.example / Dockerfile / shared-infra override.
- **O25/O26/O27/O29** — ранее известные.
- **O32** — multi-subpackage (отложено).

### Шаг P — vitest на evaluator (tests L0→L3) ✅ (2026-05-24)

Добавлен vitest + 47 unit-тестов: `tests/unit/scoring.test.ts` (16 кейсов
на pure scoring: delta-style levels с break-семантикой, weighted flags по
`level_thresholds`, projectLevel weighted_two_class с excluded/suppressed)
и `tests/unit/predicates.test.ts` (31 кейс через фикстуры
`tests/fixtures/node-with-vitest`, `php-with-phpstan`, `empty`).

Изменения в `cli/`:
- `vitest.config.ts` — include `tests/**/*.test.ts`, coverage v8 на
  `src/**/*.ts` минус CLI entry-points.
- `package.json` scripts: `test` теперь `vitest run` (раньше `tsc
  --noEmit`); `typecheck` отдельно = `tsc --noEmit`; новые `test:unit`
  (`vitest run tests/unit`) и `coverage` (`vitest run --coverage`).
- `devDependencies`: `vitest`, `@vitest/coverage-v8`.
- `.github/workflows/ci.yml`: добавлен шаг "Typecheck" (`npm run
  typecheck`) перед "Unit tests" (`npm test`). Job переименован
  `typecheck cli` → `cli`.

Vitest и его deps только в `devDependencies`, в `files: [src, rubric,
bin, README.md, LICENSE]` не входят — npm-bundle не толстеет.
Опубликованный CLI остаётся v0.2.1 — package surface не менялся.

**vdx-self-audit ДО → ПОСЛЕ:**

| Ось | До P | После P |
|-----|:--:|:--:|
| tests (C) | L0 | **L3** (vitest + test:unit + coverage scripts) |
| overall | L0 | L0 |

L1: `package_present: { name: vitest, ecosystem: npm }` ✓
L2: `has_task: test:unit` ✓ (script в `package.json`)
L3: `has_task: coverage` ✓
L4: e2e/mutation/playwright — overkill для CLI, не идём.

**Семантика**: capping переехал с `tests=C L0` (Шаг O) на supporting
(5 из 10 на L0: reproducibility, code-style, secrets-config,
shared-infra, shared-infra-drift). Чтобы L1 overall теперь нужно
добить три-четыре supporting оси, не критические. Smoke на 3 референсах
без регрессий (telegram L2 / t23b L1 / bookmap L1). См. N26.

Open после Шага P:
- **supporting лифт** — `.env.example` (secrets-config L2),
  eslint+prettier (code-style L1+), Dockerfile/Makefile (reproducibility
  L1), override через `.vdx-overrides.yml` для shared-infra (meta не имеет).
- **O34** — release-artifact ось (см. N24).
- **O25/O26/O27/O29** — ранее известные.
- **O32** — multi-subpackage (отложено).

### Шаг Q — supporting лифт + overrides (overall L0 → L1) ✅ (2026-05-24)

Три минимальных артефакта + три suppress'а в `.vdx-overrides.yml`:

1. **`Makefile`** в корне vdx — `build`/`test`/`check`/`audit`/`smoke`
   таргеты, делегирующие в `cd cli && npm <…>`. Источник правды для
   задач остаётся `mise.toml`; Makefile — это конвенциональный
   entry-point для stranger'а, который хочет запустить `make test` без
   изучения mise. Эффект: `reproducibility` L0 → **L1** (предикат
   `has_file: Makefile`).
2. **`cli/.editorconfig`** — root=true, 2-space, LF, UTF-8 +
   tab-override для Makefile (root vdx Makefile использует tab).
   Subpackage-ctx из Шага K направляет ось `code-style` на cli/
   (потому что у неё `applies_to: [php, node, go, python]` и primary
   subpackage = cli). Эффект: `code-style` L0 → **L1** (предикат
   `has_file: .editorconfig` относительно subpackage-root).
3. **`.vdx-overrides.yml`** в корне vdx — три `suppress: true`:
   - `secrets-config` — vdx-CLI не имеет runtime env-config (только
     optional `VDX_RUBRIC`, документирован в cli/README.md).
   - `shared-infra` — vdx не сервис, не потребляет shared reverse
     proxy / external networks.
   - `shared-infra-drift` — sub-axis работает только если есть
     `misc/traefik-global/`; у vdx нет, значит ось не применима.

Все три suppress'а **постоянные** (без `until:`), потому что класс
проекта не изменится. Спека overrides формата — [docs/specs/overrides-format.md](docs/specs/overrides-format.md).

**vdx-self-audit ДО → ПОСЛЕ:**

| Ось | До Q | После Q |
|-----|:--:|:--:|
| reproducibility (S) | L0 | **L1** |
| code-style (S) | L0 | **L1** |
| secrets-config (S) | L0 | **suppressed** |
| shared-infra (S) | L0 | **suppressed** |
| shared-infra-drift (S) | L0 | **suppressed** |
| mock-infra (S) | L1 | **L2** (case-FS false positive, см. ниже) |
| **overall** | **L0** | **L1** |

Supporting visible после suppression: 7 (10 - 3). Все 7 на L1+ →
ratio 1.0 ≥ 0.8 threshold. Critical min L2 → выше L1. Overall **L1**.

**Гоча — case-insensitive FS на macOS**: `mock-infra` L2 предикат
`has_file: tests/Fixtures` (PSR-4 PHP-конвенция, capital F) совпал с
`cli/tests/fixtures/` (lowercase) на macOS APFS. На Linux CI этот
match не сработает — `mock-infra` вернётся к L1. Overall L1
сохранится в любом случае (6/7 на L1+ = 0.857 ≥ 0.8). Решение —
оставить как есть; это интересное наблюдение про хрупкость
file-presence предикатов на разных FS. См. N27a в decisions.md.

Smoke на 3 референсах без регрессий (telegram L2 / t23b L1 /
bookmap L1) — у них нет `.vdx-overrides.yml`, эффект изолирован.

**Семантика**: vdx достиг своей же L1 «reproducible» планки одним
коммитом из 3 файлов. Это первая overall-планка vdx после A–P. Дальше
до L2 — кратно больше работы (см. TL;DR раздел).

Open после Шага Q:
- **O34** — release-artifact ось.
- **O25/O26/O27/O29** — ранее известные.
- **O32** — multi-subpackage (отложено).
- **supporting L2** — отложено, см. TL;DR.

### Шаг R — release-artifact ось, рубрика v0.3.0 ✅ (2026-05-24)

Подробно — N28 в [docs/decisions.md](docs/decisions.md). Кратко: новая
ось `release-artifact` (supporting, `applies_to: [node, php, ruby,
python]`) с лестницей L1 (name+version+license) → L2 (description+
repository+LICENSE) → L3 (files+entry-point / autoload+type) → L4
(publishConfig+homepage+bugs / extra.publish). Рубрика → **v0.3.0**.
Эффект: vdx-cli получил `release-artifact L4` (уже publish-ready),
overall vdx L1 сохранился; telegram **L2 → L1 регрессия** —
release-artifact L1 без publish metadata. Это fair signal (telegram
это app), но noisy; design issue открыт как O35.

### Шаг S — `applies_when` predicate, рубрика v0.3.1 (O35 закрыт) ✅ (2026-05-24)

В `Axis` (`cli/src/rubric.ts`) добавлено optional поле
`applies_when?: Predicate`. В `audit.ts` audit loop после
`applies_to`-фильтра новый шаг: `if (axis.applies_when &&
!evalPredicate(axis.applies_when, evalCtx)) → drift_kind: excluded`.
Использует `evalCtx` (subpackage-aware), не root ctx.

В canonical-рубрике v0.3.1 ось `release-artifact` получила
`applies_when` с двумя ветками (Node lib intent: `!private` +
publishConfig/bin/main/exports/module; PHP lib intent: composer.json +
name + `type ≠ project`). Mirror'нуто в `cli/rubric/vdx-rubric.yaml` +
`docs/specs/vdx-rubric.example.yaml`. `DEFAULT_BASELINE` в
`cli/src/init.ts` → `@v0.3.1`. CHANGELOG.md в canonical-репо обновлён.

**Эффект на калибровочные референсы (smoke verified)**:

| project | release-artifact до S | после S | overall |
|---------|:--:|:--:|:--:|
| telegram (PHP app, `type: project`) | L1 | **excluded** | L1 → **L2** (восстановлен) |
| t23b (PHP app, `type: project`) | L1 | **excluded** | L1 (unchanged) |
| bookmap (Node app, `private: true`) | L1 | **excluded** | L1 (unchanged) |
| vdx (meta, subpkg=cli, Node lib) | L4 | **L4** | L1 (unchanged) |

Регрессия из N28 закрыта: telegram восстановлен. vdx-cli держит L4
через Node-ветку applies_when (`bin` + `publishConfig` + `!private`).

**Тестирование**: 5 новых unit-тестов в `cli/tests/unit/audit.test.ts`
(Node lib evaluated, Node app excluded, PHP lib evaluated, PHP app
excluded, applies_to gate fires before applies_when). Новые фикстуры:
`tests/fixtures/node-publishable-lib`, `tests/fixtures/php-app-project`.
Все 52 теста (47 старых + 5 новых) проходят. `npx tsc --noEmit` чистый.

**Semver**: patch (0.3.0 → 0.3.1) — bugfix design issue из N28, не
breaking. Старые ссылки `@v0.3.0` продолжают работать без
applies_when (apps получают L1 как раньше); ссылка `@v0.3.1` даёт
чистый excluded.

Open после Шага S:
- **O25** — mock-infra delta-trap (Node-проекты с docker-mock).
- **O29** — `vdx init` при unknown/meta.
- **O26/O27** — TOML round-trip, shared-infra precheck.
- **O32** — multi-subpackage (отложено).
- **supporting L2** — отложено, см. TL;DR.
- **republish CLI** — bundled rubric в опубликованном пакете всё ещё
  v0.2.2; для прямого доступа клиентов через `npx -y -p @vodmal/vdx-cli`
  без сети нужен bump cli и npm publish.

### Шаг T — `vdx init` для unknown/meta стеков (O29 закрыт) ✅ (2026-05-24)

Три улучшения в `cli/src/init.ts` + `cli/src/index.ts`:

1. **`--stack <id>` override** — `planInit` принимает opt `stack`,
   CLI парсит `--stack`. Когда задан, `stackOverridden=true`,
   detection-warnings подавляются.

2. **`stack=meta` ветка с auto-resolve `primary_subpackage`** —
   `findSubPackages(projectRoot)`: при ровно одном subpackage
   `planInit` ставит `primarySubpackage` + сканит таски/tools
   на subpackage-ctx (`scanRoot = projectRoot/subpkg`).
   `runCommand` префиксится `cd <subpkg> &&` через helper
   `renderRunCommandInSubpackage`. В `[vdx]` блок пишется
   `primary_subpackage = "..."`. 0 subpackages / >1 → warning.

3. **Warnings + TODO comment** — для detected `unknown`/`monorepo`
   без override planInit заполняет `InitPlan.warnings`,
   `renderMiseToml` вставляет `# TODO(vdx): ...` перед `[vdx]`,
   `cmdInit` печатает warnings в STDERR.

`InitPlan` расширен полями `stackOverridden`, `primarySubpackage`,
`warnings`.

**Smoke verified**:

| сценарий | результат |
|----------|-----------|
| `vdx init <empty>` | stack=unknown, warning, TODO в mise.toml |
| `vdx init <empty> --stack node` | stack=node, no warning, no TODO |
| `vdx init <repo> --stack meta` (single subpkg) | primary_subpackage=cli + `cd cli && npm run test` |

5 новых unit-тестов в `cli/tests/unit/init.test.ts` + новая
фикстура `tests/fixtures/meta-single-subpkg/api/package.json`.
Все 57 тестов (52 + 5) проходят.

Open после Шага T:
- **O25** — mock-infra delta-trap (Node-проекты с docker-mock).
- **O26/O27** — TOML round-trip, shared-infra precheck.
- **O32** — multi-subpackage (отложено).
- **supporting L2** — отложено, см. TL;DR.

### Шаг U — @vodmal/vdx-cli@0.3.0 на npm ✅ (2026-05-24)

Минорный bump CLI после накопления фич Шагов P/R/S/T:

- `cli/package.json` version `0.2.1` → **`0.3.0`**.
- `plugin/.claude-plugin/plugin.json` version `0.2.0` → **`0.3.0`**
  (выравнивание с CLI; `.mcp.json` использует
  `@vodmal/vdx-cli@latest`, поэтому новые клиенты получат свежий
  пакет без правки plugin manifest).
- Bundled rubric (`cli/rubric/vdx-rubric.yaml`) уже на v0.3.1 —
  release-artifact axis + applies_when. `DEFAULT_BASELINE` уже
  `@v0.3.1`. Эти два значения теперь синхронизированы в
  опубликованном пакете (раньше bundled был v0.2.2).

**`npm pack --dry-run` sanity**: 18 файлов, 22.7 KB, 82.1 KB
unpacked. Состав:
- src/ (12 .ts модулей), bin/ (vdx.cjs + vdx-mcp.cjs),
  rubric/vdx-rubric.yaml (v0.3.1), README.md, LICENSE, package.json.
- Исключено через `files:` whitelist: tests/, vitest.config.ts,
  smoke.sh, tsconfig.json, fixtures.

Семвер: minor (0.2.1 → 0.3.0). Не breaking: API CLI сохранён
(`vdx audit`, `vdx init`), новый `--stack` опционален, bundled
рубрика обратно-совместимая (новая ось + новое поле axis).

**Публикация**: `npm publish` запускает пользователь — нужен OTP
из email (npm 2FA не настроен на browser-token). После публикации
`npx -y -p @vodmal/vdx-cli vdx` будет резолвить новую версию
автоматически.

Open после Шага U:
- **O25** — mock-infra delta-trap (Node-проекты с docker-mock).
- **O26/O27** — TOML round-trip, shared-infra precheck.
- **O32** — multi-subpackage (отложено).
- **supporting L2** — отложено, см. TL;DR.

### Шаг V — D12 research-финализация (publish verb) ✅ (2026-05-24)

После запроса пользователя на `vdx publish:npmjs` / `vdm publish` — поднят
полный landscape research для решения D12 (расширять ли core словарь?).

**3 параллельных research-агента** (skill s2-56 — landscape по independent
axes spawned concurrently):
- node-release-research: semantic-release, release-it, changesets, np, publint
- php-python-release-research: Packagist (pull-based), poetry, hatch, flit, twine, PSR
- deploy-orchestrators-research: release-please, goreleaser, cargo-release, deploy categories

**Convergent finding** всех трёх: vdx должен **оркестрировать**, не реализовывать
(принцип "комбайн"); verb униформный, **implementation institutionalized
per-stack внутри vdx** (user не учит ecosystem-specific commands); рубрика
становится **executable gate** через pre-flight refuses_if — новый
value-prop vdx, эксклюзивный относительно existing tools (semantic-release,
release-please и т.п. не имеют рубрики).

**D12 принято**: `publish` как 7-й lifecycle verb, lib-gated через
`applies_when` (переиспользует O35 сигналы), **subverb-style** (вдохновлено
паттерном `build:db:migration`) + **arg-form** `vdx publish patch|minor|major`.
Subverbs: `publish:bump`, `publish:upload`, `publish:tag`, `publish:notes`.
Транзакционный pipeline: pre-flight → upload (irreversible first) → bump +
commit + tag + push на success.

**Pre-flight gating** через рубрику:
- `rubric.tests < L2` → error
- `rubric.release-artifact < L3` → error
- `rubric.ci < L2` → error (с `--no-ci-check` opt-out)
- `working_tree.dirty` → error
- `published_version >= local_version` → error (registry collision)
- `git.head_commit != tag(version)` → warning (default), `--strict` для error

`--force` обходит refuses_if. `[tasks.publish]` в mise.toml как D3 escape hatch.

**OQ1–OQ7 resolved** последовательно с pros/cons + verdict для каждого
(skill p1-ba45 — sequential resolution с explicit reasoning). Полные
resolutions в [docs/research/publish-deploy.md](docs/research/publish-deploy.md).

**Deferred items** открыты:
- **O36** — `release-workflow` ось (orthogonal к lifecycle-interface);
  добавим после ship + N≥3 lib calibration.
- **O37** — `vdx bump` как standalone 8-й verb (deferred — сейчас в scope
  D12 через subverb).
- **O38** — native monorepo-aware publish (D14+); MVP делает proxy в
  `.changeset/`.

**Implementation phasing** (см. Next steps):
- Phase 1 (Шаг W) — MVP для Node only (vdx-cli dogfood).
- Phase 2 (Шаг X) — PHP + Python.
- Phase 3 (Шаг Y) — Cargo/Ruby/Go/Java.

Open после Шага V: см. "Следующий шаг" в TL;DR.

### Шаг W — `vdx init` transparency + monorepo fallback (O39 закрыт) ✅ (2026-05-24)

Догфудинг init на 3 калибровочных проектах (telegram/t23b/bookmap) перед
Шагом X показал три гочи: (а) plan-таблица не объясняет почему выбран
скрипт — выглядит «coincidental»; (б) bookmap не подхватывает
`server:test` из nested `server/package.json`; (в) Node-эвристика беднее
PHP — нет `vitest`/`tsc`/`prettier:fix`/etc.

Изменения в `cli/src/init.ts`:

- `selectVerbTask(verb, tasks): { task, reason, alternatives }` — новая
  основная функция с 4-уровневой эвристикой: **exact** → **alias** →
  **prefix-group** → **suffix-group** (новый шаг). Suffix-group ловит
  `<dir>:test`, `<dir>-test`, `<dir>:lint`, `<dir>:fix` — monorepo
  fallback, когда listAllTasks префиксирует subpkg-name.
- `VerbMapping` обогащён: `reason: 'exact'|'alias'|'prefix-group'|
  'suffix-group'|'not-found'` + `alternatives: string[]` (другие
  совпавшие кандидаты, отсортированные).
- Расширены `VERB_ALIASES`:
  - up: + `dev`, `serve`
  - build: + `compile`, `dist`
  - test: + `pest`, `tests`, `unit`, `mocha`, `ava`, `spec`, `coverage`
  - check: + `check:before:push`, `typecheck`, `tsc`, `eslint`,
    `prettier:check`, `format:check`, `qa`, `phpstan`, `psalm`
  - fix: + `fix:rector`, `eslint:fix`, `prettier`, `prettier:write`,
    `prettier:fix`, `format:write`, `cs-fix`, `cs:fix`
- `renderPlanSummary`: новая колонка `Reason` + блок
  `### Alternatives considered` под таблицей.
- `renderMiseToml`: комментарий `# vdx: matched "<task>" via <reason>;
  alt: <list>` перед каждым `[tasks.X]` если `reason ≠ exact` или
  alternatives непустые.
- `mapVerb` сохранён как back-compat wrapper над `selectVerbTask`.

**Эффект на калибровочные референсы (dry-run, без записи в чужие репо):**

| Проект | До W | После W |
|--------|:--:|:--:|
| telegram (PHP, deep) | 6/6 mapped | 6/6 mapped + alt видны (e.g. `build`: build-dev, build-prod) |
| t23b (PHP, mid) | 6/6 mapped | 6/6 mapped + 13 alt у `build:*` siblings |
| bookmap (Node, mono) | **3/6** mapped | **4/6** mapped (`test` → `server:test` via suffix-group) |

bookmap-`check`/`fix` остались not-found — у проекта реально нет lint/
format скриптов. Это правдивый сигнал.

**Тестирование**: 8 новых unit-тестов в `cli/tests/unit/init.test.ts`
(exact с alt, alias fallback, prefix-group canonical hint, suffix-group
monorepo, shortest-wins, not-found, integration на новой фикстуре
`node-monorepo-with-server/{package.json, server/package.json}`). Все 65
тестов проходят (57 + 8). `npx tsc --noEmit` чисто. Smoke на 3
референсах: L2/L1/L1 — без регрессий.

**Bundled rubric не менялась** (no rubric-format changes) — semver bump
CLI не нужен до Шага X (D12 MVP).

Open после Шага W: см. "Следующий шаг" в TL;DR.

### Шаг X.1.a — `vdx publish` plan + pre-flight (без execute) ✅ (2026-05-24)

Первая часть D12 MVP. Делает `vdx publish <patch|minor|major>`
рабочим **до** уровня вывода plan + 4 pre-flight check'а. Pipeline
(npm publish + git ops) приземлится в **X.1.b**. Разделение
сознательно — позволяет руками проверить план перед irreversible-
операцией.

**Файлы**:

- `cli/src/publish.ts` (~270 строк): `bumpSemver`, `compareSemver`,
  `planPublish`, `renderPublishPlan`, helpers.
- `cli/src/index.ts`: `cmdPublish` + dispatch + usage update.
- `cli/tests/unit/publish.test.ts`: 11 кейсов (bump/compare/plan
  pre-flight/render).

**Pre-flight checks (4 шт)**:

1. **working-tree-clean** — `git status --porcelain` через
   `execFileSync` (argv-array, без shell-injection).
2. **lib-intent (applies_when)** — release-artifact ось не должна
   быть `excluded` (это значило бы `applies_when=false`,
   то есть проект — app, не lib).
3. **release-artifact ≥ L3** — нужны publishable metadata
   (files[], main/exports, license).
4. **registry-collision** — `npm view <pkg> version` → новый bump
   должен быть строго выше уже опубликованного. 404 = first publish
   (OK). Сетевые/auth ошибки → fail с сообщением.

**Mise override** (D3 escape hatch): если в `mise.toml` есть секция
`[tasks.publish]` — plan возвращает `delegatedToMise: true` без
vdx-native проверок. Реальное delegate-exec (`mise run publish`)
приземлится в X.1.b.

**Subpackage-aware**: `effectiveStack` резолвится через
`audit.primary_subpackage + stackForDir()`. vdx root (stack=meta) с
`primary_subpackage=cli` → publish работает на cli/ как Node. Если
`effectiveStack !== 'node'` → error с подсказкой про X.2 (PHP/Python).

**Семантика**: dry-run выдаёт markdown plan с таблицей checks +
pipeline (что бы сделалось). Non-dry-run пока тоже выходит на plan
(execute заглушка с TODO в X.1.b).

Smoke verified — `npx tsx cli/src/index.ts publish patch --dry-run`
из vdx root:
- Package: `@vodmal/vdx-cli`, Version: `0.3.0 → 0.3.1`
- working-tree-clean (зависит от состояния), lib-intent OK,
  release-artifact L4 OK, registry-collision OK (registry @ 0.3.0).

Тесты: 65 → 76 (11 новых). `npx tsc --noEmit` чисто.

Open после X.1.a:
- **X.1.b** — execute pipeline (см. "Следующий шаг" в TL;DR).
- Subverbs / conventional-commits / PHP+Python — X.2/X.3.

### Шаг X.1.b — `vdx publish` execute pipeline ✅ (2026-05-24)

Закрывает D12 MVP для Node. После plan + pre-flight (X.1.a) теперь
есть `executePublish()` — реальное выполнение pipeline.

**Файлы**:
- `cli/src/publish.ts`: новая функция `executePublish(plan)` (~70 строк).
- `cli/src/index.ts`: `cmdPublish` теперь вызывает `executePublish`
  после проверки `preflightPassed && !force`. Exit codes: 0 OK, 2
  pre-flight failed, 3 execute failed.

**Pipeline** (single-package, non-delegated):

1. **bump** — `package.json.version = newVersion`, перезапись через
   `fs.writeFileSync`. Оригинальный текст сохраняется в `originalText`
   для возможного revert.
2. **`npm publish`** через `execFileSync('npm', ['publish'], { cwd:
   pkgDir, stdio: 'inherit' })`. Stdio:inherit пропускает OTP-prompt
   к терминалу пользователя. Идёт **до** git commit — irreversible
   шаг первым (transactional order из research D12 OQ4).
3. **revert на failure** — `try/catch` вокруг `execFileSync('npm')`.
   На ошибке: `fs.writeFileSync(plan.packageJsonPath, originalText)`,
   stderr-сообщение, throw → exit 3 от cmdPublish.
4. **git** — `git add <pkg.json>` → `git commit -m "release: vX.Y.Z"`
   → `git tag -a vX.Y.Z -m "vX.Y.Z"`, все через `execFileSync` с
   `cwd: plan.projectRoot`. Не пушит — пользователь решает (
   `git push --follow-tags`).
5. **delegated-to-mise**: если `plan.delegatedToMise` — exec
   `mise run publish` через `execFileSync` и выход.

**Семантика на failure-paths**:

- `npm publish` fail → revert package.json + exit 3. Чистое state,
  можно retry.
- `git commit` fail после успешного `npm publish` → пакет уже
  опубликован, bumped version без commit. Пользователь чинит руками
  (`git add ... && git commit`). vdx не пытается unpublish (npm
  immutable).

**Security**: 100% argv-array через `execFileSync` — нет
shell-interpolation. Поправлено в [cs:s1-206]-стиле с первой версии
кода.

**Smoke verified** (только dry-run без реального publish):
- `npx tsc --noEmit` чисто.
- 76/76 vitest проходят (нет регрессий; executePublish без unit-теста
  — слишком интегрировано с external commands; smoke = ручной).
- Dry-run на vdx root: план корректный, pre-flight выдаёт правильные
  results, registry-collision `OK (registry @ 0.3.0, new 0.3.1)`.

D12 MVP **для Node закрыт**. Следующий шаг — dogfood: bump CLI до
0.4.0 через `vdx publish minor` на самом vdx-cli.

Open после X.1.b: см. "Следующий шаг" в TL;DR.

### Шаг X.1.c — first real dogfood: @vodmal/vdx-cli@0.4.0 опубликован ✅ (2026-05-24)

Финальная валидация D12 MVP для Node — реальный publish из vdx root на
сам vdx-cli.

**Pre-step cleanup** (commit `515cfe8`): HANDOFF числил "push rubric tags
v0.3.0/v0.3.1" как open blocker, но `git ls-remote --tags origin` для
`vdx-rubric-vodmal` показал что оба тега уже на remote (post-handoff
audit, `s1-187`). Заодно вычищены устаревшие `@v0.2.1` baseline-refs:
README.md, plugin/README.md, docs/decisions.md, **критбаг** в
`cli/src/mcp-server.ts:159` (шаблон проставлял устаревший baseline в
новые `mise.toml` через MCP `vdx_record_success_path`).

**Publish run** (из vdx root):

    npx tsx cli/src/index.ts publish minor

Effective stack резолвится через `primary_subpackage=cli` → Node.
Pre-flight: working-tree-clean ✓, lib-intent ✓ (applies_when=true:
publishConfig+bin+main, !private), release-artifact L4 ≥ L3 ✓,
registry-collision OK (npm @ 0.3.0, new 0.4.0).

Pipeline `executePublish()`:

1. ✓ bump `cli/package.json` 0.3.0 → 0.4.0
2. ✓ `npm publish` — интерактивный OTP-prompt в живом терминале
   (`execFileSync` со `stdio: 'inherit'` пропускает в терминал
   пользователя), 27.7 KB tarball, 19 файлов, integrity sha512
3. ✓ `git commit cd3eca9 release: v0.4.0`
4. ✓ `git tag -a v0.4.0`
5. (не пушено самим vdx — пользователь сделал
   `git push --follow-tags` отдельно)

**Verification**: `npm view @vodmal/vdx-cli version` → `0.4.0`.

**Семантика**: D12 MVP для Node прошёл первое реальное end-to-end
исполнение, не только dry-run. Подтверждает что transactional order
(irreversible-first: bump → publish → commit → tag) и `stdio:inherit`
для OTP работают как заложено. CLI bump v0.3.0 → v0.4.0 — minor по
семверу (новый `publish` verb = feature).

Open после X.1.c: см. "Следующий шаг" в TL;DR.

---

## Гочи, которых не видно из файлов

1. **Уровни в рубрике — delta-style.** `levels.LN.requires` описывает дельту
   к L(N−1). Уровень = max непрерывный. См. `rubric-format.md` секцию
   «Семантика уровней». Это уточнение всплыло при написании инстанса в шаге A.

2. **Telegram — НЕ эталон.** Это калибровочная точка с over-engineered
   инструментарием от экспериментов. НЕ копировать как best practice. (См.
   N4 в decisions.md.)

3. **`shared-infra` ось — про качество подхода, не файл-дрейф.** Дрейф файла —
   подось `shared-infra-drift`, и применима только пока shared-infra ≤ L3.
   L4 (отдельный версионированный репо с self-provisioning) делает drift
   бессмысленным. (См. D8.)

4. **Owner-репо опубликован.** Внешний репо доступен как
   **github.com/VoDmAl/vdx-rubric-vodmal** (public, tags `v0.2.0`…`v0.3.1`).
   `vdx init` по умолчанию проставляет `baseline:
   github.com/VoDmAl/vdx-rubric-vodmal@v0.3.1` в `[vdx]` блок сгенерированного
   `mise.toml`. Переопределить — `vdx init --baseline <ref>`. (NB: GitHub
   username — `VoDmAl`, а не `vodmal` — обнаружено при push'е, не критично
   т.к. сейчас GitHub case-insensitive.)

5. **Принцип "комбайн".** vdx собирается из готового; своё пишется только если
   нужно. Если предложение «давай напишем свой X» — это, скорее всего, ошибка.
   Сначала ищем готовое.

6. **Все правила/конвенции работы зафиксированы как claude-smart skills.**
   Полезные:
   - s1 («research journal»): держать `decisions.md` синхронизированным.
   - s55 («README downstream»): README пишется ПОСЛЕ supporting docs.
   - s61 («tooled ≠ exemplar»): не путать «много инструментария» с «эталон».
   - s62 («shared-infra про качество подхода»): не сводить к drift-файлов.
   - s72 («interleave abstract+concrete»): писать абстрактные специи рядом с
     конкретным инстансом — алгоритмические баги вылезают только на инстансе.

---

## Полезные команды

```bash
# Прогнать аудит на трёх референсах
cd "/Users/vdm/AI Projects/vdx/cli"
bash smoke.sh

# Аудит одного проекта
cd "/Users/vdm/AI Projects/vdx/cli"
npx tsx src/index.ts audit /path/to/project [--json]

# Typecheck
cd "/Users/vdm/AI Projects/vdx/cli" && npx tsc --noEmit

# Заглянуть в рубрику
less "/Users/vdm/AI Projects/vdx-rubric-vodmal/vdx-rubric.yaml"

# История изменений
less "/Users/vdm/AI Projects/vdx/PROJECT_CHANGELOG.md"
```

---

## Контекст пользователя (минимальные правила)

- Общение на русском.
- Кратко, без воды. Подтверждения короткие («Погнали», «Окей», «Огонь»).
- Делегирует автономно — без необходимости спрашивать про каждый шаг, если
  направление ясно. Но материальные развилки (build vs adopt, выбор языка,
  переименования) — выносить явно.
- Принцип research-first: сначала проверить, не делает ли это уже что-то готовое.
- Любит фиксацию в файлах: журнал решений > память сессии.
