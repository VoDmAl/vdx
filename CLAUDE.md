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

**Спека ядра выложена (2026-05-22).** Решения D1–D11 в
[docs/decisions.md](docs/decisions.md) приняты. Спека draft v0.2 — в
`docs/specs/` (rubric-format, manifest-format, overrides-format, mcp-api,
drift-algorithm). Следующая фаза — реализация: bootstrap-репо рубрики
(`vdx-rubric-vodmal`), нативный оценщик предикатов, MCP-сервер, плагин Claude Code.

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
- `cli/` — TypeScript evaluator + `vdx init` (Шаги C–E).

## Внешний репо: `vdx-rubric-vodmal`

Canonical owner-baseline живёт в отдельном репо:

- **Локально**: `/Users/vdm/AI Projects/vdx-rubric-vodmal/`
- **GitHub**: https://github.com/VoDmAl/vdx-rubric-vodmal (public)
- **Файл**: `vdx-rubric.yaml` — единственный canonical-инстанс рубрики
- **Версионирование**: аннотированные semver-теги (`v0.2.0`, `v0.2.1`, ...)

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
