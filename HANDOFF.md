# vdx — Handoff (2026-10-24, @vodmal/vdx-cli@0.39.2)

Карта для новой сессии: что есть, где лежит, что ждёт, на чём спотыкаются.
Читать первой. Правила работы — [CLAUDE.md](CLAUDE.md), замысел —
[README.md](README.md), история — [PROJECT_CHANGELOG.md](PROJECT_CHANGELOG.md).

---

## Где мы (2026-10-22)

- **CLI** `@vodmal/vdx-cli@0.39.2` — в npm с 2026-10-24 (`aaecf94`), Node 22 и
  новее; на m3 и lft — 0.39.2 с 2026-10-24 (`npm update -g --prefer-online`).
- **Сет** `vdx-rubric-vodmal@v1.8.0` (schema 0.3): рубрика и личный профиль
  `vdx-environment.yaml`, один тег на оба; v1.6.0 (2026-10-22) — ключ
  `agent.intercom_args`, рубрика как в v1.5.0; v1.6.1 — только комментарий оси
  `branch-protection`; v1.7.0 (2026-10-22) — ключ `git.personal_hosts`; v1.8.0
  (2026-10-23) — зеркала gitolite в нём и личный хук `vdx-memory`, нужен vdx 0.38+.
  `DEFAULT_BASELINE` в `cli/src/init.ts` и сет внутри CLI — `@v1.7.0` в 0.37–0.38,
  `@v1.8.0` с 0.39.
- **Манифест** — `[_.vdx]` в `mise.toml` (с 0.26), у vdx тоже. Старый `[vdx]`
  читается; echelon перенёс (`fb4f525`, 2026-10-14), у mediko перенёс vdx
  (2026-10-15, по просьбе владельца; `mise.toml` mediko не в git).
- **Плагин** vdx 0.10.0 (`plugin/`, с `e1d80e1`), едет через маркетплейс vodmal.
- **CI** — GitHub Actions, Node 22 и 24, шаги `mise run check`,
  `mise run test` и `mise run test:e2e`; по понедельникам — `check:code:security`.
- **vdx по своей рубрике — L4** (аудит 2026-10-21, CLI 0.34.0, сет v1.5.0):
  `main` под защитой — `cli (node 22)` и `cli (node 24)` обязательны для всех,
  `branch-protection` L3; остальные оси — L4 (кристалл `vdx-dogfooding`).
  Push в `main` — только `vdx push` (CLAUDE.md, «Push в `main`»).

### Что умеет CLI

| Команда | Что делает |
|---|---|
| `vdx up\|down\|build\|test\|check\|fix` | `mise run <verb>`; нет задачи — exit 2 с подсказкой |
| `vdx audit [path]` | уровень проекта по рубрике сета; `--format=ansi\|markdown\|json` |
| `vdx init [path]` | блок `[_.vdx]` и задачи словаря в `mise.toml` из того, что уже есть в проекте |
| `vdx publish <patch\|minor\|major>` | выпуск одной командой: вход в npm, bump, publish, тег, push, ожидание registry |
| `vdx push [path]` | push ветки; ветка на GitHub с обязательными проверками получает коммит через `vdx-gate/<ветка>`, когда CI его проверил (с 0.31) |
| `vdx doctor [path]` | окружение и хуки, токен GitHub у репо на GitHub, где память Claude Code; `--check` для хука плагина, `--fix` пишет личные хуки в `~/.gitconfig` и переносит память в `.claude/memory/` (с 0.37) |
| `vdx ai[@host] [path]` | агент в tmux по личному профилю; `--new`, `--conversation`, `--focused`, `--restart`, `--detach`, `--dry-run`, `--check` |
| `vdx-mcp` | MCP-сервер для агента (`vdx_audit`, `vdx_build`, …) |

У каждой команды есть `--help`; чужой аргумент — отказ, exit 2.

---

## Активная работа — кристаллы `docs/tasks/`

Кристалл — `workitem.md`: Decision Log, Sidetracks, Next actions. Источник
правды по задаче; чат под компакцией теряется.

| Кристалл | Статус | Что открыто |
|---|---|---|
| [intercom-session-mode](docs/tasks/intercom-session-mode/workitem.md) | dormant с 2026-10-22 | почтовая сессия `vdx ai --intercom` и `vdx ai --close` — в 0.36.0, проверено на выпущенном (DL #8); ответы ai-dev-plugins, nas-info, echelon — есть; запуск из `send` — у ai-dev-plugins, только с `intercom.mail-session: true`; открыты побеги: окно доверия при `--detach` (#4), строка выбора разговора (#5), место на lft (#1), окно закрытия (#2) |
| [claude-memory-in-project](docs/tasks/claude-memory-in-project/workitem.md) | in-progress с 2026-10-22 | память агента в `.claude/memory/` проекта (письмо nas-info): `memory.ts`, `vdx doctor --fix`, вопрос в `vdx ai`, перенос папки — в 0.37.0; сет v1.7.0 (`git.personal_hosts`); 0.37.1; память 34 проектов перенесена (2026-10-23); сторож коммита памяти (DL #11, #12) — в 0.38.0, хук `vdx-memory` на lft и m3 (сет v1.8.0); в 0.39.0: заметки старых сессий после переноса, второй клон, доверие к папке (DL #13, Sidetracks #2, #4, #5); идущие сессии перезапущены (2026-10-24); в 0.39.1: общая память клонов одного репо — не предупреждение (DL #14); в 0.39.2: старый путь по ссылке — тоже перенос (DL #15); дальше: ответ www.t23b.org о коммите памяти (7 из 8), ответ nas-info о ссылках при смене корня (Sidetrack #6); потом перенос папок — у владельца с nas-info |
| [hosting-extension](docs/tasks/hosting-extension/workitem.md) | done 2026-10-22 | `branch-protection` L3 — GitHub (0.29.0), GitLab (0.33.0), Bitbucket Server (0.34.0); vdx под гейтом, общий L4; отвергнутый вход Bitbucket — причина с командой (0.36.0); отложен gitolite (Sidetrack #1) |
| [vdx-dogfooding](docs/tasks/vdx-dogfooding/workitem.md) | dormant с 2026-10-14 | цель достигнута (общий L2, оси, кроме `branch-protection`, — L4, CLI 0.28.0); побеги #7 и #8 ждут повода; что будит — «Текущая модель» |
| [vdx-ai](docs/tasks/vdx-ai/workitem.md) | dormant | отставшая сессия — `✗` в `vdx ai --check` (DL #37, Sidetrack #24) — в 0.35.0 с 2026-10-22; Sidetrack #23 (сервер tmux после прерванных тестов) закрыт 2026-10-24 — открытых пунктов нет |
| [vdm-gates-wiring-axis](docs/tasks/vdm-gates-wiring-axis/workitem.md) | done 2026-10-13 | — |

**vdx-dogfooding** — vdx по своей рубрике (DL #2–#4). До 0.29 общий выше L2
не получал никто: `branch-protection` L3 был «неизвестно» у всех. Поэтому
цель — L2 и каждая ось, кроме этой, на L4. С 0.29 у репо на GitHub L3
известен, у vdx — «не выполнено» (`hosting-extension`).
`observability` и `mock-infra` у библиотеки сет v1.5.0 исключает (DL #15).
`up`/`down` рубрика не требует от библиотек (сет v1.4.0).

**vdm-gates-wiring-axis** (закрыт) — гейт vdm и страж echelon как личные хуки
профиля (`git.hooks`), не ось рубрики. 0.22.0, сет v1.0.0–v1.1.0: schema 0.3,
распознаватель хуков, `vdx doctor --check/--fix`. Оба хука — в `~/.gitconfig`
обеих станций.

**vdx-ai** — команда `vdx ai` ([D14](docs/decisions.md)): разговор Claude Code
продолжается на машине, где он идёт (DL #27); машины проекта —
`session.machines` профиля (DL #29); `vdx ai@<host>` говорит с места человека
(DL #30); `--focused` (DL #32); строка о папках, которых не видит сессия
(DL #33); дрейф флагов в терминале — вопрос, а не отказ (DL #34).

### Ждём извне

- **echelon** — снимает старые строки стража в репо по своему правилу; ответа
  vdx не нужно (`echelon-guard-ready-outcome`).
- **limeflow** — !750 (SPACEFINAM-717, husky из `postinstall`) вливает группа,
  без срока. До мержа limeflow по `git-hygiene` — L1.

### Следующий выпуск CLI

Ничего срочного. 0.39.2 (2026-10-24, `aaecf94`) — старый путь памяти, который ведёт в папку
по ссылке на её прежнем месте, — перенос: `--fix` переносит и разговоры (`claude-memory-in-project`
DL #15); registry показал её через ~105 с. 0.39.1 (2026-10-24, `287cae3`) — общая память клонов одного репо
(`claude-memory-in-project` DL #14): `vdx doctor` не предупреждает о пути из
`.claude/settings.json` под git в другой клон того же репо; registry показал её через 112 с.
0.39.0 (2026-10-24, `024f4d1`) — `DEFAULT_BASELINE` `@v1.8.0`; память после переноса —
заметки старых сессий со строками индекса, путь второго клона в `settings.local.json`,
доверие Claude Code к папке (`claudeTrusts`): строка после переноса и отказ `vdx ai
--detach`; строка «сначала wrap» перед перезапуском в новый разговор
(`claude-memory-in-project`); registry показал её через 111 с после `npm publish`. 0.38.0 (2026-10-23, `f1d338d`) —
сторож коммита памяти `vdx doctor --staged`, «личный» — кто читает (зеркала в
`git.personal_hosts`), `vdx doctor` видит названную папку без git, домашний каталог —
не проект. 0.37.1 (2026-10-23, `1b93cef`) — вопрос
«под git?» в `vdx doctor --fix` при отчёте не в терминал, строка о почтовых
разговорах. 0.37.0 (2026-10-23,
`6b28794`) — память Claude Code в проекте (`claude-memory-in-project`), сет v1.7.0
внутри. 0.36.0 (2026-10-22, `a766140`) — почтовая сессия `vdx ai
--intercom` и `vdx ai --close` (`intercom-session-mode`), отвергнутый вход
Bitbucket (`hosting-extension` DL #20), сет v1.6.1 внутри, `vdx publish` без
терминала — отказ до bump, 5xx npm — сбой npm, не вход; registry показал её через
112 с после `npm publish`. 0.33.0 (2026-10-20, `6587434`) — `branch-protection` на GitLab
(`hosting-extension` DL #12); токен — только своему хосту.
0.32.1 (2026-10-20, `543d937`) — ожидание `vdx push` спрашивает
снова, если GitHub не ответил (0.32.0 остановился на одном `ETIMEDOUT`); registry
показал его через 262 с после `npm publish`. 0.32.0 (2026-10-20) — у «не выполнено» причина: предикат отвечает `{ no }`, отчёт —
раздел «Not met», JSON — `not_met`; первым её называет `branch-protection`
(`hosting-extension` DL #11). 0.31.3 (2026-10-19) — `vdx doctor` называет токен
GitHub и работает ли он; `vdx publish` ждёт registry до 10 мин от `npm publish`
и спрашивает, если в пакете ничего не менялось с тега текущей версии
(`hosting-extension` Sidetracks #7, #9, #6). 0.31.2 (2026-10-19, `1e2dbe6`) — второй агент рядом с идущим — в
своей сессии tmux (`<имя>-2`, `-3`…), а не окном, которое уводило все
терминалы сессии (`vdx-ai` DL #36); registry показал версию позже 3 мин
ожидания (`hosting-extension` Sidetrack #9). 0.31.1 (2026-10-19, `8e26027`) — `vdx push` ждёт коммит, которого
GitHub сразу после push ещё не показывает (422 «No commit found»), а до push
спрашивает проверки только при втором `vdx push`; vdx в проекте, который
закрепил старый node (`bin/node-guard.cjs`, kratos с `.nvmrc` v16.19.0).
Выпущен рабочим CLI; push `b4a35b1` и push выпуска прошли гейт с первого раза.
0.31.0 (2026-10-18) — `vdx push` и выпуск через проверки
ветки (`src/gate.ts`, `hosting-extension` DL #8–#10); распознаватель хуков не
считает гейтом переменную, которая только выпускает хук (`VDX_GATE_PUSH`).
0.30.0 (2026-10-18, с m3) — второй `vdx publish minor` без
изменений: код 0.29.0. 0.29.0 (2026-10-15) — `branch-protection` L3
спрашивает GitHub (`src/hosting.ts`, кристалл `hosting-extension`). 0.28.0 (2026-10-14) — сет v1.5.0: `observability` и
`mock-infra` только у приложения (`vdx-dogfooding` DL #15); путь в `has_file` и
`file_contains` — с регистром, как написан, и на macOS (Sidetrack #4). 0.27.0 (2026-10-14) — пол Node 22: `engines`, `vdx doctor`
(`vdx-dogfooding` DL #13); на Node 20 npm теперь предупреждает, vdx там не
стартует. 0.26.0 (2026-10-14) увёз манифест в `[_.vdx]` (`vdx-dogfooding`
DL #10) и сеты v1.4.1 и v1.4.2; плагин 0.9.3 — скилл `vdx-discover` о
`[_.vdx]`. Порядок выпуска — «Выпуск CLI» и «Выпуск плагина» в
[CLAUDE.md](CLAUDE.md).

---

## Карта репо

```
vdx/
├── CLAUDE.md, HANDOFF.md, README.md, PROJECT_CHANGELOG.md
├── mise.toml            ← словарь vdx: build, check, test, test:smoke (stack=meta)
├── Makefile             ← те же задачи через npm, без mise; `make build` — typecheck,
│                          а `mise run build` — npm install
├── .vdx-overrides.yml   ← secrets-config, shared-infra, shared-infra-drift — не про vdx
├── .githooks/pre-push   ← `check`, `test`, `test:e2e` перед push; включает
│                          `prepare` в `cli/package.json` (`mise run build`)
├── .github/workflows/ci.yml   ← check и test на push в main и на PR
├── .github/workflows/audit.yml ← check:code:security по понедельникам
├── .github/dependabot.yml     ← обновления npm (cli/) и actions — раз в месяц, по PR на экосистему
├── marketplace/         ← inline-маркетплейс для чужих (README); у владельца плагин
│                          едет через VoDmAl/ai-dev-plugins
├── plugin/              ← плагин Claude Code: SessionStart → vdx ai --check и
│                          vdx doctor --check; после vdx_up — запись пути успеха;
│                          skills vdx-ai и vdx-discover
├── cli/
│   ├── src/             ← index.ts (команды), ai.ts + conversations.ts (vdx ai),
│   │                      audit/evaluator/predicates/scoring/rubric/facts (аудит),
│   │                      hooks.ts + personal-hooks.ts + doctor.ts, publish.ts,
│   │                      init.ts, run.ts, vocabulary.ts, mcp-server.ts, …
│   ├── tests/unit/      ← vitest
│   ├── tests/e2e/       ← пакет из `npm pack` во временном префиксе (`test:e2e`)
│   └── smoke.sh         ← аудит трёх калибровочных проектов (локальные пути)
└── docs/
    ├── decisions.md     ← ⭐ D1–D14, открытые вопросы, наблюдения
    ├── architecture.md  ← карта модулей cli/ и путь вызова
    ├── specs/           ← rubric-format, manifest-format, overrides-format,
    │                      environment-format, mcp-api, drift-algorithm + зеркала
    │                      vdx-rubric.example.yaml, vdx-environment.example.yaml
    ├── tasks/           ← кристаллы
    ├── maturity-rubric.md, landscape.md, decision.md, research/
```

**Рядом:**
- `/Users/vdm/AI Projects/vdx-rubric-vodmal/` — canonical сет
  (github.com/VoDmAl/vdx-rubric-vodmal, public). `~/.vdx-environment.yaml` —
  симлинк в него. Правила синхронизации и semver — CLAUDE.md.
- Калибровочные проекты (не эталоны): telegram.vorobyev.name (PHP, много
  инструментария от проб), www.t23b.org (PHP, mid), trading-tools-bookmap
  (Node/TS, смешанный). Пути — CLAUDE.md.

**Станции:** lft (`work-imac`) и m3 (`imac-m3`). vdx, git, tmux на них ставит
nas-info; новый релиз из npm доезжает с ближайшим topgrade. Сейчас: git 2.54
на lft и 2.56 на m3, tmux 3.6a и 3.7c. `ssh m3` и `ssh lft` в BatchMode
работают с любой станции, и из ssh-сессии тоже (nas-info, 09–13.10). Кроме
одного случая: lft перезагрузилась и никто не вошёл — агента ключей нет, и
`ssh m3` из ssh-сессии на lft получит отказ.

---

## Решения

Полностью — [docs/decisions.md](docs/decisions.md); решения внутри задачи —
Decision Log её кристалла.

| ID | Решение |
|----|---------|
| D1–D2 | Рубрика принадлежит человеку/организации; иерархия general → стек |
| D3 | Раннер — mise, не свой |
| D4 | Манифест — `mise.toml` + блок `[_.vdx]` (до 0.26 — `[vdx]`) |
| D5, D10 | Аудит: готовый сбор фактов, своё — рубрика и drift; движок нативный |
| D6 | Упаковка для Claude Code — плагин (MCP + skill + hook) |
| D7 | Скоринг: критичные оси — минимум, вспомогательные — ≥ 80 % |
| D8 | `shared-infra` — качество подхода, не дрейф файлов |
| D9 | Override — `.vdx-overrides.yml` |
| D11 | Сет — отдельный git-репо с semver-тегами |
| D12 | `publish` — седьмой глагол, только для библиотек; `deploy` (D13) отложен |
| D14 | `vdx ai`: агент стартует по личному профилю, не вшитому в CLI |

---

## Гочи, которых не видно из файлов

1. **Уровни рубрики — дельты.** `levels.LN.requires` — дельта к L(N−1),
   уровень — максимальный непрерывный (`rubric-format.md`, «Семантика
   уровней»).
2. **Калибровочные проекты — не эталоны.** Много инструментария ≠ образец
   (N4 в decisions.md).
3. **Личные хуки идут на каждом коммите машины** — и во временных репо
   тестов. С Git 2.54 хуки берутся из `~/.gitconfig` (`hook.<имя>.command`), и
   `core.hooksPath` их не выключает. Тест, который коммитит, зовёт git с
   пустым `GIT_CONFIG_GLOBAL` и `GIT_CONFIG_NOSYSTEM=1` (так в `author`,
   `doctor`, `personal-hooks`, `publish`).
4. **tmux < 3.5 печатает вывод `run-shell` в панель, а не вызывающему.** На
   раннере CI (ubuntu) tmux 3.4: ответ сервера tmux брать из файла.
5. **Тесты tmux в `ai.test.ts` зависят от порядка.** `vitest -t <фильтр>` их
   роняет — гонять файл целиком. Под нагрузкой машины полный прогон
   иногда упирается в таймауты (doctor, `--version`) — перезапустить, прежде
   чем чинить.
6. **`mise exec` / `mise run` сами ставят инструменты** в кеш mise машины.
   Проверка с другой версией Node — побочный эффект на станции; убрать —
   `mise uninstall node@<версия>`.
7. **Логи GitHub Actions анонимно — 403.** Причина падения теста — в
   аннотациях check-run (`/repos/VoDmAl/vdx/check-runs/<job id>/annotations`).
8. **`.git` синхронизируется между станциями.** Копии `*.sync-conflict-*` в
   `.git` останавливают подготовку коммита: сравнить с оригиналом, удалить.
   За индексом — наблюдение в Next actions vdx-ai.
9. **`npm i -g <клон>` на станции живёт до цикла nas-info** (~15 мин) — его
   заменит пакет из npm. Неопубликованное проверять в `cli/`:
   `npm run vdx -- <команда>`.
10. **Комбайн.** «Давай напишем свой X» — скорее всего, ошибка: сначала
    искать готовое.
11. **Push в `main` — только `vdx push`, с 2026-10-18.** `main` под защитой:
    прямой `git push` GitHub отклонит. `vdx push` кладёт коммит в
    `vdx-gate/main`, ждёт `cli (node 22)` и `cli (node 24)` (около 1,5 мин) и
    пушит тот же коммит в `main`; хук `pre-push` при этом проверки не гоняет
    (`VDX_GATE_PUSH=1`). Обычный `git push` в другую ветку проходит хук —
    около 1 мин 40 с. Хук сбрасывает переменные, которые git отдаёт хуку
    (`git rev-parse --local-env-vars`): иначе временные репо тестов смотрели бы
    в `.git` vdx (githooks(5)).
12. **`cli/node_modules` между станциями не синхронизируется** (`.git` и
    исходники — да). Зависимости, сменённые на одной станции, на другой
    появятся только после `npm --prefix cli ci`. Хук `pre-push` сверяет
    `node_modules` с lock-файлом первым и называет недостающие пакеты; так
    упал push выпуска 0.27.0 на m3 (`vdx-dogfooding` DL #14).
13. **В проекте со старым node vdx — два процесса.** fnm на станциях
    переключает node по `.nvmrc` (`--use-on-cd`), `env node` в запускалке
    берёт node проекта; `bin/node-guard.cjs` запускает vdx снова на `node`
    рядом со ссылкой на bin. Проверить руками — node 16 из fnm на lft:
    `~/.local/share/fnm/node-versions/v16.19.0/installation/bin/node`.
14. **Тесты из сессии `vdx ai --focused` несут `VDX_FOCUSED=1`** в агентов и
    сервер tmux, которых запускают. `ai.test.ts` его сбрасывает; новый файл
    тестов, который запускает агента, — тоже должен.

---

## Полезные команды

```bash
cd "/Users/vdm/AI Projects/vdx"
mise run build          # npm install в cli/; prepare включает .githooks/
mise run check          # typecheck (с тестами), Prettier, ESLint, knip в cli/ — его зовёт CI
mise run check:code:security  # npm audit зависимостей пакета; сеть; CI — раз в неделю
mise run fix            # eslint --fix и Prettier в cli/; после правок кода — до коммита
mise run test           # unit-тесты cli/
mise run test:e2e       # пакет, каким его отдаёт npm: pack, установка, оба бинарника
mise run test:smoke     # аудит трёх калибровочных проектов (не в CI)
vdx audit .             # vdx по своей рубрике
vdx doctor              # окружение и личные хуки этой станции
npm --prefix cli run vdx -- ai --dry-run <path>   # неопубликованный CLI
```

---

## Контекст владельца

- Общение на русском, кратко. Подтверждения короткие («Окей», «Давай»).
- Делегирует автономно, когда направление ясно; материальные развилки —
  выносить явно, с рекомендацией.
- Сначала проверить, нет ли готового.
- Фиксация в файлах: Decision Log кристалла и `decisions.md`, а не память
  сессии.
- Коммит и push запускает сам; агент готовит строку коммита.
- Изменения на станциях — через nas-info (письмо по intercom), не командой
  владельцу.

---

## История

Пошаговая история весны 2026 (шаги A–Z.5, версии 0.2–0.10) — в
[PROJECT_CHANGELOG.md](PROJECT_CHANGELOG.md). Прежний HANDOFF с подробностями
каждого шага — `git show 65f5543:HANDOFF.md`.
