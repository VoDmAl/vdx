---
title: "Догфудинг: vdx на высшем уровне своей рубрики"
slug: vdx-dogfooding
description: "Поднимает vdx по его же рубрике: что держит каждую ось и что берём"
status: in-progress
session-type: prd-prep
created: 2026-10-13
last-updated: 2026-10-13
relates-to:
  - "[[vdm-gates-wiring-axis/workitem|vdm-gates-wiring-axis]]"
---

# Догфудинг: vdx на высшем уровне своей рубрики

> Вырос из Sidetrack #20 кристалла
> [[vdm-gates-wiring-axis/workitem|vdm-gates-wiring-axis]]: аудит 2026-10-08
> дал vdx общий L1. Владелец отложил («давай пока отложим большое») и
> 2026-10-13 запустил («Окей погнали дальше»).

## Назначение

`CLAUDE.md`: «Догфудинг. vdx обязан соответствовать своей же рубрике на высшем
уровне». Сейчас `vdx audit .` даёт L1. Цель — поднять vdx до согласованного
уровня так, чтобы каждая оставшаяся разница была названа: override с причиной
(D9), решение по рубрике или по оценщику.

Ограничение — «комбайн» и честность: пакет или файл, поставленный ради
предиката, а не ради пользы проекту, — карго-культ. Такое не берём. Если ось
не про класс vdx, это override или правка рубрики, а не муляж.

Критерий готовности — `vdx audit .` на выпущенном CLI показывает целевой
уровень, а Next actions пусты.

## Текущая модель

**Состояние на 2026-10-13** (`vdx audit .`, vdx 0.24.0, сет v1.3.0): общий
**L1**.

**Как считается общий уровень** (`cli/src/scoring.ts`, `projectLevel`). Уровень
L засчитан, если каждая критичная ось ≥ L и ≥ 80 % видимых вспомогательных ≥ L.
Видимые — без `suppress`. У vdx пять осей подавлены (`secrets-config`,
`shared-infra`, `shared-infra-drift`; с 2026-10-13 — `observability`,
`mock-infra`), видимых вспомогательных — шесть: на любом уровне нужно 5 из 6.

**Потолок — L2, для любого проекта.** `branch-protection` L3 —
«неизвестно», пока у vdx нет расширения хостинга (DL #12 кристалла гейтов).
Неизвестное считается невыполненным, так что общий L3 и выше сегодня не
получит никто.

**Мета-репо меряется наполовину.** Ось с `applies_to` оценивается в `cli/`
(`primary_subpackage`), ось без него — в корне (`audit.ts:109`). Отсюда две
слепые зоны:
- `reproducibility` (корень) ищет `engines.node` в `package.json` корня. Его
  нет, а в `cli/package.json` — `>=20.11`. Ось стоит на L1, хотя `mise.toml` с
  `node = "20"` (L3) есть.
- `dependency-hygiene` (в `cli/`) ищет `.github/workflows/*.yml` и
  `.github/dependabot.yml` внутри `cli/`. GitHub читает их только в корне.

**Что держит каждую ось** (DL #2):

| Ось | Класс | Сейчас | Следующий шаг держит | Путь до L4 |
|---|:-:|:-:|---|---|
| `lifecycle-interface` | C | L2 | L3: нет `fix` (сет v1.4.0); на 0.24 ещё и `up`, `down` | `fix` в `mise.toml`; `up`/`down` библиотеке не нужны с v1.4.0 и vdx 0.25 (DL #6); L4 сразу — `test:smoke` подходит под `test:.*` |
| `tests` | C | L3 | L4: нет `test:e2e` / `test:mutation` | `test:e2e`: собранный CLI на фикстурах |
| `static-analysis` | C | L2 | флаги 2.3 из 4.8 (0.48): `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` | ESLint flat + `recommended-type-checked` → 4.3/4.8 = 0.90 ≥ 0.85 |
| `ci` | C | L4 | — | — |
| `branch-protection` | C | L2 (L3 «неизвестно») | расширения хостинга нет | расширение `gh` + защита `main` на GitHub |
| `reproducibility` | s | L1 | L2: мета-репо (выше) | починить оценщик; L4 — `mise run up` в `README.md` |
| `code-style` | s | L1 | L2: нет `.prettierrc` / `eslint.config.js` | Prettier + `eslint.config.js` (именно `.js`); L3 — задача `lint`/`fix` в `cli/package.json` |
| `dependency-hygiene` | s | L1 | L2: нет `npm audit` / `check:code:security` | задача аудита; L3 — dependabot (нужна правка оценщика); L4 — `knip` |
| `git-hygiene` | s | L1 | L2: репо не ставит своих хуков | `up` ставит `core.hooksPath .githooks`; `pre-push` зовёт `mise run check` и `mise run test` |
| `observability` | s | override | — | ось про сервис (L2 — логгер, L3 — Sentry, L4 — Sentry-release в CI): override с 2026-10-13 |
| `docs` | s | L3 | L4: нет `docs/adr/`, `docs/architecture.md`, `docs/onboarding.md` | `docs/architecture.md` — карта модулей CLI |
| `mock-infra` | s | override | — | ось про сервис (L3 — mock-сервер, L4 — проверка «нет моков в проде»): override с 2026-10-13. Прежний L2 — случайность, Sidetrack #4 |
| `release-artifact` | s | L4 | — | — |

**Цель (DL #3):** общий L2, каждая ось, кроме `branch-protection`, — L4.
`observability` и `mock-infra` — override, `up`/`down` библиотеке рубрика
не требует с сета v1.4.0 (DL #6). Расширение хостинга — потом,
отдельным решением.

**Прогноз.** Всё, что выше, кроме расширения хостинга, плюс
`observability` и `mock-infra` в override: критичные — L4, кроме
`branch-protection` (L2); вспомогательные — шесть из шести на L4. Общий —
**L2**, потолок. С расширением и защитой `main` — **L4**. Без override для
двух сервисных осей общий L3 не набрать и с расширением: на L3 будет 6 из 8
(0.75 < 0.8).

## Decision Log

### #1 / 2026-10-13 / Кристалл заведён, Sidetrack #20 переехал сюда

**Source:** user
**Basis:** user-stated
**Basis-detail:** «Окей погнали дальше» — ответ на моё сообщение, где
Sidetrack #20 и выпуск 0.24.1 названы делом, которое начинает владелец.
**Context:** Sidetrack #20 кристалла гейтов был deferred с 2026-10-08 с пометкой
«когда вернёмся — свой кристалл: сперва разобрать, что держит каждую ось,
потом выбрать, что берём».
**Why:** Работа на много осей, с развилками по рубрике и оценщику. Кристалл
гейтов закрыт: это был его последний хвост.
**Implication:** кристалл гейтов — `status: done` (2026-10-13), его
Sidetrack #20 — `moved` сюда.

### #2 / 2026-10-13 / Разбор осей: что держит каждую и сколько стоит L4

**Source:** assistant
**Basis:** observed
**Basis-detail:** `vdx audit .` и `--format=json` на vdx 0.24.0 (сет v1.3.0)
2026-10-13; `vdx-rubric-vodmal/vdx-rubric.yaml` на теге v1.3.0 — требования
уровней; `cli/tsconfig.json` (флаги `strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`); `cli/package.json` (`engines.node >=20.11`, нет
ESLint/Prettier); `mise.toml` (задачи `build`, `test`, `test:smoke`, `check`);
`cli/src/scoring.ts` — формула общего уровня. Слепые зоны мета-репо —
**inferred** из `cli/src/audit.ts:94–109` (ось с `applies_to` получает ctx
подпакета): пробным файлом не проверено, но `reproducibility` L1 при
`engines.node` в `cli/package.json` согласуется с этим.
**Context:** Нужна карта до выбора, что брать.
**Why:** Таблица в «Текущей модели». Три вывода, которые меняют план:
(1) потолок L2 для всех, пока нет расширения хостинга; (2) две оси
(`observability`, `mock-infra`) описывают сервис, а vdx — CLI; (3) мета-репо
меряется наполовину — это ошибка оценщика (O31 закрыт только для осей с
`applies_to`), а не пробел vdx.
**Implication:** Развилки A–C в Next actions — к владельцу. Правка оценщика
для мета-репо — по умолчанию (развилка не меняет, что пишем: это ошибка
измерения).

### #3 / 2026-10-13 / Цель L2, сервисные оси — override, `up`/`down` — по классу

**Source:** user
**Basis:** user-stated
**Basis-detail:** ответы на три вопроса 2026-10-13: A — «L2, оси до L4»;
B — «Override с причиной»; C — «Глаголы по классу» (в рубрике L3 требовать
`up`/`down` только у сервисов, minor сета).
**Context:** развилки A–C из DL #2. Для A и B я рекомендовал выбранное. Для C
рекомендовал «`down` откатывает `up`», владелец выбрал правку рубрики.
**Why:** A — потолок L2 общий для всех: расширение хостинга — отдельная работа
со своей развилкой (как `push` в `main` уживётся с защитой). B — так уже
подавлены три оси vdx, а условие в рубрике остаётся побегом (Sidetrack #2).
C — `down` у CLI-репо пришлось бы придумывать ради предиката. Честнее, чтобы
рубрика не требовала глагола там, где ему нечего делать.
**Implication:** цель — общий L2 и каждая ось, кроме `branch-protection`, на
L4. В `.vdx-overrides.yml` — `observability` и `mock-infra` с причиной.
`lifecycle-interface` L3 в сете v1.4.0 требует `up`/`down` только у сервиса
(DL #4). vdx добавляет только `fix`. Хуки репо ставит шаг установки, а не
`up` (у vdx его нет).

### #4 / 2026-10-13 / «Сервис» для глаголов = не библиотека (lib-intent)

**Source:** assistant
**Basis:** inferred
**Basis-detail:** выведено из сета v1.3.0: `release-artifact.applies_when` —
готовое определение lib-intent (`package.json` не `private` и с
`bin`/`main`/`exports`/…; `composer.json` с `name` и `type` ≠ `project`).
D12: `publish` — глагол только библиотек. Не проверено, как изменится уровень
калибровочных проектов (`telegram.vorobyev.name`, `www.t23b.org`,
`trading-tools-bookmap`) — сверить перед тегом.
**Context:** «сервис» из DL #3 надо выразить предикатом. Варианты: (i) есть
окружение для подъёма (`docker-compose.yml`, `compose.yaml`, `Dockerfile`);
(ii) проект не библиотека.
**Why:** (ii) — класс, который рубрика уже знает и которым D12 делит глаголы:
библиотека выпускается (`publish`), приложение поднимается (`up`/`down`).
(i) пропустил бы сервис без compose (Node-сервер, `npm start`) и потребовал бы
от него меньше, чем сейчас.
**Implication:** L3 `lifecycle-interface`: `build`, `test`, `check`, `fix`
всегда; `up` и `down` — если проект не lib-intent. Определение lib-intent —
одно на сет (YAML-якорь), не копия. Ось корневая: для мета-репо нужна правка
оценщика (манифест подпакета), иначе vdx останется «не библиотекой». Если
владелец против (ii) — поменять до тега v1.4.0.
**Superseded-by:** #6

### #5 / 2026-10-13 / Половины мета-репо дочитывают файлы друг у друга, задачи — нет

**Source:** assistant
**Basis:** observed
**Basis-detail:** код — `locate()` и `ownCtx()` в `cli/src/facts.ts`,
`rootAxisCtx()` в `cli/src/audit.ts`. Три теста в
`cli/tests/unit/audit.test.ts` («a meta repo reads files across its halves»).
Весь набор — 392 зелёных. Уровни до и после правки (`node --import tsx
src/index.ts audit <path> --format=json`, 2026-10-13):
`telegram.vorobyev.name` L2, `www.t23b.org` L1, `trading-tools-bookmap` L1 —
ни одна ось не сдвинулась. У vdx `reproducibility` — L1 → L4, общий L1.
**Context:** слепые зоны мета-репо из DL #2.
**Why:** Подставляется только файл, которого нет у себя: свой всегда главнее.
Корень берёт файлы подпакета, только если у него нет своего манифеста стека.
Иначе корень обычного проекта стал бы засчитывать файлы любой вложенной
папки. Подпакет берёт файлы корня всегда: `.github/` и `.gitignore` у репо
одни. Задачи словаря не подставляются: `vdx test` в корне запускает
`mise.toml` корня, а скрипт `test` из `cli/package.json` — нет.
**Implication:** `config_value` на `package.json` в корне vdx теперь видит
`cli/package.json` — на этом держится lib-intent для `lifecycle-interface`
(DL #4). `reproducibility` L4 у vdx засчитана по ошибке предиката
(Sidetrack #3). Поведение аудита меняется → minor CLI (0.25).

### #6 / 2026-10-13 / Сет v1.4.0: lib-intent проверен на калибровке и на vdx

**Source:** assistant
**Basis:** observed
**Basis-detail:** `vdx-rubric-vodmal/vdx-rubric.yaml` после правки, разобранный
js-yaml: `release-artifact.applies_when` и ветка lib-intent в L3 равны
`applies_when` тега v1.3.0 (`deepStrictEqual`), прочее в сете не изменилось.
Аудит `--rubric` на новом сете (2026-10-13): `telegram.vorobyev.name`,
`www.t23b.org`, `trading-tools-bookmap` и vdx — все оси как на v1.3.0. Копия
`mise.toml` и `cli/package.json` vdx с задачей `fix`: `lifecycle-interface` L2
на v1.3.0, L4 на v1.4.0. Четыре теста в `cli/tests/unit/audit.test.ts`
(«bundled set: lifecycle-interface L3…») на сете v1.3.0 два падают, на v1.4.0
все зелёные.
**Context:** DL #4 вывел lib-intent из сета и не проверил калибровку.
**Why:** Правка только ослабляет L3 для библиотек, поэтому приложения сдвинуться
не могли. Все три калибровочных проекта — приложения (`release-artifact`
excluded), так и вышло. vdx берёт lib-intent из `cli/package.json` (`bin`)
через правку мета-репо (DL #5).
**Implication:** решение DL #4 в силе, теперь на наблюдении. Тег v1.4.0 —
`8df57f7` в `vdx-rubric-vodmal`, на GitHub с 2026-10-13. Якорь `&lib_intent`
стоит в `lifecycle-interface` L3: YAML требует якорь до ссылки, а ось — первая
в сете. Мета-репо получит это с vdx 0.25. vdx 0.24 читает только корень, и у
vdx `up`/`down` до выпуска по-прежнему требуются.
**Supersedes:** #4

## Sidetracks

### #1. `code-style` L2/L4 признаёт только `eslint.config.js`

**Возникло в:** DL #2
**Описание:** `static-analysis` (`eslint_flat`) принимает `.js`, `.mjs` и
`.ts`, а `code-style` L2 и L4 — только `eslint.config.js`. Проект с
`eslint.config.mjs` получит строгий статанализ и L1 по стилю. Для vdx это
неважно (`"type": "module"`, `.js` подходит), но для набора правил это
расхождение — patch сета.

**Status:** open

### #2. «Сервисные» оси без условия применимости

**Возникло в:** DL #2
**Описание:** `observability` L2–L4 (логгер, Sentry, Sentry-release) и
`mock-infra` L3–L4 (mock-сервер, проверка в CI) предполагают работающий
сервис. У `release-artifact` есть `applies_when` (lib-intent), у этих осей
условия нет. CLI и библиотека упираются в них так же, как vdx. Решение для vdx —
развилка B; общее решение для рубрики — minor сета, отдельно.

**Status:** open

### #3. `reproducibility` L4 засчитывает `vdx up` в README продукта

**Возникло в:** DL #5, после правки мета-репо
**Описание:** L4 — `README.md` содержит `one-command|vdx up|mise run up|docker
compose up`. README vdx описывает команду `vdx up` как часть продукта, а не
как способ поднять сам vdx. Предикат засчитал L4. Своего `up` у vdx не будет
(DL #4); подъём клона — `mise run build`. Ложное «да» бьёт только по проекту,
чей README говорит о vdx. Варианты: принять как есть, написать в README vdx
настоящую строку подъёма или уточнить предикат (patch сета).

**Status:** open

### #4. `has_file` на macOS не различает регистр

**Возникло в:** override `mock-infra`, 2026-10-13
**Описание:** `mock-infra` L2 у vdx засчитан по `has_file: tests/Fixtures`, а
в `cli/` лежит `tests/fixtures`. APFS по умолчанию не различает регистр,
`fs.existsSync('tests/Fixtures')` — `true`. На Linux (CI vdx — Ubuntu) тот же
проект получит L1: уровень оси зависит от машины, где идёт аудит. Для vdx
теперь неважно (ось подавлена). Правка — сравнивать имя с записью
`readdir` по каждому сегменту пути; patch CLI.

**Status:** open

## Next actions

**Развилки — к владельцу:**

- [x] A. Цель — общий L2, все оси, кроме `branch-protection`, до L4 (DL #3)
- [x] B. `observability` и `mock-infra` — override с причиной (DL #3)
- [x] C. `up`/`down` — по классу, правкой рубрики (DL #3, DL #4)

**Работа:**

- [x] Оценщик: ось подпакета дочитывает репо-файлы из корня (`.github/`), ось
      корня — манифест стека из `primary_subpackage`. Только файловые
      предикаты: задачи словаря остаются своими (`vdx fix` в корне — это
      `mise.toml` корня). Тесты; запись в O31 — 2026-10-13, DL #5; выйдет
      с выпуском (последний пункт)
- [x] Сет v1.4.0: `lifecycle-interface` L3 — `up`/`down` только не у
      lib-intent; якорь lib-intent; калибровочные проекты не сдвинулись;
      зеркало, сет CLI, `DEFAULT_BASELINE` (DL #6)
- [x] `.vdx-overrides.yml`: `observability`, `mock-infra` — с причиной
- [ ] `mise.toml`: `fix`; `[vdx].verbs`
- [ ] Хуки репо: `.githooks/pre-push` — `mise run check` и `mise run test`;
      `core.hooksPath` ставит шаг установки — проверить, что распознаватель
      `git_hooks_arranged` это видит
- [ ] ESLint flat (`recommended-type-checked`) + Prettier; `lint` и `fix` в
      `cli/package.json`; `check` зовёт lint
- [ ] `test:e2e` — собранный CLI на фикстурах во временных папках
- [ ] Аудит зависимостей (`check:code:security`), dependabot, `knip`
- [ ] `docs/architecture.md`; `README.md` — `mise run up`
- [ ] Выпуск CLI с правкой оценщика; `vdx audit .` — целевой уровень

**Побеги:**

- [ ] см. Sidetrack #1 — `code-style` и `eslint.config.mjs`, patch сета
- [ ] см. Sidetrack #2 — условие применимости для сервисных осей, minor сета
- [ ] см. Sidetrack #3 — `reproducibility` L4 по README продукта
- [ ] см. Sidetrack #4 — `has_file` на macOS не различает регистр, patch CLI

## References

- Аудит 2026-10-13 — в «Текущей модели» и DL #2. Вывод `vdx audit .`
  воспроизводится командой и тегом сета v1.3.0, поэтому не сохранён.
- Рубрика — `github.com/VoDmAl/vdx-rubric-vodmal`, `vdx-rubric.yaml`: разбор
  осей — на теге v1.3.0, глаголы по классу — с v1.4.0.
- DL #12 кристалла `vdm-gates-wiring-axis` — почему `branch-protection` L3
  «неизвестно» у всех.
