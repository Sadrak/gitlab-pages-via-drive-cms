# GitLab Pages via Drive CMS

Verwaltung einer GitLab Pages Webseite mittels Google Drive als CMS.

## Übersicht

Dieses Projekt ermöglicht die automatische Synchronisierung von Inhalten aus Google Drive mit einem VitePress-Repository, das auf GitLab Pages gehostet wird.

### Funktionen

- 📂 **Google Drive Integration**: Automatisches Abrufen von Dokumenten, Tabellen und Bildern aus einem öffentlichen Google Drive Ordner
- 🔄 **Intelligenter Abgleich**: Nur geänderte Inhalte werden synchronisiert (basierend auf Änderungsdatum)
- 🤖 **KI-Transformation**: Automatische Konvertierung und Optimierung von Inhalten mit Google Gemini AI
- 📝 **VitePress-kompatibel**: Generiert sauberes Markdown mit YAML-Frontmatter
- 🚀 **GitLab Integration**: Automatische Erstellung von Merge Requests für Content-Updates

## Installation

```bash
npm install
```

## Konfiguration

1. Kopiere `.env.example` nach `.env`:
   ```bash
   cp .env.example .env
   ```

2. Fülle die Umgebungsvariablen aus:

   | Variable | Beschreibung |
   |----------|--------------|
   | `GOOGLE_DRIVE_FOLDER_ID` | Die ID des Google Drive Hauptordners |
   | `GOOGLE_API_KEY` | Dein Google API-Schlüssel |
   | `GEMINI_API_KEY` | Dein Google Gemini API-Schlüssel |
   | `GITLAB_URL` | Die URL deiner GitLab-Instanz (Standard: https://gitlab.com) |
   | `GITLAB_PROJECT_ID` | Die ID deines GitLab-Projekts |
   | `GITLAB_TOKEN` | Dein GitLab Access Token |
   | `GIT_USER_NAME` | Name für Git-Commits (Standard: Content Bot) |
   | `GIT_USER_EMAIL` | E-Mail für Git-Commits |
   | `VITEPRESS_SRC_PATH` | Pfad zum VitePress-Quellverzeichnis (Standard: src) |
   | `VITEPRESS_PUBLIC_PATH` | Pfad für Assets (Standard: public/assets) |

## Google Drive Struktur

Die erwartete Ordnerstruktur in Google Drive:

```
Hauptordner/
├── Seite-1/
│   ├── Dokument.gdoc
│   ├── Tabelle.gsheet
│   └── Bild.png
├── Seite-2/
│   └── Inhalt.gdoc
└── ...
```

Jeder Unterordner entspricht einer Seite/Route auf der Webseite.

## Verwendung

```bash
npm run sync
```

Das Skript:
1. Ruft alle Unterordner aus dem konfigurierten Google Drive Ordner ab
2. Prüft für jeden Ordner, ob Änderungen vorliegen
3. Lädt geänderte Inhalte herunter (Dokumente, Tabellen, Bilder)
4. Transformiert die Inhalte mit Google Gemini AI zu Markdown
5. Erstellt einen neuen Git-Branch mit den Änderungen
6. Erstellt einen Draft Merge Request in GitLab

## Pipeline-Integration

Das Skript kann in einer CI/CD-Pipeline ausgeführt werden:

```yaml
# .gitlab-ci.yml Beispiel
sync-content:
  image: node:18
  script:
    - npm install
    - npm run sync
  only:
    - schedules
```

## Lizenz

MIT
