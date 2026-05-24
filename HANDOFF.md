# vdx — Handoff (2026-05-23, после A–N: CLI выложен на npm)

Документ-onboarding для продолжения работы в новой чистой сессии. Читать
**первым** перед всем остальным.

---

## TL;DR за 30 секунд

**vdx** — тонкая надстройка над mise: единый словарь команд
(`up/down/build/test/check/fix`) + версионируемая рубрика зрелости с drift-детектом
+ исполняемый манифест для AI-агента. Свой код только в 4 пунктах ядра
(см. [README.md](README.md)).

**Где мы сейчас**: 14 шагов (A–N) пройдены. Owner-рубрика на
**github.com/VoDmAl/vdx-rubric-vodmal@v0.2.2** (push'нут 2026-05-23).
Evaluator дотюнен (D), `vdx init` (E), MCP-сервер (F), Claude Code плагин
(G), догфудинг (H), monorepo detector (I), `applies_to` filter (J),
`primary_subpackage` (K), CI workflow (L), node matrix L4 (M).
**Шаг N**: CLI выложен на npm как
**[@vodmal/vdx-cli@0.2.0](https://www.npmjs.com/package/@vodmal/vdx-cli)**.
`tsx` переехал в `dependencies` + bin-wrappers (`bin/*.cjs` с
`tsx/esm/api.register()` БЕЗ namespace), bundled рубрика в `cli/rubric/`
снимает зависимость от локального canonical-репо.
`plugin/.mcp.json` переключён с хардкод-пути на
`npx -y -p @vodmal/vdx-cli@latest vdx-mcp` — **плагин marketplace-ready**.

vdx сейчас: stack=meta, 5 stack-осей excluded, lifecycle L2, **ci L4**,
overall **L0** (capping на 4 supporting-L0: reproducibility/secrets-config/
shared-infra/shared-infra-drift — meta-репо буквально не имеет docker/.env/
compose, это правдивая оценка).

**Следующий шаг** (приоритеты после N):
- **O33** (новое из Шага N) — subpackage с другим стеком должен contribut'ить
  applies_to-осям parent'а. Сейчас `cli/`-тесты не подтянут vdx-tests
  потому что excluded по meta до подмены ctx. Откладывается — без этого
  excluded — правдивое состояние.
- **O34** (новое из Шага N) — новая ось рубрики `release-artifact`
  (publish-readiness: name/version/license/repository/bin/publishConfig/
  registry-resolves). vdx сам бы выиграл от этой оси.
- **L1 overall для vdx** — самая близкая планка. Опции: Dockerfile/Makefile
  (reproducibility L1), `.env.example` (secrets-config L2), override
  через `.vdx-overrides.yml` для shared-infra. Альтернатива: принять L0
  как честную meta-оценку.
- **O29** — поведение `vdx init` при unknown/meta (редкий случай).
- **O25/O26/O27** — известны ранее (mock-infra delta-trap, TOML round-trip,
  shared-infra precheck).
- **O32** — multi-subpackage monorepo (отложено до реальных пользователей).
- Альтернатива: vitest на evaluator (без эффекта на overall пока O33 не
  решён — но самоценно как надёжность).

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
  parent'а. Текущая `audit.ts:99` проверка `excluded` стоит до подмены
  `subpackageCtx`, и `subpackageCtx.stack` наследует `ctx.stack`. Симптом:
  vdx (stack=meta) + `primary_subpackage=cli` НЕ получит лифт по
  cli-tests/static-analysis. См. N24.
- **O34** — новая ось рубрики `release-artifact` (publish-readiness):
  name/version/license/repository/bin/publishConfig/files + registry-
  resolves. vdx-как-проект сам бы выиграл от этой оси. См. N24.

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
   **github.com/VoDmAl/vdx-rubric-vodmal** (public, tags `v0.2.0`+`v0.2.1`).
   `vdx init` по умолчанию проставляет `baseline:
   github.com/VoDmAl/vdx-rubric-vodmal@v0.2.1` в `[vdx]` блок сгенерированного
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
