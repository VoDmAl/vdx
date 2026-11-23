---
title: "vdx push, который ждёт ветку другой машины"
slug: vdx-push-waits
description: "Коммит из папки Syncthing не ложится на старую вершину: хук echelon в профиле, команда с ожиданием — по слову владельца"
status: in-progress
session-type: prd-prep
created: 2026-11-13
last-updated: 2026-11-22
---

# vdx push, который ждёт ветку другой машины

> Из письма echelon `vdx-push-waits` (2026-11-08) и его продолжения `ref-race-hook-via-wrapper` (2026-11-13).

## Назначение

**Боль.** `.git` проектов возит Syncthing между m3 и lft. Коммит, собранный на вершине, которая на другой машине уже
ушла вперёд и сюда не доехала, выпадает: 05.11–06.11 так выпали четыре коммита, один возврат сам стал гонкой
(echelon, кристалл `cross-machine-session-delivery`, DL #4, #6, #8).

**Две просьбы echelon.**
1. Хук `reference-transaction` в профиле (`git.hooks`): обновление ссылки отказывает, пока ветка другой машины впереди.
   Ловит всё мимо строки коммита: коммит из терминала, `merge`, `update-ref`.
2. Команда владельца commit + push, которая до `git commit` ждёт до 60 с, пока вершина доедет: шаг
   `echelon guard wait --repo <корень>` (код 0 — можно, 1 — не доехало; с echelon `74f5cb1` отказ — 3, как у
   `guard ref`, письмо `commit-wait-guard-ready`). Как назвать и устроить — решает vdx.
   Слова владельца 2026-11-08 в HQ echelon: «никто не мешает делать vdx push который будет ждать, т.е. не факт что
   это хук должен быть вообще».

## Текущая модель

- Хук стоит в профиле: сет `vdx-rubric-vodmal` v1.15.1 (`071b864`, 2026-11-13), запись `echelon-ref-race`, команда
  `[ "$1" = preparing ] || exit 0; s="${ECHELON_HOME:-$HOME/AI Projects/echelon}/plugin/scripts/ref-race-guard.sh"; [ -x "$s" ] || exit 0; "$s"`.
  Обёртка echelon: падение echelon — git проходит со строкой, отказ — только код 3, `ECHELON_REF_GUARD=off` — обход,
  Python — только для `refs/heads/*`.
- В `~/.gitconfig` m3 и lft хук `echelon-ref-race` — в форме сета v1.15.1 (проверено 2026-11-14; до того стояла
  v1.15.0, `bin/echelon guard ref` прямо).
- Ожидание — шаг строки git-guard на событии `pre-commit-line` (DL #2). Строка ставит шаг с vdm-git 2.27.0 (16.11),
  только когда `git hook list --allow-unknown-hook-name pre-commit-line` отвечает 0; событие в профиле принимает vdx
  0.58+ (на станциях с 2026-11-15). Обёртка echelon — `plugin/scripts/commit-wait-guard.sh` (echelon `74f5cb1`,
  письмо `commit-wait-guard-ready`, 2026-11-21): аргументов не ждёт, репо — `git rev-parse --show-toplevel`; 0 —
  коммитить (ветка другой машины та же или доехала за 60 с, машина молчит по ssh, репо не в Syncthing); 3 — строка
  стоит (не доехала за 60 с или копия конфликта ветки в `.git`, причину печатает сама); падение echelon — строка
  «echelon-commit-wait: ожидание упало (код N)» и 0; обход — `ECHELON_REF_GUARD=off`, общий с хуком веток. Запись —
  сет v1.18.0 (`7a65b97`), `echelon-commit-wait` (2026-11-21); в `~/.gitconfig` m3 и lft — через `vdx doctor --fix` (2026-11-21):
  значение в кавычках целиком, `--get` печатает строку до конца, `git hook list --allow-unknown-hook-name
  pre-commit-line` — 0 и имя хука; контроль `git hook run … pre-commit-line` в песочнице: подменный echelon с кодом 3 —
  3, `ECHELON_HOME=/nonexistent` — 0, настоящий в репо вне Syncthing — 0 (lft печатает «Syncthing не сказал, везёт ли
  он .git этого репо», m3 молчит — до echelon `e6b1a58`: PATH ssh без `~/.local/bin`). Строка git-guard, подготовленная после записи, ставит шаг ожидания.

## Decision Log

### #1 / 2026-11-13 / Хук — через обёртку echelon, состояние дописывает git; команда с ожиданием — после слова владельца

**Source:** user
**Basis:** user-stated
**Basis-detail:** на предложение в чате 2026-11-13 «сегодня только хук; команду commit + push с ожиданием — после
твоего слова о её форме: это первая команда vdx, которая сама делает коммит» владелец ответил: «Ну давай». Замеры
того дня: git 2.56 сам дописывает `"$@"` к команде хука из конфига (песочница, `update-ref`: `one=preparing n=1`);
`echelon guard ref preparing preparing` — argparse, код 2; форма через обёртку на подменном echelon: падение → git 0,
отказ (3) → 128, отказ при `ECHELON_REF_GUARD=off` → 0, echelon нет → 0, только тег → 0; форма v1.15.0 при падении →
128. Стоимость: `guard ref preparing` — около 0,28 с вне репозиториев echelon, около 1,1 с в синхронизируемом.
**Context:** письмо echelon дало строку `guard ref "$1"` и прямой вызов `bin/echelon`.
**Why:** `"$1"` удвоил бы аргумент, а отказ argparse в `preparing` остановил бы git на всей машине (v1.15.0 это
исправил). Прямой вызов `bin/echelon` роняет git при любой ошибке echelon (письмо `ref-race-hook-via-wrapper`) —
v1.15.1. Хук уже не даёт коммиту лечь на старую вершину; команда с ожиданием превращает отказ в ожидание, и её форму
(commit + push или push с догоном, имя) решает владелец.
**Implication:** сеты v1.15.0 (`49c03ff`) и v1.15.1 (`071b864`), зеркало в `docs/specs/vdx-environment.example.yaml`,
`DEFAULT_BASELINE` — v1.15.1. Итоги echelon: `vdx-push-waits-outcome`, `ref-race-hook-via-wrapper-outcome`.

### #2 / 2026-11-14 / Ожидание — шаг строки git-guard перед `git commit`; что в нём, решает профиль (`pre-commit-line`)

**Source:** user
**Basis:** user-stated
**Basis-detail:** на вопрос в чате 2026-11-14 (А — один хук и замер, Б — ожидание в строке коммита git-guard,
В — своя команда vdx, которая коммитит) владелец: «Да давай не будем замерять а сделаем уже»; Б был назван
следующим по разумности после А. Замеры того дня: `git hook run --allow-unknown-hook-name --ignore-missing <своё
событие>` запускает хук из конфига (git 2.56 m3, 2.54 lft), код хука — как есть (3 → 3), без хука — 0, без флага —
отказ «unknown hook event» (код 1); хук идёт в корне репо. ai-dev-plugins — кристалл `git-guard-line-wait-step`
(ready с 2026-11-08, кода нет; Sidetrack #2 «откуда плагин берёт команду echelon» открыт), письма echelon
`commit-line-wait-step`, `commit-line-wait-step-whole-index` (порядок: wait → сверка дерева → commit).
**Context:** `vdx push` ждать не может: push идёт после коммита, а гонка — в момент коммита (хук `echelon-ref-race`
отказывает там же). Ожидание есть одно — `echelon guard wait` (до 60 с, переписывает записи индекса чужих путей).
**Why:** строку собирает git-guard, и шаг у них уже принят; vdx своей команды коммита не заводит (В) — меньше своего
кода. Чтобы плагин не знал об echelon, шаг строки общий — `git hook run --allow-unknown-hook-name --ignore-missing
pre-commit-line`, а что на нём, назначает личный профиль (`git.hooks`), как прочие хуки владельца; машина без записи
проходит шаг молча. Падение echelon не должно ронять строку — нужна обёртка echelon, как `ref-race-guard.sh`.
**Implication:** vdx — событие `pre-commit-line` в `git.hooks` (сейчас `GIT_HOOK_EVENTS` его отвергает), запись
сета с ожиданием echelon, `vdx doctor --fix` на станциях. Бриф ai-dev-plugins — механизм для их Sidetrack #2,
имя события; бриф echelon — обёртка с пропуском при падении. Имя события — предложение vdx, решают git-guard.

## Sidetracks

## Next actions

- [x] Запись сета `vdx-rubric-vodmal` (minor): хук на `pre-commit-line` с обёрткой echelon, зеркало,
      `DEFAULT_BASELINE`; `vdx doctor --fix` на m3 и lft; итоги echelon и ai-dev-plugins — when: письмо echelon с путём
      `commit-wait-wrapper.sh` и кодом «не доехало» (их основная сессия, срока нет); check: `/vdm:intercom check`.
      На станциях vdx 0.58.0 с 2026-11-15 — событие профиль принимает — 2026-11-21 письмо пришло
      (`commit-wait-guard-ready`, echelon `74f5cb1`; обёртка названа `commit-wait-guard.sh`, отказ — код 3): запись по
      образцу `echelon-ref-race` — `name: echelon-commit-wait`, `event: pre-commit-line`, `command: 's="${ECHELON_HOME:-$HOME/AI Projects/echelon}/plugin/scripts/commit-wait-guard.sh"; [ -x "$s" ] || exit 0; "$s"'`,
      `when_exists: "~/AI Projects/echelon/plugin/scripts/commit-wait-guard.sh"`. В `~/.gitconfig` значение должно стоять
      в кавычках целиком: без них `;` начинает комментарий и хук молча даёт 0 (echelon так ошибся в живом прогоне);
      `vdx doctor --fix` пишет через `git config --global` (`cli/src/personal-hooks.ts`), кавычки ставит git. Check после
      `--fix`: `git config --global --get hook.echelon-commit-wait.command` на m3 и `ssh lft …` печатает строку целиком.
      Работа — основной сессии (коммит и тег сета — строкой владельца). Итоги: echelon — ответ на
      `commit-wait-guard-ready` (они сверят первую строку git-guard: шаг позван, код дошёл); ai-dev-plugins — строка с
      итогом для их живого прогона (их мяч в `commit-line-wait-via-hook-run-shipped`, 16.11) — 2026-11-21: сет v1.18.0
      в рабочем файле (запись, CHANGELOG, версия обоих документов), `vdx doctor --fix` на m3 и lft сделан, check выше
      сошёлся на обеих (Текущая модель); зеркала, `DEFAULT_BASELINE` и `cli/rubric/` — v1.18.0 в рабочем дереве vdx.
      Строка коммита, тега и push сета — у владельца, в ней шаг `pre-commit-line` (первый живой прогон). Осталось:
      коммит сета и тег `v1.18.0` (владелец), коммит vdx с зеркалами, итоги echelon и ai-dev-plugins — after: тег сета
      на GitHub; check: `git -C '<сет>' ls-remote --tags origin v1.18.0` — 2026-11-22: коммит сета `7a65b97`, тег
      `v1.18.0` на GitHub, lft на `7a65b97` (владелец запустил строку в сессии echelon, письмо `set-line-ran`); шаг
      `pre-commit-line` стоял в строке и дал 0 — первый живой прогон. Итоги: echelon `commit-wait-guard-ready-outcome`,
      ai-dev-plugins `commit-line-wait-hook-assigned` (их сессия intercom поднята); зеркала и `DEFAULT_BASELINE` —
      коммит учёта vdx
- [x] echelon — строка «Syncthing не сказал, везёт ли он .git этого репо» на lft в репо вне Syncthing, m3 молчит
      (код 0 на обеих): задумано или выровнять — when: их ответ на `commit-wait-guard-ready-outcome`, срока нет;
      check: `/vdm:intercom check` — 2026-11-22 (`commit-wait-guard-ready-outcome-outcome`): не машина, а PATH — в
      голом ssh на lft нет `~/.local/bin`, `syncthing-caught-up` не находился; та же дыра снимала сверку в репо из
      Syncthing у git из ssh, launchd и GUI. Исправлено у механизма, echelon `e6b1a58` (`refrace.caught_up_cmd()`:
      PATH, иначе `~/.local/bin`). Проверено: на lft `e6b1a58` в HEAD echelon, прогон в свежем репо вне Syncthing —
      0 без строки. Мяч — nobody; живой случай «ветка доехала во время ожидания» — когда случится сам
- [x] ai-dev-plugins — живой прогон шага на своём репо — when: их ответ на `commit-line-wait-hook-assigned`, срока
      нет; check: `/vdm:intercom check` — 2026-11-22 (`commit-line-wait-hook-assigned-outcome`): на m3 21.11 19:25 EST
      `git hook list` — 0 и `echelon-commit-wait`, `git hook run … pre-commit-line` — 0 за 1 с, индекс и HEAD не
      тронуты; путь «ветка доезжает во время ожидания» вживую не прогнан — ждут, пока случится сам; мяч — nobody
- [ ] ai-dev-plugins — Stop-хук git-guard (`--check-handoff`, vdm-git 2.30.0) назвал чужой строку этой же сессии из
      соседнего репо (`vdx-rubric-vodmal`, 21.11): ищет только в репо cwd; предложено искать токен по каталогу сессии —
      when: их ответ на `git-guard-handoff-other-repo`, срока нет; check: `/vdm:intercom check` — 2026-11-22 первый
      ответ (`git-guard-handoff-other-repo-outcome`): пропуск, не замысел; нужен и корень соседнего репо (в `.meta` его
      нет, есть в `sh/<токен>.sh`); кристалл ai-dev-plugins `git-guard-handoff-other-repo` (ready, основная сессия
      владельца), red-тесты. Пока правки нет, совет хука «Run git-guard-prepare again» на такую строку ложный,
      `--supersede` не нужен. Ждём итог с коммитом — when: их письмо, срока нет; check: `/vdm:intercom check`
- [x] Владелец — форма команды, которая ждёт ветку другой машины до коммита (commit + push или push с догоном, имя),
      его слово 2026-11-13 «Ну давай» на «сначала только хук»; срока нет — when: владелец назовёт форму или спросит;
      после — команда в vdx, шаг `echelon guard wait`, итог echelon — 2026-11-14: Б, шаг строки git-guard (DL #2)
- [x] Бриф ai-dev-plugins: шаг `git hook run --allow-unknown-hook-name --ignore-missing pre-commit-line` перед сверкой
      дерева в строке git-guard (их кристалл `git-guard-line-wait-step`, Sidetrack #2), замеры DL #2; ждём их слова
      о механизме и имени события — отправлен 2026-11-14 (`ai-dev-plugins/commit-line-wait-via-hook-run`); check:
      `/vdm:intercom check` — 2026-11-14 ответ (`commit-line-wait-via-hook-run-outcome`): механизм и имя
      `pre-commit-line` берут (их DL #3, Sidetrack #2 закрыт); при подготовке строка спрашивает `git hook list
      --allow-unknown-hook-name pre-commit-line` и ставит шаг только при коде 0 (хука нет — строка прежняя, git старше
      2.54 отсекается тем же); в список попадает и файл `pre-commit-line` в каталоге хуков репо; шаг пишет их основная
      сессия, живой прогон — после нашей записи в `~/.gitconfig`
- [x] Бриф echelon: обёртка шага ожидания с пропуском при падении (как `ref-race-guard.sh`) и код «не доехало»,
      отличный от падения Python (1); ждём путь обёртки — отправлен 2026-11-14 (`echelon/commit-wait-wrapper`); check:
      `/vdm:intercom check` — 2026-11-14 ответ (`commit-wait-wrapper-outcome`): принято, `commit-wait-wrapper.sh` и свой
      код «не доехало» делает их основная сессия (кристалл `cross-machine-session-delivery`), путь и код — письмом vdx,
      срока нет — 2026-11-21: в репо echelon обёртки нет (`git ls-files`, `git log`); владелец: «дай bash focused я
      запущу сейчас» — строка фокус-сессии echelon (тема «обёртка ожидания перед коммитом для vdx», задача и условия — в
      `--prompt`, итог — письмом с `--reply-to vdx/commit-wait-wrapper-outcome`) отдана владельцу; владелец запустил:
      tmux `echelon@m3-2`, тема «обёртка ожидания перед коммитом для vdx» (2026-11-21) — 2026-11-21 итог
      `commit-wait-guard-ready`: обёртка `plugin/scripts/commit-wait-guard.sh` (echelon `74f5cb1`), 16 тестов
      `tests/test_refrace.py`, живой прогон на m3 и lft с временным `.gitconfig`; запись — первый пункт Next actions
- [x] vdx: событие `pre-commit-line` в `git.hooks` (`GIT_HOOK_EVENTS`, `vdx doctor`), тесты, `environment-format.md`;
      сет `vdx-rubric-vodmal` (minor) — запись с обёрткой echelon, зеркало, `DEFAULT_BASELINE`; `vdx doctor --fix` на
      m3 и lft; итоги echelon и ai-dev-plugins — 2026-11-14: событие в рабочем дереве (`LINE_HOOK_EVENTS` в
      `cli/src/ai.ts`; `GIT_HOOK_EVENTS` в `hooks.ts` не тронут — по нему читаются хуки самого репо), тест
      `personal-hooks.test.ts`: `--fix` пишет хук, `git hook run --allow-unknown-hook-name` держит строку его кодом;
      `environment-format.md` (vdx 0.58+). Брифы отправлены: ai-dev-plugins `commit-line-wait-via-hook-run`, echelon
      `commit-wait-wrapper`, их сессии intercom подняты. Осталось: слово ai-dev-plugins об имени, обёртка echelon,
      сет, выпуск CLI (minor, с правкой `--dry-run`), `vdx doctor --fix` на станциях. Имя `pre-commit-line` принято
      ai-dev-plugins 2026-11-14. Порядок: выпуск CLI 0.58 и станции — до записи сета: vdx старше 0.58 отвергнет профиль
      с этим событием (`git.hooks[].event`), а профиль один на обе машины — 2026-11-15: CLI 0.58.0 (`f1c7f41`) в npm,
      m3 и lft — 0.58.0. Осталось: обёртка echelon (их основная сессия), потом запись сета (minor), `vdx doctor --fix`
      на m3 и lft, итоги echelon и ai-dev-plugins (их живой прогон ждёт нашей записи в `~/.gitconfig`) — 2026-11-21:
      обёртка echelon есть (`commit-wait-guard-ready`); осталось то же, что в первом пункте Next actions — 2026-11-22:
      сделано там же (сет v1.18.0 `7a65b97`, станции, итоги)
- [x] nas-info — переписать хук на форму v1.15.1 (`vdx doctor --fix` на m3 и lft); бриф им шлёт echelon после итога
      `ref-race-hook-via-wrapper-outcome`; срока нет — when: письмо echelon или nas-info о переписи; check:
      `git config --global --get hook.echelon-ref-race.command` на m3 и `ssh lft …` — в строке `ref-race-guard.sh` —
      2026-11-14: на m3 и lft в строке `ref-race-guard.sh` (check выше); письма о переписи vdx не получал

## References

- Письма: `vdx/_done/vdx-push-waits.md`, `vdx/_done/ref-race-hook-via-wrapper.md` (хранилище intercom); итоги —
  `echelon/vdx-push-waits-outcome.md`, `echelon/ref-race-hook-via-wrapper-outcome.md`.
- echelon: `plugin/scripts/ref-race-guard.sh`, `runtime/echelon/refrace.py`, кристалл `cross-machine-session-delivery`.
- Сет: `/Users/vdm/AI Projects/vdx-rubric-vodmal/vdx-environment.yaml`, `git.hooks`.
