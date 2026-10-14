---
title: "Догфудинг: vdx на высшем уровне своей рубрики"
slug: vdx-dogfooding
description: "Поднимает vdx по его же рубрике: что держит каждую ось и что берём"
status: in-progress
session-type: prd-prep
created: 2026-10-13
last-updated: 2026-10-14
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

**Состояние.** На старте (2026-10-13, vdx 0.24.0, сет v1.3.0) общий **L1**.
Сейчас (2026-10-14, выпущенный CLI 0.26.0, сет v1.4.2) — **L2**, и все оси,
кроме `branch-protection`, — L4: **цель DL #3 достигнута**. Держится на
сете v1.5.0 (сервисные оси у библиотеки `excluded`, DL #15), хуке `pre-push` (DL #11), аудите зависимостей
(DL #12), `test:e2e` и `docs/architecture.md` (DL #13). Колонка «Сейчас» в
таблице — это состояние. С 2026-10-14 на обеих станциях vdx 0.28.0, override
`observability` и `mock-infra` у vdx сняты.

**Как считается общий уровень** (`cli/src/scoring.ts`, `projectLevel`). Уровень
L засчитан, если каждая критичная ось ≥ L и ≥ 80 % видимых вспомогательных ≥ L.
Видимые — без `suppress`. У vdx пять осей подавлены (`secrets-config`,
`shared-infra`, `shared-infra-drift`; с 2026-10-13 — `observability`,
`mock-infra`), видимых вспомогательных — шесть: на любом уровне нужно 5 из 6.

**Потолок — L2, для любого проекта.** `branch-protection` L3 —
«неизвестно», пока у vdx нет расширения хостинга (DL #12 кристалла гейтов).
Неизвестное считается невыполненным, так что общий L3 и выше сегодня не
получит никто.

**Где манифест** (DL #10). С vdx 0.26 — `[_.vdx]` в `mise.toml`: таблицу `[_]`
mise не читает, а на `[vdx]` mise 2026.10 предупреждает при каждом запуске.
Старый `[vdx]` vdx читает по-прежнему. vdx перенёс свой 2026-10-14, echelon и
mediko — письмо `vdx-manifest-to-underscore` в тот же день.

**Мета-репо.** Ось с `applies_to` оценивается в `cli/` (`primary_subpackage`),
ось без него — в корне. До DL #5 половины не видели файлов друг друга
(`engines.node` из `cli/package.json`, `.github/` из корня). С правкой — видят,
задачи словаря остаются своими. В npm — с vdx 0.25.0 (2026-10-13).

**Что держит каждую ось** (DL #2):

| Ось | Класс | Сейчас | Следующий шаг держит | Путь до L4 |
|---|:-:|:-:|---|---|
| `lifecycle-interface` | C | L4 | — | `fix` — Prettier (DL #7); `up`/`down` библиотеке не нужны с v1.4.0 и vdx 0.25 (DL #6); L4 — `test:smoke` подходит под `test:.*` |
| `tests` | C | L4 | — | `test:e2e`: пакет из `npm pack` во временном префиксе, в CI и в `pre-push` (DL #13) |
| `static-analysis` | C | L4 | — | ESLint с `recommendedTypeChecked` (DL #8), сет v1.4.1 (DL #9): 4.3/4.8 = 0.90 ≥ 0.85 |
| `ci` | C | L4 | — | — |
| `branch-protection` | C | L2 (L3 «неизвестно») | расширения хостинга нет | расширение `gh` + защита `main` на GitHub |
| `reproducibility` | s | L4 | — | правка мета-репо (DL #5); L4 — по README продукта, принято как есть (Sidetrack #3, DL #15) |
| `code-style` | s | L4 | — | `.prettierrc`, `check`/`fix` в `cli/package.json` (DL #7), `eslint.config.js` (DL #8) |
| `dependency-hygiene` | s | L4 | — | `check:code:security` (`npm audit`) в CI по понедельникам; `.github/dependabot.yml`, корень читается с DL #5; `knip` в `check` (DL #12) |
| `git-hygiene` | s | L4 | — | `.githooks/pre-push` — `mise run check` и `mise run test`; `core.hooksPath` ставит `prepare` в `cli/package.json` (DL #11) |
| `observability` | s | excluded | — | ось про сервис (L2 — логгер, L3 — Sentry, L4 — Sentry-release в CI); с сетом v1.5.0 у библиотеки — excluded (DL #15), override с 2026-10-13 по 2026-10-14 |
| `docs` | s | L4 | — | `docs/architecture.md` — карта модулей CLI и путь вызова |
| `mock-infra` | s | excluded | — | ось про сервис (L3 — mock-сервер, L4 — проверка «нет моков в проде»); с сетом v1.5.0 у библиотеки — excluded (DL #15), override с 2026-10-13 по 2026-10-14. Прежний L2 — случайность, Sidetrack #4 |
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

### #7 / 2026-10-13 / `fix` — с Prettier; ESLint — отдельным шагом, без выключенных правил

**Source:** assistant
**Basis:** observed
**Basis-detail:** в `cli/` 2026-10-13: Prettier 3.9 (`singleQuote`, ширина 120)
меняет 35 из 41 файла `src/` и `tests/unit/`, около 600 строк. ESLint 10 +
typescript-eslint 8 (`recommendedTypeChecked`, `projectService`) на `src/` —
332 ошибки: `no-unsafe-member-access` 168, `no-unsafe-assignment` 80,
`no-explicit-any` 40, прочие 44. Тесты линтером не мерил (вне `tsconfig`).
**Context:** в Next actions `fix` шёл отдельным пунктом до ESLint и Prettier.
Без них `fix` нечего делать, задача была бы пустышкой.
**Why:** Prettier — механика: правит форматирование и не меняет код. Он дал
`fix` настоящую работу, а `check` — проверку формата. Находки ESLint почти все
от 40 мест, где разобранный JSON, YAML или TOML — `any` (`readJson`,
`readToml`, `readYaml` в `facts.ts`, `gha.ts`, `mcp-server.ts`, `catch (e:
any)`). Чинить — `unknown` и сужение. Выключить семейство `no-unsafe-*` —
муляж «type-checked», против «Назначения». Ширина 120 — меньше всего правок,
код и писался около неё.
**Implication:** Prettier, `check` и `fix` — один коммит: конфиг и
переформатирование вместе. ESLint — следующий шаг, с `.git-blame-ignore-revs`
на коммит переформатирования. `lifecycle-interface` — L4, `code-style` — L3.
Флаг `eslint_type_checked` не увидит flat-конфиг (Sidetrack #5).

### #8 / 2026-10-13 / ESLint: `any` разборщиков → `unknown` с сужением; тесты — под `tsc`

**Source:** assistant
**Basis:** observed
**Basis-detail:** `cli/` 2026-10-13: `npx eslint .` — ноль находок (было 332 в
`src/`, 34 в тестах и `bin/`); `tsc --noEmit` с тестами в `tsconfig` — ноль
(было 13 в тестах). 398 тестов зелёные. MCP-сервер вне тестов проверен живьём
по stdio: `list_capabilities`, `vdx_audit` (уровни как у CLI) и
`vdx_record_success_path` на временной папке (`mise.toml` дописан верно).
Аудит vdx (CLI из `cli/`): `static-analysis` L3, `code-style` L4, общий L1.
**Context:** DL #7 отложил ESLint до честной починки, без выключенных правил.
**Why:** `cli/src/narrow.ts` — проверка на входе: `isDict`, `dict`, `at`
(уровень за уровнем, и по индексу массива — `names.0` в `project_names`
профиля), `str`, `list`, `isStringList`, `errorMessage`, `stderrOf`. Дальше
по коду типы настоящие. Пойманное по дороге: `catch (e: any)` → `unknown`
плюс `{ cause }` у новой ошибки. Отключено одно правило и только для
`bin/*.cjs`: `no-require-imports`. Это CommonJS-лаунчеры, `require` — их
способ. Тесты вошли в `tsconfig`: 13 мест отстали от типов (`LiveSession.cwd`,
`PublishPlan.projectRoot`, `baseline_target` → `target`). Тест, который
расходится с типами, проверяет не то, что работает.
**Implication:** `check` = `typecheck` + `format:check` + `lint`; `fix` =
`eslint --fix` и Prettier. `.git-blame-ignore-revs` — коммит
переформатирования `8f024f3`. `static-analysis` встанет на L4 с patch сета
(Sidetrack #5).

### #9 / 2026-10-13 / Сет v1.4.1: имена конфигов — из кода самих инструментов

**Source:** assistant
**Basis:** observed
**Basis-detail:** имена — из `cli/node_modules`: ESLint 10
(`lib/config/config-loader.js`) — `eslint.config.{js,mjs,cjs,ts,mts,cts}`;
Prettier 3.9 (`index.mjs`) — 18 файлов и ключ `prettier` в `package.json`
(ключ в `package.yaml` в сет не вошёл: проекта с ним я не видел). `biome.jsonc` — по
документации Biome, локально не проверено. Аудит `--rubric` 2026-10-13:
калибровочные проекты — как на v1.4.0; у vdx `static-analysis` L3 → L4.
Временный проект (`.prettierrc.json`, `eslint.config.mjs` с
`strictTypeChecked`, задача `lint`): `code-style` L1 на v1.4.0, L4 на v1.4.1;
с ключом `prettier` в `package.json` вместо файла — тоже L4. Разобранный YAML
вне трёх правок совпадает с v1.4.0.
**Context:** Sidetracks #1 и #5 — patch сета.
**Why:** Список имён, который ведёт сам инструмент, честнее моего: предикат
засчитывает то, что инструмент прочтёт. Prettier — та же ошибка в той же оси
(`code-style` видел только `.prettierrc`), поэтому вошёл в тот же patch.
Паттерн `(recommended|strict)-?[Tt]ype-?[Cc]hecked` берёт и `.eslintrc`-имя, и
flat-имена, и `strict` — он строже `recommended`.
**Implication:** тег v1.4.1 (`1921196`) на GitHub; сет CLI, зеркала,
`DEFAULT_BASELINE` и baseline vdx — на v1.4.1. В npm придёт со следующим
выпуском CLI (patch). `static-analysis` vdx — L4.

### #10 / 2026-10-14 / Манифест — в `[_.vdx]`; старый `[vdx]` читается

**Source:** both
**Basis:** user-stated
**Basis-detail:** развилку владельцу задал 2026-10-13, ответ: «Перенести в
[_.vdx] (Recommended)», затем «Окей вперед». Проверено (observed): mise
2026.10.3 на `[_.vdx]` молчит, на `[vdx]` печатает `unknown field`; dev CLI
читает оба места, `vdx_record_success_path` по stdio пишет новый манифест в
`[_.vdx]`, а старый дописывает в `[vdx]`; калибровочные проекты на v1.4.2 — как
на v1.4.1. Не проверено: с какой версии mise предупреждает.
**Context:** Sidetrack #6. Варианты: перенести в `[_.vdx]`; оставить `[vdx]` и
терпеть предупреждение; вынести манифест в отдельный файл.
**Why:** `[_]` — единственное место для чужих данных, которое mise
документирует. Манифест остаётся в `mise.toml` (D4 не меняется по сути), а
предупреждение уходит. Чтение обоих мест делает переход постепенным: проект
переезжает, когда новый CLI есть на всех его машинах, и старый CLI не теряет
манифест раньше времени.
**Implication:** `cli/src/manifest.ts` — `manifestTable` и `loadManifestAt`
(место манифеста); `vdx init` пишет `[_.vdx]`; `vdx audit` на `[vdx]` пишет
строку `note`; имя проекта для `vdx ai` — из обоих мест. Сет v1.4.2 (`0e28906`):
`shared-infra` ищет `precheck` и `provider` в обоих местах. Выпуск — minor
0.26. Перенос echelon, mediko и самого vdx — после того как 0.26 будет на обеих
станциях. D4 в `docs/decisions.md` — приписка 2026-10-13.
**Cross:** см. Sidetrack #6

### #11 / 2026-10-14 / Хуки репо — `.githooks/` и `prepare`, без фреймворка

**Source:** assistant
**Basis:** observed
**Basis-detail:** `.githooks/pre-push`, запущенный как его запускает git (с
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` в окружении): код 0 за 92 с, 404
теста; `.git/config`, ссылки, stash и статус vdx до и после совпали. Без mise в
`PATH` — код 1 и строка о mise. `npx -p @vodmal/vdx-cli@0.26.0 vdx audit .`:
`git-hygiene` L4, общий L2. Не проверено: настоящий `git push` через хук —
`core.hooksPath` в этом клоне ещё не выставлен (пометка ⚑ в аудите). Что тесты
без сброса переменных пишут в `.git` vdx — по githooks(5), не проверял.
**Context:** `git-hygiene` L1: репо не ставило своих хуков. Варианты: husky,
lefthook или simple-git-hooks — зависимость ради одного хука; `core.hooksPath`
в задаче `up` — у библиотеки vdx её нет (DL #6); `prepare` в `cli/package.json`
— его зовёт обычная установка (`mise run build` = `npm --prefix cli install`,
`npm ci` в CI).
**Why:** «Комбайн»: у git свой механизм, и распознаватель рубрики его знает
(`git config core.hooksPath .githooks` в шаге установки). `prepare` не
выполняется при установке пакета из npm, только в клоне. `|| true` — чтобы
установка без `.git` (архив исходников) не падала. Хук сбрасывает переменные
git (`unset $(git rev-parse --local-env-vars)`): тесты создают свои репо во
временных папках, а с `GIT_DIR` из окружения git работал бы с `.git` vdx.
**Implication:** каждый push — около 1,5 мин (`check` и `test`), push
выпуска в `vdx publish` тоже; упавший хук после `npm publish` оставляет
пакет в npm и тег, push — руками (`publish.ts` так и пишет). Личные хуки
станции (`hook.<имя>` в `~/.gitconfig`, Git 2.54) идут рядом: `core.hooksPath`
их не выключает. CLAUDE.md «Выпуск CLI», HANDOFF — гоча #5.

### #12 / 2026-10-14 / Зависимости: аудит по расписанию, dependabot раз в месяц, knip в `check`

**Source:** assistant
**Basis:** observed
**Basis-detail:** `npm audit` в `cli/` 2026-10-14: 18 уязвимостей (1 critical,
10 high), из них 11 в зависимостях пакета — в основном HTTP-стек MCP SDK
(`hono`, `proxy-addr`, `fast-uri`), который vdx не запускает (MCP по stdio), и
DoS разбора в `js-yaml` и `smol-toml`, которые читают чужие файлы. Все — в
пределах диапазонов: `npm audit fix` и vitest 4.1.11 → 0. knip 6.41: 36
экспортов и 15 типов не нужны вне модуля, лишних зависимостей и файлов нет;
`--fix` снял только слово `export`, две функции оказались мёртвыми (`mapVerb`,
`userGitConfigPath`). `npm audit` по одному lock-файлу, без `node_modules`, —
работает. Аудит dev CLI: `dependency-hygiene` L4, общий L2. Тесты 404 зелёные.
Не проверено: workflow `audit.yml` и dependabot на GitHub — до push.
**Context:** L2 — задача аудита, L3 — dependabot или renovate, L4 — knip или
depcheck. Где гонять аудит: в `check` (на каждый push и в CI), отдельным шагом
CI на push или по расписанию.
**Why:** Уязвимость появляется без изменения в репо. В `check` или в CI на push
она отказывала бы в push по чужой новости, а `check` ещё и требовал бы сети.
Поэтому `check:code:security` — отдельная задача: в CI по понедельникам
(`audit.yml`, упавший прогон — письмо от GitHub) и по требованию у агента.
`--omit=dev`: в пакет едут только зависимости пакета. Dependabot — раз в месяц
и одним PR на экосистему, чтобы не завалить владельца PR. knip — в `check`: он
быстрый (~1,3 с) и без сети.
**Implication:** раз в месяц — до двух PR от dependabot (npm в `cli/` и
actions); CI проверяет их. Security updates Dependabot — настройка репо на
GitHub, не файл; не включал. `git-hygiene` L4 не задет: аудит не на push.
**Cross:** см. Sidetrack #7

### #13 / 2026-10-14 / `test:e2e` — упакованный пакет; пол Node 22

**Source:** both
**Basis:** observed
**Basis-detail:** тест ставит `npm pack` во временный префикс (pack — 1 с,
установка из кеша — 5 с) и запускает `vdx --version`, `audit` (сет — из
установленного пакета), `init --dry-run`, `vdx-mcp` по stdio. Без `rubric` в
`files` тест падает (проверено подменой). Под mise (Node 20) упали все четыре:
`ERR_MODULE_NOT_FOUND` в `tsx/dist/esm/api/index.cjs`. Пакет vdx 0.26.0 с каждой
tsx от 4.22.3 до 4.23.14 на Node 20 запускается, с 4.23.15 (2026-09-20) —
нет; на Node 22 — со всеми. В lock-файле клона была 4.22.3, поэтому CI и
unit-тесты молчали. Станции: m3 — Node 26, lft — Node 25, обе на vdx 0.24.0 и
tsx 4.23.15 — не задеты. Владелец 2026-10-14: «Поднять пол до Node 22
(Recommended)». Что Node 20 вне поддержки с 2026-04-30 — по графику выпусков
Node.js, как я его знаю; сейчас не сверял. После правки: check, 404 теста,
e2e на Node 22 и 24 — зелёные; аудит: `tests` L4, `git-hygiene` L4 (без
`test:e2e` в хуке — L3: CI его зовёт). `docs/architecture.md` — `docs` L4.
**Context:** `tests` L4 — `test:e2e`, `test:mutation` или Playwright. Варианты
для Node 20: зажать tsx до 4.23.14 или поднять пол.
**Why:** Unit-тесты гоняют клон, а пользователь получает пакет: e2e ловит
`files`, зависимость не в той секции и свежие версии зависимостей — ровно
то, что и случилось. Пол Node 22 вместо зажатого tsx: Node 20 вне поддержки,
а зажатая версия устаревает без сигнала.
**Implication:** `engines` `>=22`, `mise.toml` — node 22, матрица CI — 22 и 24,
`vdx doctor` предупреждает ниже 22; tsx в lock-файле — 4.23.15. `test:e2e` — в
CI и в `pre-push` (push — около 1 мин 40 с). Пользователю на Node 20 до выпуска
0.27 установка даёт падающий vdx без предупреждения. `prepare` при
`npm update` включил хук в этом клоне (`core.hooksPath .githooks`). Гоча
HANDOFF о push — #11, не #5, как сказано в DL #11: номер 5 был занят.

### #14 / 2026-10-14 / Хук сверяет `cli/node_modules` с lock-файлом

**Source:** assistant
**Basis:** observed
**Basis-detail:** выпуск 0.27.0 на m3: `npm publish` прошёл (npm 12.2.0
ответил 202 «being processed», в реестре версия с 20:30:14Z — около 2 мин
после принятия), коммит и тег встали, push упал в хуке: `[check]` → `sh:
prettier: command not found`. `cli/node_modules/.package-lock.json` на m3 —
от 2026-09-30, `npm ls` там: 6 пакетов нет (`@eslint/js`, `eslint`,
`eslint-config-prettier`, `knip`, `prettier`, `typescript-eslint`), 2 старые
(`vitest`, `@vitest/coverage-v8` 4.1.7). Syncthing не возит `node_modules`
(`(?d)node_modules` в `.stprojectsignore`). Проверка `npm ls --depth=0` — 0,8 с
на lft, выход 0; на m3 до `npm ci` — выход 1 и тот же список, после — 0. Push
выпуска после `npm --prefix cli ci` прошёл (владелец, m3).
**Context:** хук мог бы ставить зависимости сам (`npm ci` в хуке), отказывать
с причиной или промолчать — и `vdx publish` сверял бы это до `npm publish`.
**Why:** Отказ с причиной: push не должен переписывать `node_modules` за
спиной и ходить в сеть; сверка дешёвая и превращает невнятное «command not
found» в список пакетов и команду. Сравнивает npm (`npm ls`), своего
сравнения lock-файлов нет.
**Implication:** push на станции с отставшими зависимостями останавливается
за секунду со списком и `npm --prefix cli ci`. Push выпуска всё равно идёт
после `npm publish` — Sidetrack #8. CLAUDE.md («Выпуск CLI»), гоча HANDOFF #12.
**Cross:** см. Sidetrack #8

### #15 / 2026-10-14 / Сервисные оси — только у приложения; README vdx — как есть

**Source:** user
**Basis:** user-stated
**Basis-detail:** владелец 2026-10-14: «Исключать для библиотек (Recommended)»
(Sidetrack #2) и «Принять как есть (Recommended)» (Sidetrack #3). Проверено
после: с сетом v1.5.0 пакет `cli/` (`bin`) получает обе оси `excluded` (на
v1.4.2 — L1, недобор); у vdx и трёх калибровочных проектов (все — `private`
или composer `type: project`) уровни те же. Тест на сет внутри пакета на
v1.4.2 падает, на v1.5.0 проходит.
**Context:** #2 — исключать ось (`applies_when`), пропускать её уровни
(`any_of` с lib-intent, как `up`/`down` в `lifecycle-interface` L3) или
оставить override каждому проекту. #3 — принять, написать в README строку
подъёма и добавить в шаблон «одной командой» или уточнить шаблон.
**Why:** «Не применимо» честнее, чем L4 даром: уровень библиотеки не растёт
от того, чего у неё нет. Цена — у библиотеки пропадает и L2 `mock-infra`
(msw, nock). #3: ложное «да» бывает только у проекта, чей README рассказывает
о vdx, а клон vdx и правда поднимается одной командой (`mise run build`).
**Implication:** сет v1.5.0 (`04601f4`, minor): `applies_when: { not:
*lib_intent }` у `observability` и `mock-infra`. В CLI — с 0.28: выпуск minor,
а не patch 0.27.1; после него override этих двух осей у vdx снимается.
`secrets-config`, `shared-infra`, `shared-infra-drift` тоже про сервис, в
побег не входили и не тронуты.

## Sidetracks

### #1. `code-style` L2/L4 признаёт только `eslint.config.js`

**Возникло в:** DL #2
**Описание:** `static-analysis` (`eslint_flat`) принимает `.js`, `.mjs` и
`.ts`, а `code-style` L2 и L4 — только `eslint.config.js`. Проект с
`eslint.config.mjs` получит строгий статанализ и L1 по стилю. Для vdx это
неважно (`"type": "module"`, `.js` подходит), но для набора правил это
расхождение — patch сета.

**Status:** resolved — 2026-10-13, сет v1.4.1 (DL #9)

### #2. «Сервисные» оси без условия применимости

**Возникло в:** DL #2
**Описание:** `observability` L2–L4 (логгер, Sentry, Sentry-release) и
`mock-infra` L3–L4 (mock-сервер, проверка в CI) предполагают работающий
сервис. У `release-artifact` есть `applies_when` (lib-intent), у этих осей
условия нет. CLI и библиотека упираются в них так же, как vdx. Решение для vdx —
развилка B; общее решение для рубрики — minor сета, отдельно.

**Status:** resolved — 2026-10-14: сет v1.5.0, обе оси только у приложения
(DL #15)

### #3. `reproducibility` L4 засчитывает `vdx up` в README продукта

**Возникло в:** DL #5, после правки мета-репо
**Описание:** L4 — `README.md` содержит `one-command|vdx up|mise run up|docker
compose up`. README vdx описывает команду `vdx up` как часть продукта, а не
как способ поднять сам vdx. Предикат засчитал L4. Своего `up` у vdx не будет
(DL #4); подъём клона — `mise run build`. Ложное «да» бьёт только по проекту,
чей README говорит о vdx. Варианты: принять как есть, написать в README vdx
настоящую строку подъёма или уточнить предикат (patch сета).

**Status:** resolved — 2026-10-14: принято как есть (DL #15)

### #4. `has_file` на macOS не различает регистр

**Возникло в:** override `mock-infra`, 2026-10-13
**Описание:** `mock-infra` L2 у vdx засчитан по `has_file: tests/Fixtures`, а
в `cli/` лежит `tests/fixtures`. APFS по умолчанию не различает регистр,
`fs.existsSync('tests/Fixtures')` — `true`. На Linux (CI vdx — Ubuntu) тот же
проект получит L1: уровень оси зависит от машины, где идёт аудит. Для vdx
теперь неважно (ось подавлена). Правка — сравнивать имя с записью
`readdir` по каждому сегменту пути; patch CLI.

**Status:** resolved — 2026-10-14: `cli/src/facts.ts` ищет путь по сегментам
в записях `readdir` (кеш на контекст) — `has_file`, `file_contains` и чтение
JSON/YAML/TOML; в `cli/` `has_file: tests/Fixtures` — `false`. Тест на старом
коде падает. Уровни vdx и трёх калибровочных проектов не изменились. Выпуск —
0.28 (minor, вместе с сетом v1.5.0, DL #15)

### #5. `eslint_type_checked` ищет `recommended-type-checked` через дефис

**Возникло в:** DL #7
**Описание:** паттерн флага — `recommended-type-checked`. Так конфиг назывался в
`.eslintrc` (`plugin:@typescript-eslint/recommended-type-checked`). Во flat-конфиге
это `tseslint.configs.recommendedTypeChecked` (или `strictTypeChecked`), и
предикат его не видит. Проверено 2026-10-13 на временной папке (`strict`,
`noUncheckedIndexedAccess`, `eslint.config.js`): `recommendedTypeChecked` —
L2, `recommended-type-checked` — L3. Флаг `eslint_flat` при этом требует
именно flat-конфиг: вместе они засчитываются, только если имя оставить в
комментарии. Правка — patch сета: `recommended-?type-?checked|recommendedTypeChecked|strict-?type-?checked|strictTypeChecked`
(без учёта регистра). Вместе с Sidetrack #1 — один patch.

**Status:** resolved — 2026-10-13, сет v1.4.1 (DL #9)

### #6. mise предупреждает о `[vdx]` в `mise.toml`

**Возникло в:** `mise run check` 2026-10-13, после DL #9
**Описание:** mise 2026.10.3 при каждом `mise run` печатает `mise WARN unknown
field in ~/AI Projects/vdx/mise.toml: vdx`. D4 держит манифест vdx в таблице
`[vdx]` внутри `mise.toml` и рассчитывает, что mise её пропускает молча.
Документация mise (configuration, 2026-10-13): «mise never reads the `[_]`
table, so you can keep your own data in a config file without mise rejecting
the key» — разрешённое место для чужих данных одно, `[_]`. С какой версии
mise ругается, не выяснено. `[vdx]` на этой машине — в трёх проектах:
echelon, mediko, vdx. Правка — формат манифеста (D4, `manifest-format.md`):
`[_.vdx]`, чтение обоих мест, `vdx init` и `vdx_record_success_path` пишут
новое — minor CLI. Развилка — к владельцу.

**Status:** resolved — 2026-10-14: в коде и сете v1.4.2 (DL #10); перенос
проектов — Next actions

### #7. npm 11 не запускает install-скрипты без разрешения

**Возникло в:** DL #12
**Описание:** npm 11.21 на lft при `npm install` в `cli/`: «2 packages have
install scripts not yet covered by allowScripts: esbuild@0.28.2 (postinstall),
fsevents@2.3.3». CLI и тесты работают и так: бинарник esbuild приходит
пакетом под платформу. На чистом клоне с npm 11 то же; CI — на npm из Node 20 и
22, не задет. Разрешить (`npm install-scripts approve`) или отказать — решение
по `allowScripts`, когда что-то сломается или npm сделает это обязательным.

**Status:** open

### #8. `vdx publish` узнаёт о хуке `pre-push`, когда пакет уже в npm

**Возникло в:** DL #14
**Описание:** порядок `vdx publish` — bump, `npm publish`, коммит, тег, push.
Хук `pre-push` проекта идёт последним, и то, что он находит в клоне
(отставшие `node_modules`, красный тест), всплывает, когда версия уже в npm:
откатить её нельзя, остаётся `git push --follow-tags` после починки. Так было
с 0.27.0 на m3. Вариант: pre-flight запускает хук сам (`git hook run
pre-push`, Git 2.36+) до bump — но тогда выпуск вдвое дольше, если push не
идёт с `--no-verify`. Решать, если повторится не на зависимостях: их хук
теперь ловит за секунду (DL #14).

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
- [x] `mise.toml`: `fix` (Prettier, DL #7); `[vdx].verbs`
- [x] Prettier: `cli/.prettierrc`, `.prettierignore` (сет, фикстуры, проза —
      не трогает); `check` и `fix` в `cli/package.json`; разовое
      переформатирование
- [x] Хуки репо: `.githooks/pre-push` — `mise run check` и `mise run test`;
      `core.hooksPath` ставит `prepare` в `cli/package.json`; распознаватель
      видит, `git-hygiene` L4 (DL #11)
- [x] ESLint flat (`recommendedTypeChecked`): `any` разборщиков → `unknown`
      с сужением, тесты под `tsc`; `lint` в `check`, `eslint --fix` в `fix`;
      `.git-blame-ignore-revs` (DL #8)
- [x] Patch сета v1.4.1 по Sidetrack #5 и #1 (DL #9): `eslint_type_checked` видит
      flat-конфиг, `code-style` — `eslint.config.mjs`/`.ts`; калибровка до и
      после; сет CLI и зеркало
- [x] `test:e2e` — пакет из `npm pack` во временном префиксе; нашёл поломку
      на Node 20, пол — Node 22 (DL #13)
- [x] Аудит зависимостей (`check:code:security`), dependabot, `knip` — DL #12
- [x] `docs/architecture.md` — `docs` L4. `README.md` — `mise run up` не нужен:
      `reproducibility` уже L4 (Sidetrack #3)
- [x] Выпуск CLI с правкой оценщика и сетом v1.4.0 — 0.25.0 в npm
      2026-10-13 (`0d1f41f`)
- [x] Манифест в `[_.vdx]` (DL #10): чтение обоих мест, `vdx init` и
      `vdx_record_success_path` пишут новое, `note` в аудите; сет v1.4.2
      (`0e28906`); сет CLI, зеркала, `DEFAULT_BASELINE`
- [x] Выпуск 0.26 (minor): `[_.vdx]`, сеты v1.4.1 и v1.4.2 — 0.26.0 в npm
      2026-10-14 (`9ae7224`); плагин 0.9.3 — скилл `vdx-discover` о `[_.vdx]`
- [x] После 0.26 на m3 и lft: `mise.toml` vdx — в `[_.vdx]`; письма агентам
      echelon и mediko — их манифест в `[vdx]` — 2026-10-14: vdx перенёс,
      письма `vdx-manifest-to-underscore` во входящих echelon и mediko
- [x] `vdx audit .` на выпущенном CLI — целевой уровень (критерий готовности):
      0.26.0, 2026-10-14 — L2, все оси, кроме `branch-protection`, — L4
- [x] Выпуск 0.27 (minor): пол Node 22 (DL #13) — 0.27.0 в npm 2026-10-14
      (`33fca96`); push выпуска — после `npm ci` на m3 (DL #14)
- [x] Выпуск 0.28 (minor): сет v1.5.0 (DL #15), путь с регистром (Sidetrack #4)
      — 0.28.0 в npm 2026-10-14 (`3e13bb6`); аудит vdx на нём — L2
- [x] Когда 0.28 будет на m3 и lft: снять override `observability` и
      `mock-infra` в `.vdx-overrides.yml` — оси `excluded` по сету (DL #15) —
      2026-10-14: 0.28.0 на обеих станциях (`ssh <станция> npm update -g
      @vodmal/vdx-cli` по просьбе владельца), override сняты; аудит 0.28.0 — L2

**Побеги:**

- [x] см. Sidetrack #1 — `code-style` и `eslint.config.mjs`, patch сета (v1.4.1)
- [x] см. Sidetrack #2 — условие применимости для сервисных осей — сет v1.5.0 (DL #15)
- [x] см. Sidetrack #3 — `reproducibility` L4 по README продукта — принято как есть (DL #15)
- [x] см. Sidetrack #4 — `has_file` на macOS не различает регистр — в коде; выпуск — 0.28
- [x] см. Sidetrack #5 — `eslint_type_checked` и flat-конфиг, patch сета (v1.4.1)
- [x] см. Sidetrack #6 — `[vdx]` → `[_.vdx]` в `mise.toml` (DL #10)
- [ ] см. Sidetrack #7 — npm 11 и install-скрипты esbuild, fsevents
- [ ] см. Sidetrack #8 — `vdx publish` и хук `pre-push` после `npm publish`

## References

- Аудит 2026-10-13 — в «Текущей модели» и DL #2. Вывод `vdx audit .`
  воспроизводится командой и тегом сета v1.3.0, поэтому не сохранён.
- Рубрика — `github.com/VoDmAl/vdx-rubric-vodmal`, `vdx-rubric.yaml`: разбор
  осей — на теге v1.3.0, глаголы по классу — с v1.4.0.
- DL #12 кристалла `vdm-gates-wiring-axis` — почему `branch-protection` L3
  «неизвестно» у всех.
