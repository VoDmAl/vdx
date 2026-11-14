---
title: "vdx push, который ждёт ветку другой машины"
slug: vdx-push-waits
description: "Коммит из папки Syncthing не ложится на старую вершину: хук echelon в профиле, команда с ожиданием — по слову владельца"
status: in-progress
session-type: prd-prep
created: 2026-11-13
last-updated: 2026-11-13
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
   `echelon guard wait --repo <корень>` (код 0 — можно, 1 — не доехало). Как назвать и устроить — решает vdx.
   Слова владельца 2026-11-08 в HQ echelon: «никто не мешает делать vdx push который будет ждать, т.е. не факт что
   это хук должен быть вообще».

## Текущая модель

- Хук стоит в профиле: сет `vdx-rubric-vodmal` v1.15.1 (`071b864`, 2026-11-13), запись `echelon-ref-race`, команда
  `[ "$1" = preparing ] || exit 0; s="${ECHELON_HOME:-$HOME/AI Projects/echelon}/plugin/scripts/ref-race-guard.sh"; [ -x "$s" ] || exit 0; "$s"`.
  Обёртка echelon: падение echelon — git проходит со строкой, отказ — только код 3, `ECHELON_REF_GUARD=off` — обход,
  Python — только для `refs/heads/*`.
- В `~/.gitconfig` m3 и lft 2026-11-13 стоит форма v1.15.0 (`bin/echelon guard ref` прямо): при падении echelon она
  останавливает любое обновление ссылок на машине. Обход до переписи: `ECHELON_HOME=/nonexistent` перед командой git.
  `vdx doctor` на m3 говорит «its command in ~/.gitconfig differs from the profile»; переписывает nas-info
  `vdx doctor --fix` по брифу echelon.
- Команды с ожиданием нет: владелец 2026-11-13 решил сначала только хук.

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

## Sidetracks

## Next actions

- [ ] Владелец — форма команды, которая ждёт ветку другой машины до коммита (commit + push или push с догоном, имя),
      его слово 2026-11-13 «Ну давай» на «сначала только хук»; срока нет — when: владелец назовёт форму или спросит;
      после — команда в vdx, шаг `echelon guard wait`, итог echelon
- [ ] nas-info — переписать хук на форму v1.15.1 (`vdx doctor --fix` на m3 и lft); бриф им шлёт echelon после итога
      `ref-race-hook-via-wrapper-outcome`; срока нет — when: письмо echelon или nas-info о переписи; check:
      `git config --global --get hook.echelon-ref-race.command` на m3 и `ssh lft …` — в строке `ref-race-guard.sh`

## References

- Письма: `vdx/_done/vdx-push-waits.md`, `vdx/_done/ref-race-hook-via-wrapper.md` (хранилище intercom); итоги —
  `echelon/vdx-push-waits-outcome.md`, `echelon/ref-race-hook-via-wrapper-outcome.md`.
- echelon: `plugin/scripts/ref-race-guard.sh`, `runtime/echelon/refrace.py`, кристалл `cross-machine-session-delivery`.
- Сет: `/Users/vdm/AI Projects/vdx-rubric-vodmal/vdx-environment.yaml`, `git.hooks`.
