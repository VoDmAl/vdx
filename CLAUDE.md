# vdx — инструкции для AI-агента

> 📌 **Новая сессия?** Сначала прочитай [HANDOFF.md](HANDOFF.md) — там состояние,
> следующие шаги, гочи. Этот файл (`CLAUDE.md`) — короткие правила.

## Что это за проект

vdx — исследование и (позже) реализация системы, которая даёт **единый интерфейс
жизненного цикла** (`up/down/build/test/check/fix`) и **версионируемую рубрику
зрелости** для проектов на любом стеке. Полное описание — в [README.md](README.md).

Главная цель vdx — чтобы AI-агент мог эксплуатировать любой проект без
повторного разбора «как он устроен». vdx сам по себе — это слой, который агент
читает.

## Текущая фаза

**Реализация (с 2026-05).** CLI `@vodmal/vdx-cli` в npm, сет
`vdx-rubric-vodmal`, MCP-сервер, плагин Claude Code; решения — D1–D14 в
[docs/decisions.md](docs/decisions.md), спека — `docs/specs/`. vdx по своей
рубрике — общий L4 (с 2026-10-18): `main` на GitHub берёт коммит только после
проверок CI, обязательных для всех. Версии и что открыто —
[HANDOFF.md](HANDOFF.md).

## Ключевые ограничения

- **Свой раннер не делать.** Цель — оседлать готовый инструмент (mise — кандидат,
  не решение). Любое предложение «написать свой task-runner» — против замысла.
- **Комбайн, не монолит.** Собирать из готовых кусочков (раннер, аудит-движок,
  линтеры), дописывать только недостающее — например Claude Code skill. Чем
  меньше своего кода — тем лучше.
- **Воспроизводимость > фич.** Сначала надёжный единый словарь команд, потом всё
  остальное.
- **Рубрика версионируется.** Аудит измеряет дрейф проекта от *текущей* версии
  рубрики — это центральная механика, не побочная.
- **Догфудинг.** vdx обязан соответствовать своей же рубрике на высшем уровне.

## Конвенции

- Проза в `README.md` и `docs/` — на русском, технические термины — как есть.
- Значимые изменения → запись в [PROJECT_CHANGELOG.md](PROJECT_CHANGELOG.md):
  заголовок + 1–2 предложения + ссылки.
- Исследовательские находки и решения фиксируются в `docs/`, не растворяются в чате.
- Калибровочные референсы (НЕ «эталоны», а образцы разных состояний):
  `/Users/vdm/PhpstormProjects/git.vorobyev.name/telegram.vorobyev.name` (PHP,
  экспериментально-глубокий — накопил много инструментария за счёт проб,
  местами over-engineered), `/Users/vdm/PhpstormProjects/git.vorobyev.name/www.t23b.org`
  (PHP, практический mid) и `/Users/vdm/AI Projects/trading-tools-bookmap`
  (Node/TS, смешанное состояние).

## Где что лежит

- `docs/decisions.md` — research-журнал: что решено (D1–D11) / открыто / наблюдалось.
  Главный источник правды. Сюда же — новые решения и вопросы.
- `docs/landscape.md` — обзор существующих инструментов (что делает / не делает).
- `docs/maturity-rubric.md` — рубрика зрелости v0.2 (калибровано по 3 референсам).
- `docs/decision.md` — итоговая рекомендация build-vs-adopt.
- `docs/specs/` — спека ядра: rubric-format, manifest-format, overrides-format,
  mcp-api, drift-algorithm. Здесь же `vdx-rubric.example.yaml` — **зеркало**
  canonical-рубрики для документации.
- `cli/` — TypeScript evaluator + `vdx init` (Шаги C–E). Карта модулей и путь
  вызова — `docs/architecture.md`.

## Внешний репо: `vdx-rubric-vodmal`

Canonical owner-baseline живёт в отдельном репо:

- **Локально**: `/Users/vdm/AI Projects/vdx-rubric-vodmal/`
- **GitHub**: https://github.com/VoDmAl/vdx-rubric-vodmal (public)
- **Файлы**: `vdx-rubric.yaml` — единственный canonical-инстанс рубрики;
  `vdx-environment.yaml` — личный профиль для `vdx ai` (D14), зеркало —
  `docs/specs/vdx-environment.example.yaml`
- **Версионирование**: аннотированные semver-теги (`v0.2.0`, `v0.2.1`, ...),
  один тег на оба документа; `metadata.version` обоих совпадает с тегом

**Правила синхронизации:**

1. Изменения в логике/осях рубрики делаются **сначала** в
   `vdx-rubric-vodmal/vdx-rubric.yaml`, потом mirror'ятся в
   `docs/specs/vdx-rubric.example.yaml` (для docs).
2. Любое изменение canonical-файла = новый semver-тег + запись в
   `vdx-rubric-vodmal/CHANGELOG.md`:
   - patch (`v0.2.1` → `v0.2.2`): bugfix предиката, regex, threshold
   - minor (`v0.2.X` → `v0.3.0`): новая ось, новый flag, изменение weights
   - major: переименование/удаление осей, breaking change `schema_version`
3. После тега — push на GitHub. Manifest-ссылки в проектах указывают на
   конкретный тег: `baseline: github.com/VoDmAl/vdx-rubric-vodmal@v0.2.1`.
4. Default baseline в `cli/src/init.ts` (константа `DEFAULT_BASELINE`)
   обновлять при выпуске нового тега.

## Push в `main`

- `main` под защитой (с 2026-10-18): проверки `cli (node 22)` и `cli (node 24)`
  обязательны для всех, админов тоже; PR не нужен. Прямой `git push` в `main`
  GitHub отклоняет — push только `vdx push`: коммит уходит в `vdx-gate/main`, CI
  около 1,5 мин, потом тот же коммит в `main` (кристалл `hosting-extension`).
- Строка коммита для владельца кончается на
  `&& vdx push '/Users/vdm/AI Projects/vdx'`, не на `git push`. Хук `pre-push`
  под `vdx push` проверки не гоняет — их делает CI; красная проверка оставляет
  `main` как был и называет проверку со ссылкой.

## Выпуск CLI

- `vdx publish <patch|minor|major>` запускает владелец в своём терминале — одной
  командой (с 0.20): истёкший вход в npm — `npm login` по ходу, версия в
  `package.json` и `cli/package-lock.json` одним коммитом, npm спрашивает OTP или
  подтверждение в браузере (Ctrl-C там возвращает версию назад, с 0.24),
  тег, `git push --follow-tags`, ожидание версии в registry — до 10 мин от
  `npm publish` (с 0.31.3; Ctrl-C там останавливает только ожидание). Ничего в
  `cli/` с тега текущей версии — вопрос, Enter ничего не выпускает (0.30.0
  вышел так, `hosting-extension` Sidetrack #6).
  `--no-push` оставляет коммит и тег локальными.
- Pre-flight требует чистое дерево: незакоммиченное до выпуска — закоммитить
  заранее. Push выпуска идёт через проверки CI, как `vdx push` (с 0.31):
  коммит выпуска — в `vdx-gate/main`, потом `main` с тегом; красный CI — пакет
  в npm и тег уже есть, `vdx push` после починки. Коммиты, которых нет в
  `main`, — отказ до bump (npm получил бы их раньше CI): сначала `vdx push`.
  Ветка позади upstream — тоже отказ до bump.
- `cli/node_modules` между станциями не синхронизируется: зависимости,
  сменённые на другой станции, — `npm --prefix cli ci` до выпуска. Хук
  сверяет `node_modules` с lock-файлом первым (`npm ls`) и называет пакеты.
- На рабочие станции (m3, lft) vdx ставит nas-info; версия не закреплена
  (с 2026-09-29), новый релиз из npm доезжает с ближайшим topgrade. Не ждать
  его — `ssh <станция> npm update -g @vodmal/vdx-cli`: тот же шаг, что у
  topgrade, и npm тот, что видит ssh (одна копия vdx на машине). Письмо
  nas-info — только если релизу нужно что-то кроме пакета: ключ профиля,
  переменная окружения, бейдж. Придержать плохой релиз — `VDX_VERSION` в
  `nas-info/ansible/config/roles/workstation.conf`, по письму nas-info.
- `npm i -g <клон>` на станции модуль nas-info заменяет пакетом из npm
  за цикл gather (~15 мин). Неопубликованное проверять в `cli/`:
  `npm run vdx -- ai --dry-run`.

## Выпуск плагина

- Плагин (`plugin/`) едет к агентам через маркетплейс vodmal
  (`VoDmAl/ai-dev-plugins`, запись `git-subdir` → `VoDmAl/vdx`, `plugin`).
  На машинах владельца маркетплейс зарегистрирован как
  `vodmal-claude-code-marketplace`: плагин — `vdx@vodmal-claude-code-marketplace`.
- Выпуск — поднять `version` в `plugin/.claude-plugin/plugin.json` и запушить
  `main`; запись в маркетплейсе не трогать (ответ ai-dev-plugins 2026-10-04).
  Пока `version` прежняя, установленные копии остаются на кешированной.
- Хук плагина зовёт CLI: флаг, которого нет в старых vdx, — только после
  проверки `vdx --version` (как `--check` в `scripts/session-start.sh`).
