---
title: "Все сессии tmux в сайдбаре cmux: вкладка-наблюдатель"
slug: cmux-sidebar-all-tmux-sessions
description: "Открывает вкладку cmux для каждой сессии tmux на m3 и lft, которую сейчас не показывает ни одна вкладка"
status: ready
session-type: other
created: 2026-11-26
last-updated: 2026-11-26
relates-to: ["[[restore-after-any-crash/workitem|restore-after-any-crash]]", "[[focused-topic/workitem|focused-topic]]", "[[intercom-session-mode/workitem|intercom-session-mode]]", "[[vdx-ai-predictable/workitem|vdx-ai-predictable]]"]
---

# Все сессии tmux в сайдбаре cmux: вкладка-наблюдатель

> Из письма nas-info `cmux-sidebar-all-tmux-sessions` (2026-11-26T15:04Z). Владелец хочет видеть в cmux слева все
> сессии tmux обеих машин. Из трёх путей он выбрал вкладку-наблюдатель у vdx. Кристалл завела сессия intercom:
> правку кода делает основная сессия, а кристалл ждёт её в `ready`.

## Назначение

**Боль.** Сессии, начатые без терминала, в cmux не видны. Это сессия intercom (`--intercom --detach`), шаги HQ
(`--focused --detach`) и поднятые `--restore`. Пример: `vdx@m3-intercom` 26.11 поднималась трижды, разбирала письма,
закрывалась и ни разу не появилась слева. Не видны и сессии без клиента вообще (`main@m3`, `vdx@m3-2`; на lft —
`echelon@lft-2`, `gitolite-admin@lft` и другие, по письму). Слова владельца (через nas-info): «давай разберемся как в
cmux слева выводить все сессии tmux … Или вот когда ты стартовал сессию (vdx@m3-intercom) — я бы хотел чтобы она
появилась слева»; выбор пути — «Давай попробуем второй».

**Почему vdx, а не cmux.** Свой сайдбар cmux 0.65.2 не запускает процессов и не читает файлов. Зеркало
`cmux ssh-tmux` (control mode) не показывает заголовков, задваивает вкладки и держит клиента в каждой сессии. Сокет cmux
открыт только процессам его вкладок (`cmuxOnly`), поэтому наблюдатель — процесс во вкладке cmux, как сам `vdx ai`.
Это доводы nas-info из письма; здесь не перепроверены.

**Критерий.** Выпуск, где наблюдатель выполняет пункты 1–7 письма (Next actions). nas-info получает письмо с версией и,
если нужно, строкой для `~/.zshrc`. Приёмка на m3 и lft — за nas-info: сессия `--detach` появилась вкладкой со
значками, открытая не задвоилась, кончилась — вкладка закрылась, сессия intercom закрылась сама.

## Текущая модель

Что есть в коде на 2026-11-26 (дерево на `24585fc`, пакет 0.68.0). Прочитано, не запускалось.

1. **Вкладки cmux, которые знает vdx.** `vdx ai`, держа attach во вкладке cmux, пишет запись
   `~/.local/state/vdx/cmux-tabs/<surface>.json` (`noteTab`, `cli/src/ai.ts`; формат — `TabRecord`,
   `cli/src/tabs.ts:16`): какую сессию показывает вкладка, здесь или на другой машине. По этим записям и по снимку cmux
   `--restore` и `vdx ai --tab` возвращают вкладки после падения (`planTabs` и `returnTabs`, `cli/src/tabs.ts`).
   Новую вкладку restore открывает так: `cmux new-workspace --cwd … --name … --env VDX_TAB_FROM=… --command …`
   (`cli/src/tabs.ts:388`). Флага `--focus false` там нет.
2. **«Сессию уже показывают».** `planTabs` считает сессию показанной, когда у неё есть клиент tmux
   (`clients(target) > 0 ? 'shown'`). Выбор `vdx ai` смотрит на место: `openAt` — места клиентов сессии
   (`clientSeat`, `cli/src/ai.ts`). Место — метка `VDX_AI_SEAT` в окружении клиента, её ставит `vdx ai` при attach,
   иначе `ssh:<адрес>` или эта машина. Отдельной метки «клиент наблюдателя» нет: обычный `tmux attach` из вкладки
   наблюдателя выбор посчитает открытой у этого места вкладкой (п. 5 письма).
3. **`@vdx_stays`.** Ставит `markSessionStays` (`cli/src/ai.ts:1215`): интерактивный запуск или attach без `--detach`.
   `vdx ai --close` такую сессию intercom не закрывает, предел сессий на машину её не считает, будят её как сессию,
   за которой сидит человек. Если наблюдатель подключится через `vdx ai`, метка встанет; если голым
   `tmux attach -t '=<сессия>'`, не встанет (п. 4 письма).
4. **cmux из vdx.** `cmuxCli` (`CMUX_BUNDLED_CLI_PATH` либо `cmux`), `runCmux`, `surface.report_pwd`
   (`reportTabDirectory`) и описание workspace по теме (`watchTopic`, `bin/vdx-cmux-topic.cjs`). Всё это вызывается
   только из процесса во вкладке cmux.
5. **Машины.** Список машин даёт `session.machines` профиля (`cli/src/ai.ts:417`). Сессии другой машины vdx уже
   читает по ssh для списка `vdx ai`.

Чего нет: процесса, который живёт во вкладке cmux, следит за списком сессий tmux обеих машин и открывает или закрывает
вкладки.

## Decision Log

### #1 / 2026-11-26 / Отдельный кристалл в `ready`

**Source:** assistant
**Basis:** observed
**Basis-detail:** `grep` по `docs/tasks/*/workitem.md` на 2026-11-26: побегов про наблюдатель сессий tmux нет. Есть
наблюдатель темы (focused-topic DL #6) и restore (`restore-after-any-crash`), но это другие задачи. Хук старта — 6
активных кристаллов при singleton 1. Прецеденты — `focused-topic-hook-budget` и `vdx-ai-list-owner-findings`
(`ready`, заведены сессиями intercom).
**Context:** письмо можно было разложить побегами в `restore-after-any-crash` (вкладки cmux, `--tab`) или в
`vdx-ai-predictable` (выбор и `openAt`).
**Why:** у письма одна цель и один итог отправителю. Новый каталог не трогает файлы с чужими незакоммиченными
правками. Статус `ready` не занимает место активного.
**Implication:** основная сессия берёт кристалл в работу (`in-progress`) или переносит пункты в другой кристалл.

## Sidetracks

### #1. Запуск наблюдателя — ключ vdx или строка в `~/.zshrc`

**Возникло в:** Назначение; п. 7 письма.
**Описание:** наблюдатель должен жить во вкладке cmux и пережить перезапуск cmux. Варианты: своя вкладка, которую
поднимает строка в `~/.zshrc` (блок ставит модуль nas-info `ansible/modules/vdx.sh`, как `vdx-tab`), или работа внутри
уже идущего `vdx ai --tab`. nas-info просит назвать строку, если она нужна.

**Status:** open

### #2. Вкладка, закрытая руками

**Возникло в:** п. 6 письма.
**Описание:** чтобы не открыть её снова сразу, наблюдатель должен помнить, что вкладку закрыли, а не что сессия
кончилась. Где хранить: файл в `~/.local/state/vdx/` рядом с `cmux-tabs/` или опция tmux на сессии. И до какого
события помнить: до нового старта сессии или до перезапуска cmux.

**Status:** open

## Next actions

- [ ] П. 1 — каждая сессия tmux машин `session.machines`, которую не показывает ни одна вкладка cmux, получает свою
      вкладку без фокуса (`cmux new-workspace … --focus false`). Сначала начатые без терминала (intercom `--detach`,
      HQ-шаги `--focused --detach`, `--restore`). По письму — и сессии без агента (`main@m3`): спросить владельца,
      если основная сессия считает иначе
- [ ] П. 2 — вкладка делает обычный `tmux attach -t '=<сессия>'`, для lft — через ssh, как `vdx ai@lft --attach`. Не
      control mode, иначе до cmux не дойдёт заголовок `set-titles-string`
- [ ] П. 3 — сессия кончилась: её вкладка закрывается, шелл не остаётся
- [ ] П. 4 — вкладка наблюдателя не ставит `@vdx_stays` (Текущая модель, п. 3)
- [ ] П. 5 — решить, как вкладка наблюдателя влияет на «открыта у твоего места» в выборе `vdx ai` (`openAt`,
      `clientSeat`). nas-info предлагает отличать её от вкладки человека, например своей меткой места
- [ ] П. 6 — вкладку, которую человек закрыл руками, наблюдатель сразу не открывает (Sidetrack #2)
- [ ] П. 7 — не задваивать вкладки, которые после перезапуска cmux возвращают `--restore` и `--tab`; наблюдатель сам
      переживает перезапуск cmux (Sidetrack #1)
- [ ] Итог nas-info — `send nas-info … --reply-to vdx/cmux-sidebar-all-tmux-sessions`: версия с наблюдателем и строка
      для `~/.zshrc`, если она нужна (первый ответ ушёл 2026-11-26, `cmux-sidebar-all-tmux-sessions-outcome`); дальше мяч
      у nas-info: приёмка на m3 и lft и строка в `docs/features/shared-terminal.md`. when: выпуск с пунктами 1–7

## References

- Письмо nas-info `cmux-sidebar-all-tmux-sessions` — хранилище intercom, `vdx/_done/` после разбора (2026-11-26).
  Пересказано выше, не скопировано: это чужой текст, а всё, что нужно для работы, — в Назначении и Next actions.
  У nas-info решение записано в кристалле `shared-terminal-cmux`, DL #28.
- `nas-info/docs/features/shared-terminal.md`, раздел «Сайдбар cmux» — что cmux видит из tmux (заголовки, значки).
- [[restore-after-any-crash/workitem|restore-after-any-crash]] — записи вкладок, `--restore`, `--tab`, `new-workspace`
- [[focused-topic/workitem|focused-topic]] — наблюдатель темы `bin/vdx-cmux-topic.cjs`, сокет cmux только из вкладки
- [[intercom-session-mode/workitem|intercom-session-mode]] — `@vdx_stays`, предел сессий на машину
- [[vdx-ai-predictable/workitem|vdx-ai-predictable]] — места клиентов (`openAt`, `clientSeat`), выбор `vdx ai`
