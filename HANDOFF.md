# vdx — Handoff (2026-05-23, после A–G + git init + H догфудинг + I detector monorepo)

Документ-onboarding для продолжения работы в новой чистой сессии. Читать
**первым** перед всем остальным.

---

## TL;DR за 30 секунд

**vdx** — тонкая надстройка над mise: единый словарь команд
(`up/down/build/test/check/fix`) + версионируемая рубрика зрелости с drift-детектом
+ исполняемый манифест для AI-агента. Свой код только в 4 пунктах ядра
(см. [README.md](README.md)).

**Где мы сейчас**: 9 шагов (A–I) пройдены. Owner-рубрика опубликована на
**github.com/VoDmAl/vdx-rubric-vodmal@v0.2.1**, evaluator дотюнен (D),
`vdx init` атакует N13 (E), MCP-сервер на stdio с 9 tools (F), Claude Code
плагин с MCP+skill+hook (G), догфудинг на самом vdx (H): vdx имеет корневой
`mise.toml` (stack=meta), achieved L0 (lifecycle L2). **Шаг I**: monorepo/
subpackage stack detection — `autoDetectStack` теперь root-first + depth-1
fallback, новый `findSubPackages()`; auto-detect на vdx без декларации:
`unknown` → **`node`** через `cli/`; smoke на 3 референсах без регрессий.
**O28 закрыт частично** (detection-сторона); sub-package-aware predicate
evaluation остаётся под O30.

**Следующий шаг** (приоритеты после I):
- **O30** — sub-package-aware предикаты ИЛИ `applies_to` filter для
  meta-стека. Сейчас даже зная `stack=node`, рубрика всё ещё ищет
  `eslint.config.*`/`vitest.config.*`/`tsconfig.json` в корне и vdx
  остаётся L0 на тех осях. Главное узкое место портфеля dev-hub'ов.
- **O29** — поведение `vdx init` при unknown/meta (теперь редкий случай
  благодаря I — actually unknown стало почти невозможно).
- **O25** (mock-infra delta-trap), **O26** (TOML round-trip), **O27**
  (реальный shared-infra precheck) — известны ранее.
- **README rewrite** — поддерживающие docs готовы (decisions/changelog/
  handoff). См. гочу 6 ниже.
- Альтернативы: настоящие тесты для vdx (vitest), CI workflow, вынос CLI
  в npm package для marketplace-релиза плагина.

---

## Карта артефактов

### Основной проект (этот репо)
```
vdx/
├── README.md                   ← публичное описание проекта (vision + статус) ⚠️ устарел
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

6. **README отстаёт от реального состояния.** В нём (а) утверждается, что
   главное узкое место — ось `ci` (это пересмотрено в N13: главный leverage —
   `lifecycle-interface`); (б) статус «спека ядра в процессе / следующая
   фаза — реализация» — реализация по сути проделана за шаги B–G; (в)
   декларация принципа догфудинга обещает «vdx соответствует своей рубрике
   на L4» — догфудинг (Шаг H) показал реальный L0. README надо переписать
   отдельным заходом, **после** того как O28/O30 решатся (s55: README пишется
   после supporting docs).

7. **Все правила/конвенции работы зафиксированы как claude-smart skills.**
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
