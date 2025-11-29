# GitLab Pages via Google Drive CMS

🤖 Automatische Synchronisation von Google Drive Inhalten zu VitePress

## 📋 Überblick

Dieses Projekt ermöglicht die automatische Synchronisation von Inhalten aus Google Drive mit einer VitePress-Webseite, die auf GitLab gehostet wird. Das Node.js-Skript erkennt intelligent Änderungen, transformiert Inhalte mit KI und erstellt automatisch Merge Requests.

## ✨ Features

- **🔄 Intelligenter Diff-Check**: Synchronisiert nur tatsächlich geänderte Inhalte
- **🤖 KI-gestützte Transformation**: Google Gemini optimiert und formatiert Texte automatisch zu Markdown
- **📸 Bild-Verwaltung**: Automatischer Download und Einbindung von Bildern
- **🔀 GitLab Integration**: Automatische Erstellung von Draft Merge Requests
- **📊 Sheets-Support**: Konvertiert Google Sheets zu Markdown-Tabellen
- **🔍 Metadata-Tracking**: Vermeidet unnötige Updates durch intelligentes Tracking

## 🏗️ Struktur

### Google Drive
```
Hauptordner/
├── Glossar.gdoc        # ← Context-Dokument (Stammverzeichnis)
├── Wiki.gdoc           # ← Context-Dokument (Stammverzeichnis)
├── Ordner-1/           # → wird zu /src/Ordner-1/
│   ├── Dokument.gdoc
│   ├── Tabelle.gsheet
│   └── bild.png
├── Ordner-2/           # → wird zu /src/Ordner-2/
│   └── ...
└── ...
```

**💡 Tipp:** Alle Google Docs und Sheets im **Stammverzeichnis** werden automatisch als Context-Dokumente geladen und der KI in jedem Prompt zur Verfügung gestellt!

### VitePress Repository
```
projekt/
├── src/
│   ├── ordner-1/
│   │   └── index.md
│   └── ordner-2/
│       └── index.md
├── public/
│   └── assets/
│       ├── ordner-1/
│       │   └── bild.png
│       └── ordner-2/
└── sync-content.js
```

## 🚀 Installation

### 1. Dependencies installieren

```bash
npm install
```

### 2. Umgebungsvariablen konfigurieren

Kopiere `.env.example` zu `.env` und fülle die Werte aus:

```bash
cp .env.example .env
```

#### Erforderliche Werte:

**Google Drive:**
- `DRIVE_FOLDER_ID`: Die ID des Hauptordners (aus der URL)
  - URL: `https://drive.google.com/drive/folders/HIER_IST_DIE_ID`
  - Der Ordner muss öffentlich zugänglich sein

**Google Gemini API:**
- `GEMINI_API_KEY`: API Key von [Google AI Studio](https://makersuite.google.com/app/apikey)

**GitLab:**
- `GITLAB_TOKEN`: Personal Access Token mit `api` und `write_repository` Rechten
  - Erstellen unter: GitLab → Settings → Access Tokens
- `GITLAB_PROJECT_ID`: Projekt-ID (zu finden unter Settings → General)
- `GITLAB_API_URL`: Standard: `https://gitlab.com/api/v4`

**Pfade:**
- `REPO_PATH`: Absoluter Pfad zum lokalen Repository
- `CONTENT_PATH`: Relativer Pfad für Markdown-Dateien (Standard: `src`)
- `ASSETS_PATH`: Relativer Pfad für Assets (Standard: `public/assets`)

### 3. Google Drive vorbereiten

1. Erstelle einen öffentlichen Hauptordner in Google Drive
2. Erstelle Unterordner für jede Seite deiner Webseite
3. Füge Inhalte hinzu (Google Docs, Sheets, Bilder)
4. Stelle sicher, dass die Ordner öffentlich zugänglich sind

## 💻 Verwendung

### Manuelle Ausführung

```bash
npm run sync
```

### In CI/CD Pipeline

Das Skript ist für die Verwendung in GitLab CI/CD oder anderen Pipelines optimiert:

```yaml
# .gitlab-ci.yml
sync-content:
  stage: update
  image: node:20
  before_script:
    - npm install
  script:
    - node sync-content.js
  only:
    - schedules
  variables:
    DRIVE_FOLDER_ID: $DRIVE_FOLDER_ID
    GEMINI_API_KEY: $GEMINI_API_KEY
    GITLAB_TOKEN: $GITLAB_TOKEN
    GITLAB_PROJECT_ID: $CI_PROJECT_ID
```

Richte einen [Pipeline Schedule](https://docs.gitlab.com/ee/ci/pipelines/schedules.html) ein, um das Skript regelmäßig auszuführen.

## 🔍 Wie es funktioniert

### 1. **Discovery Phase**
- Lädt alle Unterordner aus dem konfigurierten Google Drive Hauptordner
- Für jeden Ordner: Liste alle enthaltenen Dateien auf

### 2. **Diff-Check Phase**
- Prüft das `modifiedTime` aller Dateien im Drive-Ordner
- Vergleicht mit den Metadaten in der lokalen `index.md` Datei
- **Überspringt** den Ordner, wenn keine Änderungen vorliegen
- **Verarbeitet** nur bei tatsächlichen Änderungen

### 3. **Content Processing Phase** (nur bei Änderungen)
- **Google Docs**: Export als Plaintext
- **Google Sheets**: Export als CSV, Formatierung als Markdown-Code-Block
- **Bilder**: Download zu `/public/assets/<ordner-name>/`
- **KI-Transformation**: 
  - Liest existierenden Markdown-Inhalt
  - Sendet alten + neuen Inhalt an Gemini API
  - Erhält optimierten Markdown mit Frontmatter, TL;DR, Navigation
- **Metadata-Speicherung**: HTML-Kommentar mit Sync-Timestamp und Dateiliste

### 4. **Git Automation Phase**
- Erstellt Branch: `content-update-<timestamp>`
- Committed alle Änderungen
- Pushed Branch zum Remote
- Erstellt Draft Merge Request mit Label "Content-Update"

## 📝 Metadata Format

Das Skript speichert unsichtbare Metadaten in jeder generierten Markdown-Datei:

```markdown
<!-- 
SYNC_METADATA:
last_sync: 2025-11-27T10:30:00.000Z
source_files: Dokument.gdoc (abc123), Bild.png (def456)
-->

---
title: Meine Seite
description: Beschreibung
---

# Inhalt...
```

Diese Metadaten werden für den Diff-Check verwendet, um unnötige Updates zu vermeiden.

## 🛠️ Technische Details

### Dependencies
- **googleapis**: Google Drive API Zugriff
- **@google/generative-ai**: Google Gemini für Content-Transformation
- **simple-git**: Git-Operationen
- **axios**: HTTP-Requests für GitLab API
- **dotenv**: Umgebungsvariablen-Verwaltung

### Architektur
Das Skript folgt einem objektorientierten Design mit klarer Trennung:

- `DriveService`: Google Drive Interaktion
- `ContentProcessor`: KI-Transformation und Metadata
- `GitService`: Git-Operationen
- `GitLabService`: GitLab API Integration
- `ContentSynchronizer`: Orchestrierung der gesamten Logik

## 🐛 Troubleshooting

### "Fehlende Konfiguration"
→ Prüfe, ob alle erforderlichen Variablen in `.env` gesetzt sind

### "Fehler beim Auflisten der Ordner"
→ Stelle sicher, dass der Drive-Ordner öffentlich zugänglich ist

### "GitLab Token ungültig"
→ Erstelle einen neuen Token mit `api` und `write_repository` Rechten

### "Keine Änderungen erkannt"
→ Das ist korrekt! Das Skript synchronisiert nur bei tatsächlichen Änderungen

## 📄 Lizenz

MIT

## 👨‍💻 Entwickelt für

VitePress-Webseiten mit GitLab Pages und Google Drive als Content Management System
