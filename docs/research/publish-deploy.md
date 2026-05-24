# Research: publish / release / deploy в vdx (D12)

**Статус**: ✅ закрыто как **D12** 2026-05-24 (см. `docs/decisions.md` →
Decided section).
**Контекст**: vdx сейчас имеет 6-словарный lifecycle (D7: up/down/build/test/check/fix).
Пользователь предложил добавить `publish`/`deploy`. Research-first
подход выявил детали — D12 принято на основе этого документа.

---

## Цель этого документа

Дать достаточно фактов, чтобы выбрать между четырьмя архитектурными
опциями (см. секцию Decision options) и принять D12.

Параллельно протестировать гипотезу: **рубрика как gate для исполнения**.
Сейчас рубрика только описывает состояние; если `vdx publish` отказывает
выполнить операцию когда `release-artifact < L3`, рубрика становится
исполняемой — новый use case, оправдывающий её ценность.

---

## Семантика — три глагола, не один

Критическое различение, которое research должен подтвердить или опровергнуть:

| Глагол | Что делает | Артефакт-цель | Idempotency |
|--------|------------|----------------|-------------|
| **publish** | Ship версионированный артефакт в registry | npm / PyPI / Packagist / Cargo / GHCR | Один раз на версию (immutable) |
| **release** | Orchestrate: version bump → CHANGELOG → git tag → publish → GitHub release | Версия + tag + release notes | Один раз на bump |
| **deploy** | Push код в running environment (staging/prod) | k8s cluster / vercel / fly.io / SSH host | Множественно (mutable state) |

**Тезис для проверки**: `publish` нужен для libs, `deploy` для apps, `release`
— orchestrator над `publish` (а иногда и над `deploy`). Эти границы тонкие:
например, CLI-инструмент (vdx сам) одновременно lib (npm publish) и
candidate для deploy (Docker image на ghcr).

См. ось `release-artifact` с `applies_when` (Шаг S/O35) — она уже различает
lib vs app для PHP/Node. Этот сигнал переиспользуем.

---

## Landscape

> **TBD** — заполняется после возврата трёх research-агентов
> (node-release-research, php-python-release-research,
> deploy-orchestrators-research).

### Node.js ecosystem

Шесть инструментов, все сходятся на одном canonical pipeline:

```
pre-flight checks → version bump → changelog → git commit+tag → push → npm publish → release notes
```

Различаются по двум осям:

1. **Кто решает bump**: commit conventions (semantic-release), `.changeset/*.md`
   file (changesets), human prompt (release-it, np), никто (raw npm).
2. **Кто триггерит**: CI без человека (semantic-release), CI с curated intent
   (changesets), CI или laptop (release-it), только laptop (np).

| Tool | Bump trigger | Trigger venue | Side effects | Adoption |
|------|--------------|---------------|--------------|----------|
| **semantic-release** | conventional commits | CI only | full pipeline auto | ~2.48M dl/wk, 23.6k★ |
| **release-it** | human prompt or config | laptop or CI | full pipeline, plugin-extensible | ~851k dl/wk, 8.9k★ |
| **changesets** | `.changeset/*.md` PR-time intent | CI (curated) | per-package CHANGELOG + tag | pnpm, Astro, Remix, Prisma, SvelteKit |
| **np** | human prompt | laptop only | bump+commit+tag+push+publish+release draft | sindresorhus universe (~1000 pkgs) |
| **publint** | n/a — static linter | anywhere | none (validates package.json shape) | Vite, Vue, Svelte, Astro |
| **npm publish (raw)** | none | anywhere | uploads tarball, nothing else | универсально (wrapped by all above) |

**Pre-flight checks (recurring across np / release-it / changesets / semantic-release)**:

- Git tree clean (no uncommitted)
- On configured release branch
- Upstream configured + pushed (no orphan local commits)
- Tests pass
- Build artifacts present (`dist/`, types)
- Lockfile fresh (np re-installs from scratch)
- `package.json` valid (publint-style: exports/types/files coherent)
- Auth/credentials available (npm token, GitHub token)
- Version not already published (registry collision)
- No `private: true` unless intentional

→ Все мапятся в существующие/расширяемые оси vdx-рубрики
(release-artifact L≥3, tests L≥2, ci L≥3, git-hygiene, dependency-hygiene).

**Friction points**:

- **Monorepos**: только changesets решает первоклассно; semantic-release plugin stale.
- **Multi-stack**: все Node-only. Multi-stack проект (Node+Python) нужна оркестрация выше.
- **Non-npm destinations**: GHCR, GitHub Releases-as-binary — plugin coverage uneven.
- **Local + CI parity**: np laptop-only, semantic-release CI-only; команды хотят оба пути с identical guarantees.
- **Pre-flight overlap с `check`**: каждый инструмент **повторно** прогоняет tests/lint, дублируя то, что `vdx check` уже сделал.

**Главный finding для vdx D12**: ни один Node-инструмент не делает что-то
*эксклюзивное* — все они композиты из git/npm/changelog/release-notes
операций. **vdx должен оркестрировать выбранный пользователем инструмент**,
а не реализовывать логику самостоятельно. В манифесте проект декларирует
«я использую changesets», и `vdx release` shell'ит в `pnpm changeset publish`.
Уникальный value vdx — единый verb-словарь + rubric-driven gate (отказ запускать
release если ось `release-artifact < L3` или `tests < L2`).

**Рекомендация агента**: два глагола, не один.

- `publish` = leaf — push артефактов в destination (npm/GHCR/GitHub Release).
- `release` = meta-verb — orchestrate: gate (check+test+rubric) → compute version
  via project's choice → CHANGELOG → commit → tag → push → publish → release notes.

Это калька с semantic-release / release-it / changesets split: `release` это
workflow, `publish` это leaf-шаг внутри. См. node-release-research sub-agent.

Sources: semantic-release docs, release-it docs, changesets intro,
np README, publint.dev, npm publish docs.

### PHP ecosystem

**Критическое открытие**: PHP не имеет publish-CLI. Packagist это **pull-based**
registry — он crawl'ит Git on git-tag webhook. Publish-operation для PHP =
`git tag vX.Y.Z && git push --tags`.

- **`composer publish` / `scripts.publish`** — не существует. Composer 2.4+
  имеет `composer bump`, но это для **dependency version constraints**, не
  для self-release. Лайфцикл-хуков `publish` нет.
- **`extra.publish`** в `composer.json` — не конвенция, free-form поле для
  user scripts. Packagist auth через webhooks, не через токены в `composer.json`.
- **php-conventional-changelog** (marcocesarato) — closest analogue to JS
  conventional-changelog. Bumps version, generates CHANGELOG.md, git
  commit+tag. Не публикует сам — публикация = git push --tags.
- **php-semver-checker** (tomzx) — статический analyzer, рекомендует
  MAJOR/MINOR/PATCH. Не пишет tag'и.
- **Phar release flow** (для CLI-tools): box-project/box bundler → attach
  `.phar` к GitHub Releases (на git-tag) → consumers через Phive или
  phar-updater (последний archived).

→ Нет PHP-native tool который покрывает analyze→bump→tag→push как single
command. Workflow собирается из частей.

### Python ecosystem

**Критическое открытие**: Python deliberate decoupling **build vs upload**.
`python -m build` (PEP 517) → `twine upload dist/*` — два шага. Wrappers
(poetry/hatch/flit) комбинируют их.

| Tool | Builds? | Uploads? | Bump? | Tag? | CHANGELOG? |
|------|:--:|:--:|:--:|:--:|:--:|
| `python -m build` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `twine upload` | ✗ | ✓ | ✗ | ✗ | ✗ |
| `twine check` | ✗ | check only | ✗ | ✗ | ✗ |
| `poetry publish` | optional (`--build`) | ✓ | ✗ | ✗ | ✗ |
| `hatch publish` | ✗ (separate `hatch build`) | ✓ | ✗ | ✗ | ✗ |
| `flit publish` | ✓ | ✓ | ✗ | ✗ | ✗ |
| **python-semantic-release** (PSR) | via build-cmd | ✓ | ✓ | ✓ | ✓ |

PSR — единственный full-pipeline инструмент для Python (Conventional Commits
→ bump → CHANGELOG → tag → build → publish → GitHub Release). Build-backend
agnostic: works с setuptools, Poetry, Hatch, PDM, Flit через конфиг
(`version_toml`, `version_variables`).

### Three fundamentally different registry models

| Ecosystem | Model | Publish CLI | Что произошло на git side |
|-----------|-------|------|------|
| Node (npm) | **push, atomic** | `npm publish` (builds tarball + uploads) | nothing needed |
| Python (PyPI) | **push, decoupled** | `python -m build && twine upload` (или wrappers) | nothing needed |
| PHP (Packagist) | **pull, webhook** | **CLI отсутствует** | `git tag && git push --tags` это и есть publish |
| Rust (crates.io) | push, atomic | `cargo publish` (verify+package+upload) | nothing needed |
| Ruby (rubygems) | push, atomic | `gem push *.gem` | nothing needed |
| Go (proxy.golang.org) | **pull, on-demand** | **CLI отсутствует** | `git tag` |
| Java (Maven Central) | push, atomic | `mvn deploy` / `gradle publish` | nothing needed |

→ `npm publish` это outlier как atomic one-shot. **Нельзя проецировать npm-mental
model на другие стеки.**

### Universal pre-flight — только один

Intersection всех ecosystems:

> «version-identifier на HEAD ещё не опубликован, и метаданные парсятся»

Всё остальное (tests-pass, lockfile-fresh, signed, etc.) — stack-specific
конвенции. См. матрицу публичных check'ов в node-release-research.

### Главный finding для D12 (от PHP+Python агента)

**Adopt the "publish verb maps to stack-specific implementation via mise tasks"
model** — тот же паттерн что у `build`/`test` сегодня. Verb униформный,
implementation stack-specific. Sane defaults:

- `package.json` → `npm publish` (или pnpm/yarn по lockfile)
- `pyproject.toml` → detect backend (`tool.poetry` → poetry publish;
  `build-backend = "hatchling.*"` → hatch publish; иначе `build` + `twine`)
- `composer.json` → `git tag <ver> && git push --tags`
- `Cargo.toml` → `cargo publish`
- `*.gemspec` → `gem push *.gem`

Escape hatch: project может переопределить через `[tasks.publish] run = "..."`
в `mise.toml`. Это идеально соответствует D3 (mise as runner) и D4 (manifest
= mise.toml + [vdx] block).

### Идея новой рубричной оси: `release-workflow`

Orthogonal to `lifecycle-interface`. Измеряет **качество** release-процесса
(не наличие самой команды):

- L1: documented release script exists (any `[tasks.publish]` или CI workflow с publish-step)
- L2: + automated changelog (conventional-changelog / changesets / PSR)
- L3: + semver enforcement (semver-checker / commit-conventions)
- L4: + idempotency check + signing/verification (Sigstore / GPG / Trusted Publishing)

Это **дополнение** к `release-artifact` (которая измеряет metadata-readiness),
не замена. Release-artifact = «пакет publish-ready», release-workflow = «процесс
publish'а зрелый».

Sources: Packagist About, Composer scripts.md/schema, marcocesarato/
php-conventional-changelog, box-project/box, Twine docs, Poetry/Hatch/Flit
publish docs, python-semantic-release docs, PyPA Packaging tutorial.

### Cross-stack release orchestrators

| Tool | Role | Stack coverage | Adoption |
|------|------|----------------|----------|
| **release-please** (Google) | bump+CHANGELOG+tag+GH Release — НЕ публикует в registry, эмитит artifacts для downstream | 20+ strategies (Node/Py/Java/Go/Rust/Ruby/PHP/Dart/Terraform/Helm/Bazel) | googleapis/* SDKs, Firebase, gcloud, Bazel |
| **semantic-release** | Полный pipeline, на каждом push, hands-off | Node-centric (Python через PSR — отдельный fork) | Angular, ~2.48M dl/wk |
| **conventional-commits** | **Спека, не tool** — substrate под всё выше | universal | de facto industry standard |
| **commit-and-tag-version** | Pure-local bump+CHANGELOG+commit+tag (без push, без publish) | Node-ориентирован | minimal/offline workflows |
| **goreleaser** | build cross-platform binaries → archive → checksum → sign → GH Release → Homebrew/Scoop/Winget/AUR/Nix tap → Docker multi-arch push. **Most ambitious "do-everything"** | Go, Rust, Zig, TS (Py planned) | traefik, k6, terraform-providers, charmbracelet |
| **cargo-release** | Workspace-aware bump+tag+push+`cargo publish` (без changelog — uses git-cliff) | Rust only | rust ecosystem |
| **gradle-release** | Removes SNAPSHOT+tag+prompt — publish delegate'ится `maven-publish` | JVM | enterprise Java |
| **softprops/action-gh-release** | "Dumb pipe" GH Release publisher — complements release-please/semantic-release | universal | de facto в Actions |
| **release-drafter** | Maintains a *draft* labeling PRs. No bump, no tag — just notes. Lightweight, human-curated | universal | lightweight alternative |

**Pattern**: cross-stack tools (release-please/semantic-release) stop **before
build** — делегируют ecosystem publishers (`npm publish`, `twine`, etc.).
Stack-native (goreleaser/cargo-release) делают vertical integration.

### Deploy semantics — 5 target categories

| Category | Tool examples | Mutation model |
|----------|--------------|----------------|
| **K8s push** | `kubectl apply`, `helm install/upgrade` | Imperative push |
| **GitOps pull** | ArgoCD, FluxCD | Pull-based reconcile (deploy = commit YAML) |
| **PaaS push** | vercel deploy, netlify deploy, fly deploy, render deploy, dokku push | One-shot, end-to-end |
| **Container registry push** | docker push (GHCR/ECR/GCR) | **Liminal**: looks like publish, feeds deploy |
| **SSH/rsync legacy** | rsync, Capistrano, Deployer | Push files + restart |

### Publish vs Deploy — rollback asymmetry (**критический split**)

|                | publish | deploy |
|----------------|---------|--------|
| Target | registry (immutable) | environment (mutable state) |
| Idempotency | on artifact | on env state |
| Frequency | once per version | N times per version × M envs |
| **Rollback** | **impossible/painful** (npm unpublish 72h rules; PyPI yank-metadata only) | **first-class** (`kubectl rollout undo`, `helm rollback`, GitOps revert) |
| Audience | downstream consumers | end users of running app |

**Главный structural finding**: rollback asymmetry — единый аргумент против
объединения publish+deploy в один verb. Publish — one-way ratchet (version
coordinate занят forever). Deploy — reversible state transition. Verb
который скрывает эту разницу прячет риск.

### App lifecycle vs lib lifecycle

- **Library**: build → test → **publish** to registry. Stop.
- **App**: build → test → containerize → push image → **deploy** to env.
- **Hybrid (CLI tool)**: vdx сам — npm lib И potential Docker app. Same
  artifact, оба verb apply в разное время.

→ Это переиспользует наш `applies_when` (Шаг S/O35): lib vs app detection
уже сделан для `release-artifact` оси.

### Pre-flight overlap ~70%

Общие gates publish и deploy:
- tests green
- build artifact reproducible
- lockfile clean
- target reachable
- secrets present
- version doesn't already exist (publish) / target env exists (deploy)
- git tag matches artifact version
- CHANGELOG updated

→ Это argues за **shared pre-release-check rubric ось**, не за два дубликата.

### Cross-stack agent рекомендация: option (B)

**Add `publish` as 7th verb now (lib-gated via applies_when). Defer
`deploy` until vdx ships a deployment-rubric axis. Reject `release` as
meta-verb.**

Логика:
- **Не (A)**: каждый проект импровизирует `publish:npm` / `deploy:prod` /
  `release:tag` — vdx pitch "AI agent не переучивается на каждый проект"
  ломается именно на release-границе.
- **Не (D)**: `release` conflate'ит две оси (release-artifact vs deploy)
  которые должны score independently. Плюс noun-collision: GitHub
  Release / semantic-release / Helm Release.
- **Не (C)**: deploy имеет 5+ wildly different categories. Risk: ship
  `vdx deploy` который работает только для одной → break contract при
  расширении.
- **Да (B)**: publish имеет **uniform semantics** (lib → registry — every
  ecosystem has one canonical place). `applies_when: lib intent` уже
  готов. Rubric coupling (`release-artifact`) уже существует.

### Архитектурный risk D12 и mitigation

D7 fix vocabulary at 6 verbs — bet "consistency > coverage". Добавление
verb стоит: каждый existing manifest, plugin, doc-page "vdx supports 6
verbs" нужна правка.

**Mitigation**: D12 specifies extension protocol:
- vocabulary additions = minor `schema_version` bump (no removals)
- new verbs ship `applies_when` defaults → existing проекты (где verb не
  применим) see zero change
- backward-compat: старые manifests без `publish` continue работать

Cost bounded. Benefit (covering the most-agent-confusing boundary) high.

Sources: release-please docs, semantic-release docs, softprops/
action-gh-release, conventional-commits spec, commit-and-tag-version,
goreleaser, cargo-release, gradle-release, ArgoCD/Flux comparisons.

---

## Stack matrix (предварительно, до landscape)

| Stack | Native publish CLI? | Build pre-step | Версионирование | Side-channel |
|-------|--:|---|---|---|
| Node | `npm publish` (+ pnpm/yarn) | optional (tsc, esbuild) | package.json `version` | npm registry |
| PHP | **нет** | composer install не нужен | git tag | Packagist webhook (auto from GitHub) |
| Python | `twine upload` (+ poetry/hatch publish) | `python -m build` (PEP 517) | pyproject.toml `[project].version` | PyPI |
| Go | **нет** (git tag триггерит) | go mod tidy | git tag | proxy.golang.org |
| Ruby | `gem push` | `gem build` | gemspec | rubygems.org |
| Rust | `cargo publish` | cargo build | Cargo.toml | crates.io |
| Java | `mvn deploy` / `gradle publish` | mvn/gradle build | pom.xml/build.gradle | Maven Central / Sonatype |

**Observation (TBD-confirm via research)**: PHP и Go не имеют publish-CLI.
Они полагаются на git-tag + downstream-сервис. Это меняет семантику —
`vdx publish` для PHP это `git tag vN && git push --tags`, не shell command
на registry.

---

## Pre-flight gating через рубрику

Предположение для проверки: если `vdx publish` — реальная команда, она
должна проверять состояние **до** запуска.

| Условие | Mapping в рубрику | Действие при недостаточности |
|---------|-------------------|------------------------------|
| Метаданные пакета | `release-artifact ≥ L2` | hard fail |
| Entry points / lockfile | `release-artifact ≥ L3` | hard fail |
| Тесты есть и проходят | `tests ≥ L2` + `npm test` exit 0 | hard fail |
| CI зелёная на HEAD | `ci ≥ L3` + GitHub status check | warn (или fail с `--strict`) |
| Working tree clean | (отдельный pre-flight, не из рубрики) | hard fail без `--force` |
| Version bumped vs HEAD~1 | (отдельный pre-flight) | warn если remote-version == new-version |

Это **новый use case рубрики**: не просто измерение, а проверка готовности
к операции. Сейчас рубрика info-only; с pre-flight она становится
**executable contract**. Возможно — это даёт vdx уникальную ценность
относительно стандартного release-please или semantic-release.

---

## Side effects publish/release

Что должно атомарно сопровождать publish:

1. **Git tag** `vN.N.N` локально → push origin/tags.
2. **CHANGELOG.md** update (если в проекте есть conventional-commits).
3. **GitHub Release** (notes из commits since last tag).
4. **Webhook** в notification channel (Slack/email) — best-effort.
5. **package.json version sync** перед publish (или после? semver-release делает после bump+tag).

vdx не должен **реализовывать** все эти эффекты — он должен **оркестрировать**
существующие инструменты (changesets / semantic-release / git native).
Принцип "комбайн, не монолит" из CLAUDE.md.

---

## Decision options для D12

Четыре варианта (один будет выбран как D12 после landscape ревью):

### (A) Не расширять словарь — статус-кво
vdx остаётся на 6 глаголах. `publish`/`deploy` делается через mise tasks
per project. vdx может оптом сгенерировать `[tasks.publish]` в `vdx init`
для lib-проектов (как (C) ниже), но не объявляет publish частью словаря.

- **Плюсы**: ноль архитектурных изменений; mise уже умеет таски.
- **Минусы**: пользователь сам пишет publish-логику в каждом проекте,
  нет нормализации между стеками.

### (B) Добавить `publish` как 7-й глагол
Расширяем D7. `publish` имеет stack-specific mapping (как `up` сейчас).
`applies_when` гейтинг: применим только если оси `release-artifact`
applies_when='lib intent' возвращает true (переиспользуем S/O35 sigals).

- **Плюсы**: единый `mise run publish` через все стеки.
- **Минусы**: нужна формальная семантика для каждого стека
  (PHP = git tag, Node = npm publish, Python = python -m build + twine).

### (C) Добавить `publish` + `deploy` как 7-й и 8-й глаголы
Как (B), плюс отдельный `deploy` с applies_when='app intent' (private:true,
есть Dockerfile/docker-compose/vercel.json/render.yaml).

- **Плюсы**: полная нормализация lib и app release lifecycle.
- **Минусы**: deploy-семантика *очень* разнородная (k8s vs PaaS vs SSH);
  возможно `mise run deploy` это leaky abstraction.

### (D) Добавить `release` как meta-verb
`release` orchestrate'ит: bump + CHANGELOG + tag + publish + GitHub release.
Это композиция, а не атомарный шаг. `publish` остаётся sub-шагом внутри.
`deploy` — отдельная история, не покрывается этим решением.

- **Плюсы**: matches semantic-release / release-please mental model.
- **Минусы**: высокая сложность реализации; conventional-commits становится
  hard dependency.

---

## Open questions

- **OQ1** — Применяется ли `vdx publish` для PHP, если у PHP нет native
  publish CLI? Или PHP publish это `git tag + push --tags` и наш Composer
  manifest auto-resolves через Packagist webhook?
- **OQ2** — `vdx publish` должен ли подразумевать version bump, или это
  отдельная команда `vdx bump <patch|minor|major>`? semantic-release делает
  атомарно; release-it разделяет.
- **OQ3** — Связь с `release-artifact` ось — это **describing** или **gating**?
  Если gating: что произойдёт если ось suppressed в `.vdx-overrides.yml`?
- **OQ4** — Deploy vs Publish — это **один** новый глагол или **два**?
  Большая часть инструментов их различает (semantic-release publish vs
  ArgoCD deploy).
- **OQ5** — Conventional-commits как dependency — vdx должен ли требовать
  conventional-commits для авто-bump, или это opt-in?
- **OQ6** — Что делать с monorepo'ами (один package.json в root + multiple
  publishable subpackages)? changesets решает это; semantic-release с
  semantic-release-monorepo тоже.
- **OQ7** — `vdx publish --dry-run` должен делать `npm pack --dry-run`
  + `vdx audit --release-readiness`? Это становится главная проверка
  перед публикацией.

---

## Связь с уже существующими решениями vdx

- **D3 (mise как раннер)** — vdx добавляет verb-словарь, не выполняет
  команды. `vdx publish` → `mise run publish` → stack-specific script.
  Сохраняется принцип "оседлать готовый инструмент".
- **D7 (weighted_two_class scoring)** — добавление верба влияет на
  axes но не scoring. Однако появляется pre-flight gate, который
  использует scoring.
- **D8 (shared-infra качество подхода)** — параллель: publish это
  тоже про "качество подхода", не файл-дрейф. Возможно публиковать
  через GitHub Actions из release-please > чем `npm publish` локально.
  Это тогда становится частью рубрики (publish-method axis?).
- **Шаг S (applies_when)** — переиспользуем для гейтинга:
  `vdx publish` применим только когда `applies_when` для лиц-сигнала true.

---

## Что дальше

1. ✅ Skeleton.
2. ✅ Landscape от трёх параллельных research-агентов (Node, PHP+Python, deploy+orchestrators).
3. ✅ Синтез — см. ниже.
4. ⏳ Ревью пользователя → confirm/contest рекомендации.
5. ⏳ Запись D12 в `docs/decisions.md`.
6. ⏳ После D12: implementation spec в `docs/specs/publish-verb.md`.

---

## 🧩 Синтез — все три агента сходятся

### Convergent findings (все три источника независимо)

1. **vdx должен оркестрировать, не реализовывать.** Все три landscape-исследования
   указали: ecosystem уже имеет full-pipeline tools (semantic-release / changesets /
   release-please / goreleaser / PSR / poetry / hatch). vdx как orchestrator —
   strict следствие принципа "комбайн, не монолит" из CLAUDE.md.

2. **Verb униформный, implementation stack-specific.** Это та же модель что
   `build`/`test`: словарь общий, mise tasks делают per-stack mapping. Sane
   defaults обнаруживаются через manifest detection (package.json → npm publish,
   pyproject.toml → poetry/hatch/build+twine, composer.json → git tag, Cargo.toml
   → cargo publish, *.gemspec → gem push).

3. **`publish` vs `deploy` — это два разных verb'а, не один.** Three rationale
   converge: registry vs environment, immutable vs mutable, **rollback asymmetry**
   (главный structural argument).

4. **Pre-flight gating через рубрику = new vdx value-prop.** Рубрика была
   info-only; с D12 она становится **executable contract** — отказ запустить
   release, если осями зафиксирован gap. Этого нет ни у release-please, ни у
   semantic-release.

5. **Conventional-commits = substrate, не tool.** Линтить опционально в
   `check`-verb (commitlint), не делать core dependency vdx.

### Divergent findings (где агенты расходятся)

| Топик | Node agent | PHP+Python agent | Deploy agent |
|------|-----------|------------------|--------------|
| Сколько verb'ов | 2 (`publish` + `release` meta) | 1 (`publish` с mise tasks impl) | 1 сейчас (`publish`), 1 deferred (`deploy`) |
| `release` как meta-verb | ✓ предлагает | не обсуждает | ✗ rejects (conflate, noun-collision) |
| Идея новой axis | Pre-flight checks как gate | `release-workflow` axis (orthogonal) | shared `pre-release-check` axis |

**Resolution**: deploy-agent's аргумент против `release` как meta-verb сильнее
node-agent's за — noun-collision реальная, conflation оси real. Принять `publish`
+ `deploy` (deferred); если потом понадобится meta-orchestration, добавить
**8-й (или N-й) verb** или внешний tool в `mise.toml`.

### Финальная рекомендация D12 — **option (B+)**

**Принять `publish` как 7-й verb сейчас**. `deploy` отложить до **D13**
(требуется поле-feedback + новая ось `deploy-manifest` для разрезания 5
категорий: k8s / GitOps / PaaS / registry-push / SSH legacy).

**Семантика `vdx publish`**:

```yaml
applies_to:    [node, php, python, ruby, rust, go, java]
applies_when:  # lib intent (reuse O35 signals)
  any_of:
    - node-lib: !private + bin/main/exports/module/publishConfig
    - php-lib:  composer.json + name + type ≠ project
    - python-lib: pyproject.toml [project] table + name + version
    - ruby-lib: *.gemspec present
    - rust-lib: Cargo.toml + [package].name + [package].version
    - go-lib:   go.mod + has tagged release
    - java-lib: pom.xml/build.gradle + groupId/artifactId

stack_implementation:
  node:   "npm publish"  (или pnpm/yarn по lockfile)
  php:    "git tag {{version}} && git push --tags"
  python: "python -m build && twine upload dist/*"  (или poetry/hatch/flit detect)
  ruby:   "gem build *.gemspec && gem push *.gem"
  rust:   "cargo publish"
  go:     "git tag {{version}} && git push --tags"
  java:   "mvn deploy"  (или gradle publish)

refuses_if:
  - rubric.tests < L2              # untested code doesn't publish
  - rubric.release-artifact < L3   # no entry-points / no metadata
  - rubric.ci < L2                 # no green CI proof
  - working_tree.dirty             # uncommitted changes
  - git.head_commit != git.tag(version)  # version mismatch

escape_hatch:
  - [tasks.publish] в mise.toml переопределяет default
  - --force обходит refuses_if (с warning)
  - --dry-run печатает план без execution
```

### Новая рубричная ось — `release-workflow` (предложение от PHP+Py agent)

Orthogonal к `lifecycle-interface`. Измеряет **качество process**, не наличие команды:

- **L1**: documented release script exists (`[tasks.publish]` в mise.toml ИЛИ CI workflow с publish-step)
- **L2**: + automated changelog (conventional-changelog / changesets / PSR)
- **L3**: + semver enforcement (semver-checker / commit-conventions linted)
- **L4**: + idempotency check + signing/verification (Sigstore / GPG / npm provenance / PyPI Trusted Publishing)

Это **дополнение** к `release-artifact` (которая измеряет metadata-readiness),
не замена. `release-artifact` = «пакет publish-ready», `release-workflow` =
«процесс publish'а зрелый». Применима **только если** `applies_when:
lib intent` (та же гейтинг логика).

### Extension protocol для D7 (mitigation архитектурного риска)

D7 fix'ит 6-словарь и bet'ит "consistency > coverage". Добавление verb
изменяет это. Mitigation:

1. **Vocabulary additions = minor `schema_version` bump** (никогда не
   removals — это major break).
2. **New verbs ship `applies_when` defaults** → existing проекты (где verb
   не применим) видят zero change.
3. **Backward-compat**: старые manifests без `publish` continue работать —
   просто `mise run publish` падает с "task not found", это OK.
4. **Aliasing**: для уже-существующих проектов с `[tasks.release]` →
   `vdx publish` может auto-mapping (preferences-driven).

Cost bounded. Benefit (covering the most agent-confusing boundary —
release/publish) high.

### Connections к существующим решениям vdx

| Существующее | Что меняется в D12 |
|-------------|-------------------|
| **D3** (mise as runner) | Сохраняется. `vdx publish` → `mise run publish` → stack-specific impl. |
| **D4** (manifest = mise.toml + [vdx]) | Сохраняется. `[tasks.publish]` живёт в mise.toml. |
| **D7** (weighted_two_class scoring) | Сохраняется. Verb влияет на vocabulary, не на scoring. |
| **D8** (shared-infra качество подхода) | Параллель: `release-workflow` axis тоже про "качество подхода". |
| **Шаг S / O35** (applies_when) | **Переиспользуется напрямую** для `applies_when: lib intent`. |
| **`release-artifact` axis** | Становится **gating predicate** для `vdx publish refuses_if`. Новый use case оси. |

---

## Resolved questions (после ревью пользователя 2026-05-24)

- **OQ1 ✅** — Принят **(B+)**: `publish` как 7-й lifecycle verb, lib-gated через
  applies_when. `deploy` deferred до D13. `release` как meta-verb отвергнут
  (noun-collision: GitHub Release / semantic-release / Helm Release; conflate'ит
  две оси).
- **OQ2 ✅** — `release-workflow` ось **deferred** как **O36**. Добавляем
  после D12 ship + N≥3 lib-проектов для калибровки. Не reject — defer.
- **OQ3 ✅** — `vdx publish` на apps (applies_when=false) → **error + exit 1**
  с helpful message ("looks like app, use `vdx deploy` (D13) или edit
  manifest"). `--force` opt-out для escape-hatch false-negatives. Fail-fast
  выбран потому что publish это irreversible operation.
- **OQ4 ✅** — Bump **в scope** D12 как **subverb** + **arg-form**: `vdx publish
  patch|minor|major` делает full default pipeline; sub-verbs `publish:bump`,
  `publish:upload`, `publish:tag`, `publish:notes` для granular control. vdx
  **институциализирует** stack-specific defaults (Node = `npm version X &&
  npm publish && git push --follow-tags`; PHP = composer.json edit + git tag +
  push; Python = build + twine + tag; и т.п.). Transactional: pre-flight →
  upload first (irreversible) → bump+commit+tag+push only on success. `vdx
  bump` standalone отложен как **O37**.
- **OQ5 ✅** — Conventional-commits — **opt-in (B)**. vdx auto-detects через
  heuristic (~80% threshold в последних N commits); uses для richer
  CHANGELOG/notes если есть; fallback на plain commit messages иначе.
  Никогда не блокирует `vdx publish`. `--no-conventional` флаг для force
  plain mode. Свяжется с O36 (release-workflow L3 signal).
- **OQ6 ✅** — Monorepo — **defer + graceful proxy**. MVP D12 single-package.
  Detection matrix:
  - `.changeset/` directory → proxy в `changeset publish`
  - `workspaces:` без `.changeset/` → warning + exit 1 ("define `[tasks.publish]`
    manually")
  - Multi-stack root → error "ambiguous publish target, use `--stack` or
    `primary_subpackage`"
  Native monorepo-aware publish — **O38** (D14+), после N≥2 real monorepo
  и закрытия O32.
- **OQ7 ✅** — `git.head_commit != git.tag(version)` check **реализуется в MVP**
  как **warning-by-default + `--strict` opt-in**. Skipped когда `vdx publish
  patch|minor|major` (vdx сам создаёт tag в pipeline). Применяется в
  no-arg / subverb-only flows.

---

## Что дальше — implementation

D12 принято как architecture decision. Следующие шаги:

1. **`docs/specs/publish-verb.md`** — concrete spec implementation
   (interleave abstract+concrete по skill s1-72: пишем спеку рядом с
   первой реализацией для Node-стека).
2. **Phase 1 (MVP — Шаг W?)**: `vdx publish [patch|minor|major]` для Node only.
   Использовать `vdx-cli` как первый dogfood — выпустить @vodmal/vdx-cli@0.4.0
   через `vdx publish patch`.
3. **Phase 2** — PHP + Python defaults.
4. **Phase 3** — Cargo, Ruby, Go, Java.
5. **Sub-verbs** parallel со всеми phases.
6. **Затем O36** (release-workflow ось) — после ship + калибровка.
