# vdx — Handoff (2026-10-09, @vodmal/vdx-cli@0.24.0)

Карта для новой сессии: что есть, где лежит, что ждёт, на чём спотыкаются.
Читать первой. Правила работы — [CLAUDE.md](CLAUDE.md), замысел —
[README.md](README.md), история — [PROJECT_CHANGELOG.md](PROJECT_CHANGELOG.md).

---

## Где мы (2026-10-09)

- **CLI** `@vodmal/vdx-cli@0.24.0` — в npm и на обеих станциях (lft, m3).
- **Сет** `vdx-rubric-vodmal@v1.3.0` (schema 0.3): рубрика и личный профиль
  `vdx-environment.yaml`, один тег на оба. `DEFAULT_BASELINE` в
  `cli/src/init.ts` — `@v1.3.0`.
- **Плагин** vdx 0.9.1 (`plugin/`), едет через маркетплейс vodmal.
- **CI** — GitHub Actions, Node 20 и 22, шаги `mise run check` и
  `mise run test`; зелёный на `65f5543`.
- **vdx по своей рубрике — L1** (аудит 2026-10-08). Критичные оси:
  `lifecycle-interface` L2, `tests` L3, `static-analysis` L2, `ci` L4,
  `branch-protection` — неизвестно. Требование догфудинга из CLAUDE.md не
  выполнено; подъём отложен владельцем (Sidetrack #20 в
  `vdm-gates-wiring-axis`).

### Что умеет CLI

| Команда | Что делает |
|---|---|
| `vdx up\|down\|build\|test\|check\|fix` | `mise run <verb>`; нет задачи — exit 2 с подсказкой |
| `vdx audit [path]` | уровень проекта по рубрике сета; `--format=ansi\|markdown\|json` |
| `vdx init [path]` | `[vdx]` блок и задачи словаря в `mise.toml` из того, что уже есть в проекте |
| `vdx publish <patch\|minor\|major>` | выпуск одной командой: вход в npm, bump, publish, тег, push, ожидание registry |
| `vdx doctor [path]` | окружение и хуки; `--check` для хука плагина, `--fix` пишет личные хуки в `~/.gitconfig` |
| `vdx ai[@host] [path]` | агент в tmux по личному профилю; `--new`, `--conversation`, `--focused`, `--restart`, `--detach`, `--dry-run`, `--check` |
| `vdx-mcp` | MCP-сервер для агента (`vdx_audit`, `vdx_build`, …) |

У каждой команды есть `--help`; чужой аргумент — отказ, exit 2.

---

## Активная работа — кристаллы `docs/tasks/`

Кристалл — `workitem.md`: Decision Log, Sidetracks, Next actions. Источник
правды по задаче; чат под компакцией теряется.

| Кристалл | Статус | Что открыто |
|---|---|---|
| [vdm-gates-wiring-axis](docs/tasks/vdm-gates-wiring-axis/workitem.md) | in-progress | только Sidetrack #20 (догфудинг до высшего уровня) — отложен; вернуться отдельным кристаллом |
| [vdx-ai](docs/tasks/vdx-ai/workitem.md) | dormant | ответ nas-info `ssh-peers-agent`; наблюдение за `.git/index.sync-conflict-*`; Sidetrack #21 — выйдет со следующим выпуском |

**vdm-gates-wiring-axis** — гейт vdm и страж echelon как личные хуки профиля
(`git.hooks`), не ось рубрики. Выпущено 2026-10-08 (0.22.0, сет v1.0.0–v1.1.0):
schema 0.3, распознаватель хуков, `vdx doctor --check/--fix`. Оба хука — в
`~/.gitconfig` обеих станций (lft 08.10, m3 09.10 после git 2.56 от nas-info).

**vdx-ai** — команда `vdx ai` ([D14](docs/decisions.md)): разговор Claude Code
продолжается на машине, где он идёт (DL #27); машины проекта —
`session.machines` профиля (DL #29); `vdx ai@<host>` говорит с места человека
(DL #30); `--focused` (DL #32); строка о папках, которых не видит сессия
(DL #33); дрейф флагов в терминале — вопрос, а не отказ (DL #34).

### Ждём извне

- **nas-info** — `ssh-peers-agent`: ssh станция → станция из ssh-сессии без
  агента ключей (Sidetrack #18 vdx-ai). `ssh-self-alias` закрыт 2026-10-09:
  `ssh <своя метка>` работает на самой станции.
- **echelon** — снимает старые строки стража в репо по своему правилу; ответа
  vdx не нужно (`echelon-guard-ready-outcome`).
- **limeflow** — !750 (SPACEFINAM-717, husky из `postinstall`) вливает группа,
  без срока. До мержа limeflow по `git-hygiene` — L1.

### Следующий выпуск CLI

Без срочности. Ждёт: Sidetrack #21 vdx-ai (проверка папок через файл — на
tmux < 3.5 прежняя проверка читала все папки как доступные; на станциях tmux
≥ 3.5, 0.24.0 у них верен). Порядок выпуска — «Выпуск CLI» и «Выпуск
плагина» в [CLAUDE.md](CLAUDE.md).

---

## Карта репо

```
vdx/
├── CLAUDE.md, HANDOFF.md, README.md, PROJECT_CHANGELOG.md
├── mise.toml            ← словарь vdx: build, check, test, test:smoke (stack=meta)
├── Makefile             ← алиасы make → mise run, для тех, кто не знает mise
├── .vdx-overrides.yml   ← secrets-config, shared-infra, shared-infra-drift — не про vdx
├── .github/workflows/ci.yml
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
│   └── smoke.sh         ← аудит трёх калибровочных проектов (локальные пути)
└── docs/
    ├── decisions.md     ← ⭐ D1–D14, открытые вопросы, наблюдения
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
на lft и 2.56 на m3, tmux 3.6a и 3.7c.

---

## Решения

Полностью — [docs/decisions.md](docs/decisions.md); решения внутри задачи —
Decision Log её кристалла.

| ID | Решение |
|----|---------|
| D1–D2 | Рубрика принадлежит человеку/организации; иерархия general → стек |
| D3 | Раннер — mise, не свой |
| D4 | Манифест — `mise.toml` + `[vdx]` блок |
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

---

## Полезные команды

```bash
cd "/Users/vdm/AI Projects/vdx"
mise run build          # npm install в cli/
mise run check          # typecheck cli/
mise run test           # unit-тесты cli/
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
