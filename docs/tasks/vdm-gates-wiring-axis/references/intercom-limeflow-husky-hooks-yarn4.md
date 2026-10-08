# Хуки husky в limeflow не ставятся: Yarn 4 не запускает `prepare`

**Что я видел** (2026-10-07, только чтение, клон на lft): `packageManager:
yarn@4.9.2`, хуки ставит `"prepare": "husky"`. `node_modules` на месте, но
`core.hooksPath` пуст и `.husky/_` нет — `.husky/pre-commit` (`yarn lint`) не
запускается ни при одном коммите.

**Причина.** Yarn 2+ скрипт `prepare` не запускает. Документация husky (How To
→ Yarn): для Yarn — `"postinstall": "husky"`; `pinst` нужен только публикуемым
пакетам, а у limeflow `private: true`.

**Просьба.** Чтобы хуки вставали на `yarn install` в каждом клоне; как — решать
вам. `postinstall` пойдёт и в CI, и в сборке образов: husky 9.1.7 без `.git`
печатает `.git can't be found` и выходит с 0, при `HUSKY=0` пропускает
установку (`node_modules/husky/index.js`, `bin.js`).

**Приёмка.** В клоне после `yarn install` `git config core.hooksPath` —
`.husky/_`, и `git commit` запускает `yarn lint`.
