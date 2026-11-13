# .pi-plus

Fork-local pi resources (extensions, prompt templates, skills).

This directory exists so that `.pi/` stays pristine upstream content. Never edit
`.pi/` in this fork — upstream maintains it and edits there cause merge conflicts
on every upstream sync. Put fork-specific overrides and additions here instead.

Layout mirrors `.pi/`:

```
.pi-plus/
  extensions/   # .ts pi extensions
  prompts/      # prompt templates (/name)
  skills/       # skills
```

## Loading

`.pi-plus/` is not auto-discovered. Load its resources explicitly, e.g.:

- CLI: `pipi -e .pi-plus/extensions/<name>.ts`
- Settings: add paths to the `extensions` / `skills` / `prompts` arrays in pipi's
  global `settings.json` (`~/.pi/.../settings.json`), so every session in this
  repo picks them up without touching `.pi/`.

When an upstream resource under `.pi/` needs a fork change, copy it here, adapt
it, and make sure only one of the two is loaded (see pi's replaceable-extension
warning) — do not edit the `.pi/` copy.
