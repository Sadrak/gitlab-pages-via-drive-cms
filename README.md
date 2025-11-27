# gitlab-pages-via-drive-cms

Verwaltung einer GitLab Pages Webseite mittels Google Drive als CMS.

## Beschreibung

Dieses Projekt ermöglicht die automatische Synchronisation von Inhalten aus Google Drive mit einem VitePress Repository. Es verwendet Google Gemini AI zur Textoptimierung und erstellt automatisch Merge Requests in GitLab.

## Features

- **Intelligenter Abgleich**: Prüft Änderungszeitstempel und synchronisiert nur geänderte Inhalte
- **Multi-Format Support**: Unterstützt Google Docs, Google Sheets und Bilder
- **KI-Transformation**: Wandelt Rohtexte in sauberes Markdown mit Google Gemini um
- **Automatische Git-Operationen**: Erstellt Branches, Commits und Merge Requests
- **VitePress-optimiert**: Erzeugt Frontmatter, TL;DR-Blöcke und korrekte Bildpfade

## Installation

```bash
npm install
```

## Konfiguration

Kopiere `.env.example` nach `.env` und fülle die Werte aus:

```bash
cp .env.example .env
```

### Umgebungsvariablen

| Variable | Beschreibung |
|----------|--------------|
| `GOOGLE_API_KEY` | Google API Key für den Drive-Zugriff |
| `GOOGLE_DRIVE_FOLDER_ID` | ID des Hauptordners in Google Drive |
| `GEMINI_API_KEY` | API Key für Google Gemini AI |
| `GITLAB_URL` | GitLab URL (Standard: https://gitlab.com) |
| `GITLAB_PROJECT_ID` | ID des GitLab Projekts |
| `GITLAB_ACCESS_TOKEN` | Persönlicher Access Token für GitLab |
| `GITLAB_TARGET_BRANCH` | Ziel-Branch für MRs (Standard: main) |
| `VITEPRESS_SRC_PATH` | Pfad zum VitePress Source-Ordner (Standard: src) |
| `VITEPRESS_ASSETS_PATH` | Pfad für Bilder (Standard: public/assets) |

## Verwendung

```bash
npm run sync
```

### Google Drive Struktur

```
Hauptordner/
├── Seite-1/
│   ├── Inhalt.gdoc
│   ├── Tabelle.gsheet
│   └── bild.png
├── Seite-2/
│   └── Protokoll.gdoc
└── ...
```

### Generierte VitePress Struktur

```
src/
├── Seite-1/
│   └── index.md
├── Seite-2/
│   └── index.md
└── ...
public/
└── assets/
    ├── Seite-1/
    │   └── bild.png
    └── ...
```

## Pipeline Integration

Das Script kann in einer CI/CD Pipeline verwendet werden:

```yaml
sync-content:
  image: node:20
  script:
    - npm install
    - npm run sync
  only:
    - schedules
```

## Lizenz

MIT
