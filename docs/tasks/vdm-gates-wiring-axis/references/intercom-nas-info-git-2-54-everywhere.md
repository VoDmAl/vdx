# git ≥ 2.54 у всех, кто коммитит на m3 и lft

**Зачем.** Личные хуки владельца — гейт vdm и страж echelon — переезжают из
каждого репо в конфиг git пользователя: ключи `hook.<имя>.event` и
`hook.<имя>.command` в `~/.gitconfig` (Git 2.54, RelNotes: «Hook commands are
now allowed to be defined (possibly centrally) in the configuration files»).
Git старше 2.54 такие ключи молча пропускает: коммит проходит без стража и без
единого предупреждения.

**Что я видел (2026-10-07, только чтение):**

- m3: brew-git нет. `git` везде — `/usr/bin/git` 2.50.1 (Apple Git-155). В ssh
  без терминала PATH — `…/fnm/…:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:…`,
  `/usr/bin` раньше `/opt/homebrew/bin`; в `zsh -lic` — тоже `/usr/bin/git`.
  Поставить brew-git мало: его заслонит Apple.
- lft: в терминале `/usr/local/bin/git` 2.54.0 (brew). Но PATH launchd
  пользователя — `/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:…`
  (`launchctl print gui/501`): задачи launchd и приложения, запущенные не из
  терминала, берут Apple git 2.50.1.
- `ensure_package git` (`PACKAGES_BASE="git curl"`) на macOS довольствуется
  `command -v git`: Apple git проходит, версия не смотрится.

**Просьба.** На обеих станциях git ≥ 2.54 — тот, что находит `git` везде,
откуда может прийти коммит: терминал, ssh без терминала, Bash агента, задачи
launchd и приложения вне терминала. Как — решать вам: пол версии в установке
пакетов, порядок PATH, PATH launchd; и нужен ли бейдж на версию.

**Приёмка.** На m3 и lft `ssh -o BatchMode=yes <станция> 'git --version'` и
`git --version` в терминале — 2.54 или новее; задача launchd с
`git --version` печатает то же.

Ответьте, когда будет, — проверю `git hook list pre-commit --show-scope` на
обеих станциях и переведу гейт vdm на конфиг.

**Попутно (не просьба):** ключи `hook.*` в `~/.gitconfig` будет писать
`vdx doctor --fix` из профиля владельца. В `GIT_GLOBAL_SETTINGS` и
`GIT_GLOBAL_FORBIDDEN` их нет, `f:git` они не задевают — пишу, чтобы новый
автор `~/.gitconfig` не оказался неизвестным.
