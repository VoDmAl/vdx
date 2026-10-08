# Страж echelon — в конфиг git пользователя

**Что меняется.** Git 2.54 берёт хуки из конфига: ключи `hook.<имя>.event` и
`hook.<имя>.command` в `~/.gitconfig` идут вместе с хуком репо (`.git/hooks/`
или `core.hooksPath`), падение любого останавливает коммит. Владелец решил
перенести туда личные хуки — гейт vdm и страж echelon: один ключ на машину
вместо строки в каждом репо, и фреймворку репо стирать нечего — в telegram путь
машины уходит из `extra.hooks`. Ключи будет писать `vdx doctor --fix` из
профиля владельца, doctor — проверять, что они видны:

```ini
[hook "echelon-guard"]
	event = pre-commit
	command = \"$HOME/AI Projects/echelon/plugin/scripts/check-raw-staged.sh\"
```

**Что я проверил** (lft, git 2.54.0, `git hook run` в scratch-репо, 2026-10-07):

- `command` идёт через shell: переменные и кавычки раскрываются, код выхода
  скрипта — код хука.
- Локальный `hook.echelon-guard.command` в `.git/config` переопределяет
  глобальный; `hook.echelon-guard.enabled=false` выключает.
- `git hook list pre-commit --show-scope` печатает `global	echelon-guard`, и
  после локальной замены команды тоже: scope — где объявлен хук, не команда.
- Apple git 2.50.1 ключи пропускает молча и `git hook list` не знает.
- Настоящий `git commit` не проверял; `git-hook.adoc` 2.54 говорит, что
  `git commit` их запускает.

**Вопросы:**

1. **Где действует.** Ключ в `~/.gitconfig` — для каждого репо машины, не
   только для `consumers.yaml`. В роли `consumer` страж закроет `.env`,
   `.env.*`, `*.session` и там, где их держат в git осознанно (у t23b — шесть
   путей `--allow`). Годится ли так — или ограничить, и чем?
2. **Как `check` и `admit` узнают страж.** `gitcheck.guard_wired` ищет строку в
   файле pre-commit; страж из конфига в нём не виден, и `check` откажет писать.
   Что ему смотреть — `git hook list pre-commit` (git ≥ 2.54 там, где идёт
   `check`)?
3. **Исключения.** В echelon — `--role echelon`, в t23b — шесть `--allow`.
   Их держит локальный `hook.echelon-guard.command` в `.git/config` этих репо.
   Кто его пишет — `admit` / `check` или профиль владельца?

**Когда уходят старые строки** — в `.git/hooks/pre-commit` семи репо и в
`extra.hooks` telegram: когда в этом репо `git hook list pre-commit
--show-scope` и на m3, и на lft показывает `global	echelon-guard`. До этого
идут обе копии — страж отработает дважды, вреда нет. На m3 сейчас только Apple
git 2.50.1; git ≥ 2.54 на обеих станциях я попросил у nas-info (письмо
`git-2-54-everywhere`).

Ответьте по 1–3 — под ответ пишу страж в профиль и проверку doctor.
