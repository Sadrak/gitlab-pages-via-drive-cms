#!/usr/bin/env node

/**
 * Google Drive zu VitePress Content Synchronisation
 * 
 * Dieses Skript synchronisiert Inhalte aus Google Drive mit einem VitePress Repository.
 * Es prüft auf Änderungen, lädt neue Inhalte herunter, transformiert sie mit KI
 * und erstellt automatisch Merge Requests in GitLab.
 */

import 'dotenv/config';
import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import simpleGit from 'simple-git';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { throws } from 'assert';

// ES Module Kompatibilität für __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========================================
// Konfiguration
// ========================================


// KI System-Prompt für die Content-Transformation
const DEFAULT_SYSTEM_PROMPT = `
Du bist ein Redakteur. Wandle Texte in sauberes Markdown für VitePress um.

Stil-Richtlinien:
- Verwende aktive Sprache und Du-Form
- Gliedere in: Übersicht, Details, Beispiele, Troubleshooting
- Nutze Emojis sparsam (nur für wichtige Hinweise)

Format:
- Erstelle YAML Frontmatter mit: title, description, tags
- Gib KEINE Erklärungen zum Prozess aus
- Nutze Markdown Syntax korrekt
- Schreibe Markdown OHNE einen Markdown-Block
- TL;DR Block am Anfang (max 100 Wörter)
- Verwende # für Hauptüberschriften, ## für Unterüberschriften
- Bilder mit beschreibenden Alt-Texten
- Füge die Bilder an passenden Stellen ein, wenn der Text Platzhalter enthält, oder am Ende

Inhalt:
- Nutze den bereitgestellten Text und ergänze ihn sinnvoll
- Entferne veraltete oder unbestätigte Informationen
- Achte auf Konsistenz in Terminologie und Stil
- Versuche möglichst, den bestehenden Inhalt zu erweitern ohne unnötige Anpassungen
- Korrigiere Rechtschreibfehler und Grammatikfehler
`;

/**
 * Erkenne dynamisch die Git-Provider API URL
 * Basierend auf CI-Variablen oder Git Remote URL
 */
function detectGitApiUrl() {
  // Explizit gesetzte URLs haben Vorrang
  if (process.env.GIT_API_URL) return process.env.GIT_API_URL;
  if (process.env.GITLAB_API_URL) return process.env.GITLAB_API_URL;
  if (process.env.CI_API_V4_URL) return process.env.CI_API_V4_URL;
  
  // GitHub Actions Umgebung
  if (process.env.GITHUB_API_URL) {
    return process.env.GITHUB_API_URL; // Standard: https://api.github.com
  }
  
  // Erkenne anhand CI-spezifischer Variablen
  if (process.env.GITHUB_ACTIONS === 'true') {
    return 'https://api.github.com';
  }
  
  if (process.env.GITLAB_CI === 'true' || process.env.CI_SERVER_URL) {
    const serverUrl = process.env.CI_SERVER_URL || 'https://gitlab.com';
    return `${serverUrl}/api/v4`;
  }
  
  // Versuche aus Git Remote URL zu erkennen (sync, keine async hier)
  try {
    const { execSync } = require('child_process');
    const remoteUrl = execSync('git config --get remote.origin.url', { 
      encoding: 'utf8',
      cwd: process.env.REPO_PATH || process.env.CI_PROJECT_DIR || process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    
    if (remoteUrl.includes('github.com')) {
      return 'https://api.github.com';
    } else if (remoteUrl.includes('gitlab.com')) {
      return 'https://gitlab.com/api/v4';
    } else if (remoteUrl.match(/^https?:\/\/([^\/]+)/)) {
      // Self-hosted GitLab: Extrahiere Domain und nehme an es ist GitLab
      const match = remoteUrl.match(/^https?:\/\/([^\/]+)/);
      if (match) {
        return `https://${match[1]}/api/v4`;
      }
    }
  } catch (e) {
    // Ignoriere Fehler, nutze Fallback
  }
  
  // Fallback zu GitLab
  return 'https://gitlab.com/api/v4';
}

const CONFIG = {
  driveFolderId: process.env.DRIVE_FOLDER_ID,
  googleApiKey: process.env.GOOGLE_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3-pro-preview',
  geminiSystemPrompt: process.env.GEMINI_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
  // Git-Provider Token (funktioniert mit GitLab und GitHub)
  // GitHub Actions: GITHUB_TOKEN (automatisch gesetzt)
  // GitLab CI: CI_JOB_TOKEN (automatisch gesetzt)
  gitAccessToken: process.env.GIT_ACCESS_TOKEN || process.env.GITHUB_TOKEN || process.env.CI_JOB_TOKEN || process.env.GITLAB_TOKEN,
  // Git-Provider Projekt/Repository ID
  // GitHub: GITHUB_REPOSITORY (z.B. "owner/repo")
  // GitLab: CI_PROJECT_ID (numeric ID)
  gitProjectId: process.env.GIT_PROJECT_ID || process.env.GITHUB_REPOSITORY || process.env.GITLAB_PROJECT_ID || process.env.CI_PROJECT_ID,
  // Git-Provider API URL (dynamisch erkannt)
  gitApiUrl: detectGitApiUrl(),
  repoPath: process.env.REPO_PATH || process.env.GITHUB_WORKSPACE || process.env.CI_PROJECT_DIR || process.cwd(),
  contentPath: process.env.CONTENT_PATH || 'docs',
  assetsPath: process.env.ASSETS_PATH || 'public/assets',
  logLevel: process.env.LOG_LEVEL || 'info',
  // Git Benutzer-Konfiguration für Commits
  gitUserName: process.env.GIT_USER_NAME || process.env.GITLAB_USER_NAME || 'Content Sync Bot',
  gitUserEmail: process.env.GIT_USER_EMAIL || process.env.GITLAB_USER_EMAIL || 'bot@content-sync.local'
};

// ========================================
// Logger
// ========================================

class Logger {
  static log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}]`, message, ...args);
  }

  static info(message, ...args) {
    this.log('info', message, ...args);
  }

  static debug(message, ...args) {
    if (CONFIG.logLevel === 'debug') {
      this.log('debug', message, ...args);
    }
  }

  static error(message, ...args) {
    this.log('error', message, ...args);
  }

  static success(message, ...args) {
    this.log('success', `✓ ${message}`, ...args);
  }
}

// ========================================
// Google Drive Service
// ========================================

class DriveService {
  constructor(googleApiKey) {
    // Für öffentliche Ordner brauchen wir nur einen API Key
    this.drive = google.drive({ version: 'v3', auth: googleApiKey });
  }

  /**
   * Liste alle Unterordner im Hauptordner
   */
  async listFolders(parentFolderId) {
    try {
      Logger.debug(`Liste Ordner in: ${parentFolderId}`);
      
      const response = await this.drive.files.list({
        q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id, name, modifiedTime)',
        orderBy: 'name'
      });

      return response.data.files || [];
    } catch (error) {
      Logger.error('Fehler beim Auflisten der Ordner:', error.message);
      throw error;
    }
  }

  /**
   * Liste alle Dateien in einem Ordner
   */
  async listFiles(folderId) {
    try {
      Logger.debug(`Liste Dateien in Ordner: ${folderId}`);
      
      const response = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id, name, mimeType, modifiedTime)',
        orderBy: 'modifiedTime desc'
      });

      return response.data.files || [];
    } catch (error) {
      Logger.error('Fehler beim Auflisten der Dateien:', error.message);
      throw error;
    }
  }

  /**
   * Lade den Inhalt eines Google Docs
   */
  async downloadDocContent(fileId) {
    try {
      Logger.debug(`Lade Google Doc: ${fileId}`);
      
      const response = await this.drive.files.export({
        fileId: fileId,
        mimeType: 'text/plain'
      }, { responseType: 'text' });

      return response.data;
    } catch (error) {
      Logger.error(`Fehler beim Download von Doc ${fileId}:`, error.message);
      throw error;
    }
  }

  /**
   * Lade den Inhalt eines Google Sheets als CSV
   */
  async downloadSheetContent(fileId) {
    try {
      Logger.debug(`Lade Google Sheet: ${fileId}`);
      
      const response = await this.drive.files.export({
        fileId: fileId,
        mimeType: 'text/csv'
      }, { responseType: 'text' });

      return response.data;
    } catch (error) {
      Logger.error(`Fehler beim Download von Sheet ${fileId}:`, error.message);
      throw error;
    }
  }

  /**
   * Lade ein Bild herunter
   */
  async downloadImage(fileId) {
    try {
      Logger.debug(`Lade Bild: ${fileId}`);
      
      const response = await this.drive.files.get({
        fileId: fileId,
        alt: 'media'
      }, { responseType: 'arraybuffer' });

      return Buffer.from(response.data);
    } catch (error) {
      Logger.error(`Fehler beim Download von Bild ${fileId}:`, error.message);
      throw error;
    }
  }

  /**
   * Ermittle das neueste Änderungsdatum aller Dateien in einem Ordner
   */
  async getLatestModifiedTime(folderId) {
    try {
      const files = await this.listFiles(folderId);
      
      if (files.length === 0) {
        return null;
      }

      // Finde die neueste Änderung
      const latestFile = files.reduce((latest, file) => {
        const fileTime = new Date(file.modifiedTime);
        const latestTime = new Date(latest.modifiedTime);
        return fileTime > latestTime ? file : latest;
      }, files[0]);

      return new Date(latestFile.modifiedTime);
    } catch (error) {
      Logger.error('Fehler beim Ermitteln des neuesten Datums:', error.message);
      throw error;
    }
  }
}

// ========================================
// Content Processor
// ========================================

class ContentProcessor {
  constructor(googleApiKey, geminiModelName, geminiSystemPrompt) {
    this.genAI = new GoogleGenerativeAI(googleApiKey);
    
    const modelConfig = {
      model: geminiModelName,
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 16384,
      }
    };
    
    this.model = this.genAI.getGenerativeModel(modelConfig);
    this.systemPrompt = geminiSystemPrompt;
    
    Logger.debug(`ContentProcessor initialisiert mit Modell: ${geminiModelName}`);
  }

  /**
   * Transformiere rohen Text mit KI zu Markdown
   */
  async transformToMarkdown(rawContent, images, existingContent, contextDocuments = []) {
    try {
      Logger.debug('Starte KI-Transformation...');

      // Erstelle Context-Block aus geladenen Dokumenten
      let contextBlock = '';
      
      if (contextDocuments.length > 0) {
        contextBlock = '\n\n## Zusätzliche Anweisungen und Kontext\n\n';
        contextBlock += 'Beachte folgende Dokumente bei der Content-Erstellung:\n\n';
        
        for (const doc of contextDocuments) {
          contextBlock += `### ${doc.name}\n\n`;
          contextBlock += `\`\`\`\n${doc.content}\n\`\`\`\n\n`;
        }
      }
      Logger.debug('Starte KI-Transformation...');

      // Erstelle den Prompt mit Kontext
      const imageList = images.length > 0 
        ? `\n\nVerfügbare Bilder:\n${images.map(img => `- ${img.name} (Pfad: ${img.path})`).join('\n')}`
        : '';

      const existingContentInfo = existingContent 
        ? `\n\nAktueller Inhalt der Datei:\n\`\`\`\n${existingContent}\n\`\`\``
        : '';

      const fullPrompt = `${this.systemPrompt}
${contextBlock}
${existingContentInfo}

Neuer/Zusätzlicher Inhalt:
\`\`\`
${rawContent}
\`\`\`
${imageList}`;

      Logger.debug(`Prompt-Länge: ${this.systemPrompt.length} Zeichen`);
      Logger.debug(`Context-Dokumente: ${contextDocuments.length}`);
      Logger.debug(`Verwende System-Prompt: ${this.systemPrompt.substring(0, 100)}...`);

      Logger.debug('Starte KI-Transformation...');
      const result = await this.model.generateContent(fullPrompt);
      const response = await result.response;
      const transformedContent = response.text();

      Logger.success('KI-Transformation abgeschlossen');
      return transformedContent;
    } catch (error) {
      Logger.error('Fehler bei der KI-Transformation:', error.message);
      throw error;
    }
  }

  /**
   * Erstelle Metadaten-Block für die Markdown-Datei
   */
  createMetadataComment(files, timestamp) {
    const fileList = files.map(f => `${f.name} (${f.id})`).join(', ');
    return `<!-- 
SYNC_METADATA:
last_sync: ${timestamp.toISOString()}
source_files: ${fileList}
-->

`;
  }

  /**
   * Extrahiere Metadaten aus einer Markdown-Datei
   */
  extractMetadata(content) {
    const metadataRegex = /<!--\s*SYNC_METADATA:\s*last_sync:\s*(.+?)\s*source_files:\s*(.+?)\s*-->/s;
    const match = content.match(metadataRegex);

    if (match) {
      return {
        lastSync: new Date(match[1]),
        sourceFiles: match[2]
      };
    }

    return null;
  }
}

// ========================================
// Git Service
// ========================================

class GitService {
  constructor(repoPath, gitAccessToken, userName, userEmail) {
    this.repoPath = repoPath;
    this.gitAccessToken = gitAccessToken;
    this.remoteName = 'origin'; // Wird zu 'sync-origin' wenn Token vorhanden

    // Git-Config für Benutzer (wird für Commits benötigt)
    const gitConfig = [
      `user.name=${userName}`,
      `user.email=${userEmail}`
    ];

    if (gitAccessToken) {
      const authString = Buffer.from(`oauth2:${gitAccessToken}`).toString('base64');
      gitConfig.push(`http.extraHeader=Authorization: Basic ${authString}`);
    }
    
    this.git = simpleGit(repoPath, {
      config: gitConfig,
    });
    
    Logger.debug(`GitService initialisiert${gitAccessToken ? ' (mit Token-Auth)' : ''} (User: ${userName} <${userEmail}>)`);
  }
  
  /**
   * Erstelle einen dedizierten HTTPS Remote für Token-Auth
   * Lässt origin unverändert und erstellt sync-origin mit HTTPS URL (OHNE Token)
   * Token wird über Environment Variables (GIT_PASSWORD) zur Laufzeit genutzt
   */
  async ensureSyncRemote() {
    try {
      if (!this.gitAccessToken) {
        return; // Kein Token = nutze origin direkt
      }
      
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find(r => r.name === 'origin');
      
      if (!origin) {
        Logger.error('Kein "origin" Remote gefunden');
        return;
      }
      
      let url = origin.refs.fetch;
      let httpsUrl = url;
      
      // Konvertiere SSH zu HTTPS falls nötig (OHNE Token in URL)
      if (url.startsWith('git@')) {
        const match = url.match(/^git@([^:]+):(.+)$/);
        if (match) {
          const hostname = match[1];
          const repoPath = match[2];
          httpsUrl = `https://${hostname}/${repoPath}`;
          Logger.debug(`Konvertiere SSH zu HTTPS für sync-origin (Token via Env)`);
        }
      } else if (url.startsWith('http')) {
        // HTTPS URL: Entferne vorhandene Auth-Infos, Token kommt via Env
        const match = url.match(/^https?:\/\/(?:[^@]+@)?([^\/]+\/.+)$/);
        if (match) {
          httpsUrl = `https://${match[1]}`;
        }
      }
      
      // Prüfe ob sync-origin bereits existiert
      const syncOrigin = remotes.find(r => r.name === 'sync-origin');
      
      if (syncOrigin) {
        // Aktualisiere URL falls sie sich geändert hat
        await this.git.remote(['set-url', 'sync-origin', httpsUrl]);
        Logger.debug('sync-origin Remote aktualisiert (Token wird via Env genutzt)');
      } else {
        // Erstelle neuen sync-origin Remote
        await this.git.addRemote('sync-origin', httpsUrl);
        Logger.debug('sync-origin Remote erstellt (Token wird via Env genutzt)');
      }
      
      // Nutze sync-origin für alle Operationen
      this.remoteName = 'sync-origin';
      
    } catch (error) {
      Logger.error('Fehler beim Erstellen des sync-origin Remote:', error.message);
      // Fallback zu origin
      this.remoteName = 'origin';
    }
  }

  /**
   * Ermittle den aktuellen Branch
   */
  async getCurrentBranch() {
    try {
      const status = await this.git.status();
      return status.current;
    } catch (error) {
      Logger.error('Fehler beim Ermitteln des aktuellen Branches:', error.message);
      throw error;
    }
  }

  /**
   * Erstelle einen neuen Branch vom aktuellen Branch aus
   */
  async createBranch(branchName) {
    try {
      const currentBranch = await this.getCurrentBranch();
      Logger.debug(`Erstelle Branch: ${branchName} (Basis: ${currentBranch})`);
      
      // Erstelle/aktualisiere sync-origin Remote für Token-Auth
      await this.ensureSyncRemote();
      
      // Hole aktuelle Änderungen vom aktuellen Branch
      await this.git.pull(this.remoteName, currentBranch);
      
      // Erstelle neuen Branch vom aktuellen Branch aus
      await this.git.checkoutLocalBranch(branchName);
      
      Logger.success(`Branch ${branchName} erstellt von ${currentBranch}`);
      return currentBranch; // Gebe Basis-Branch zurück für spätere Verwendung
    } catch (error) {
      Logger.error('Fehler beim Erstellen des Branches:', error.message);
      throw error;
    }
  }

  /**
   * Committe Änderungen
   */
  async commitChanges(message) {
    try {
      Logger.debug('Füge Änderungen hinzu...');
      await this.git.add('.');
      
      const status = await this.git.status();
      
      if (status.files.length === 0) {
        Logger.info('Keine Änderungen zum Committen');
        return false;
      }

      Logger.debug(`Committe ${status.files.length} Dateien...`);
      await this.git.commit(message);
      
      Logger.success('Änderungen committed');
      return true;
    } catch (error) {
      Logger.error('Fehler beim Committen:', error.message);
      throw error;
    }
  }

  /**
   * Pushe Branch zum Remote
   */
  async pushBranch(branchName) {
    try {
      Logger.debug(`Pushe Branch: ${branchName} (Remote: ${this.remoteName})`);
      
      await this.git.push(this.remoteName, branchName, ['--set-upstream']);
      Logger.success(`Branch ${branchName} gepusht`);
      return true;
    } catch (error) {
      Logger.error('Fehler beim Pushen:', error.message);
      throw error;
    }
  }

  /**
   * Gehe zurück zum angegebenen Branch
   */
  async returnToBranch(branchName) {
    try {
      await this.git.checkout(branchName);
      Logger.debug(`Zurück auf ${branchName} Branch`);
      // sync-origin bleibt bestehen für zukünftige Runs
    } catch (error) {
      Logger.error(`Fehler beim Wechsel zu ${branchName}:`, error.message);
    }
  }
}

// ========================================
// Git Provider Service (GitLab/GitHub)
// ========================================

class GitProviderService {
  constructor(apiUrl, token, projectId) {
    this.apiUrl = apiUrl;
    this.token = token;
    this.projectId = projectId;
    
    // Erkenne Provider anhand der API URL
    this.isGitHub = apiUrl.includes('github.com') || apiUrl.includes('api.github.com');
    this.providerName = this.isGitHub ? 'GitHub' : 'GitLab';
    
    Logger.debug(`GitProviderService initialisiert (${this.providerName})`);
    // Verwende passenden Auth-Header für Provider
    const headers = this.isGitHub 
      ? { 'Authorization': `token ${token}` }
      : { 'PRIVATE-TOKEN': token };
    
    this.client = axios.create({
      baseURL: apiUrl,
      headers: headers
    });
  }

  /**
   * Erstelle einen Merge Request
   */
  async createMergeRequest(sourceBranch, targetBranch, title, description) {
    try {
      Logger.debug(`Erstelle Merge Request: ${sourceBranch} → ${targetBranch}`);

      const response = await this.client.post(`/projects/${this.projectId}/merge_requests`, {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title: title,
        description: description,
        labels: ['Content-Update'],
        draft: true
      });

      Logger.success(`Merge Request erstellt: ${response.data.web_url}`);
      return response.data;
    } catch (error) {
      Logger.error('Fehler beim Erstellen des Merge Requests:', error.message);
      if (error.response) {
        Logger.error('GitLab Antwort:', error.response.data);
      }
      throw error;
    }
  }
}

// ========================================
// Content Synchronizer (Hauptlogik)
// ========================================

class ContentSynchronizer {
  constructor(config) {
    this.config = config;
    this.driveService = new DriveService(config.googleApiKey);
    this.contentProcessor = new ContentProcessor(config.googleApiKey, config.geminiModel, config.geminiSystemPrompt);
    this.gitService = new GitService(config.repoPath, config.gitAccessToken, config.gitUserName, config.gitUserEmail);
    this.gitProviderService = new GitProviderService(config.gitApiUrl, config.gitAccessToken, config.gitProjectId);
    this.changesDetected = false;
    this.processedFolders = [];
    this.contextDocuments = []; // Geladene Context-Dokumente aus Stammverzeichnis
    this.baseBranch = null; // Wird beim Branch-Erstellen gesetzt
  }

  /**
   * Lade alle Context-Dateien aus dem Drive-Stammverzeichnis
   */
  async loadContextDocuments() {
    try {
      Logger.info('\n--- Lade Context-Dokumente aus Stammverzeichnis ---');
      
      // Hole alle Dateien (keine Ordner) aus dem Stammverzeichnis
      const allFiles = await this.driveService.listFiles(this.config.driveFolderId);
      
      // Filtere nur Docs und Sheets (keine Bilder, keine Ordner)
      const contextFiles = allFiles.filter(file => 
        file.mimeType === 'application/vnd.google-apps.document' ||
        file.mimeType === 'application/vnd.google-apps.spreadsheet'
      );
      
      if (contextFiles.length === 0) {
        Logger.info('Keine Context-Dokumente im Stammverzeichnis gefunden');
        Logger.info('Hinweis: Legen Sie Dateien wie "Glossar", "Satzung" oder "Wiki" im Hauptordner ab,');
        Logger.info('         um sie als zusätzlichen Kontext für die KI zu nutzen.');
        return [];
      }
      
      Logger.info(`${contextFiles.length} Context-Datei(en) gefunden:`);
      const loadedDocs = [];
      
      for (const file of contextFiles) {
        try {
          Logger.info(`  Lade "${file.name}"...`);
          
          let content = '';
          if (file.mimeType === 'application/vnd.google-apps.document') {
            content = await this.driveService.downloadDocContent(file.id);
          } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
            content = await this.driveService.downloadSheetContent(file.id);
          }
          
          loadedDocs.push({
            name: file.name,
            content: content,
            type: file.mimeType
          });
          
          Logger.success(`  ✓ "${file.name}" geladen (${content.length} Zeichen)`);
        } catch (error) {
          Logger.error(`  ✗ Fehler beim Laden von "${file.name}":`, error.message);
        }
      }
      
      if (loadedDocs.length > 0) {
        Logger.success(`📚 ${loadedDocs.length} Context-Dokument(e) erfolgreich geladen und werden in allen Prompts verwendet`);
      }
      
      return loadedDocs;
    } catch (error) {
      Logger.error('Fehler beim Laden der Context-Dokumente:', error.message);
      return [];
    }
  }

  /**
   * Prüfe ob bereits Änderungen im Content-Verzeichnis vorliegen
   */
  async hasExistingChanges() {
    try {
      const status = await this.gitService.git.status();
      
      // Filtere nur Änderungen im contentPath
      const contentChanges = status.files.filter(file => {
        return file.path.startsWith(this.config.contentPath + '/');
      });
      
      const hasChanges = contentChanges.length > 0;
      
      if (hasChanges) {
        Logger.info(`📝 Erkannte bereits vorhandene Änderungen in ${this.config.contentPath}/:`)
        contentChanges.slice(0, 5).forEach(file => {
          Logger.info(`   - ${file.path} [${file.working_dir}]`);
        });
        if (contentChanges.length > 5) {
          Logger.info(`   ... und ${contentChanges.length - 5} weitere Datei(en)`);
        }
      }
      
      return hasChanges;
    } catch (error) {
      Logger.debug('Fehler beim Prüfen des Git-Status:', error.message);
      return false;
    }
  }

  /**
   * Hauptmethode: Synchronisation starten
   */
  async sync() {
    try {
      Logger.info('===========================================');
      Logger.info('Starte Content Synchronisation');
      Logger.info('===========================================');

      // Validiere Konfiguration
      this.validateConfig();

      // Prüfe ob bereits Änderungen vorliegen (z.B. von früherem Lauf)
      const hasExistingChanges = await this.hasExistingChanges();
      
      if (hasExistingChanges) {
        Logger.info('\n⚡ SKIP-Modus aktiviert: Überspringe Drive/KI-Verarbeitung');
        Logger.info('   Grund: Es liegen bereits Änderungen im Working Directory vor');
        Logger.info('   Fahre direkt mit Git-Operationen fort...\n');
        this.changesDetected = true;
        this.processedFolders.push('Vorhandene Änderungen');
      } else {
        // Normale Verarbeitung: Drive → KI → Dateien schreiben
        Logger.info('\n📥 Starte normale Verarbeitung (Drive → KI → Git)\n');
        
        // Lade Context-Dokumente aus dem Stammverzeichnis (einmalig für alle Ordner)
        this.contextDocuments = await this.loadContextDocuments();

        // Hole alle Unterordner aus Google Drive
        Logger.info(`Lade Ordner aus Google Drive (ID: ${this.config.driveFolderId})...`);
        const folders = await this.driveService.listFolders(this.config.driveFolderId);
        Logger.info(`${folders.length} Ordner gefunden`);

        // Verarbeite jeden Ordner
        for (const folder of folders) {
          await this.processFolder(folder);
        }
      }

      // Wenn Änderungen erkannt wurden, erstelle einen Merge Request
      if (this.changesDetected) {
        await this.createAndSubmitMergeRequest();
      } else {
        Logger.info('Keine Änderungen erkannt. Kein Merge Request erstellt.');
      }

      Logger.info('===========================================');
      Logger.success('Synchronisation abgeschlossen');
      Logger.info('===========================================');

    } catch (error) {
      Logger.error('Fehler bei der Synchronisation:', error.message);
      
      // Versuche zum Basis-Branch zurückzukehren (falls gesetzt)
      try {
        if (this.baseBranch) {
          await this.gitService.returnToBranch(this.baseBranch);
        }
      } catch (e) {
        // Ignoriere Fehler beim Zurückkehren
      }
      
      throw error;
    }
  }

  /**
   * Validiere die Konfiguration
   */
  validateConfig() {
    const required = {
      driveFolderId: 'DRIVE_FOLDER_ID',
      googleApiKey: 'GOOGLE_API_KEY',
      gitAccessToken: 'GIT_ACCESS_TOKEN, GITLAB_TOKEN, GITHUB_TOKEN oder CI_JOB_TOKEN',
      gitProjectId: 'GIT_PROJECT_ID, GITLAB_PROJECT_ID oder CI_PROJECT_ID'
    };
    
    const missing = Object.keys(required).filter(key => !this.config[key]);

    if (missing.length > 0) {
      const missingVars = missing.map(key => required[key]);
      throw new Error(`Fehlende Umgebungsvariablen: ${missingVars.join(', ')}`);
    }
  }

  /**
   * Verarbeite einen einzelnen Ordner
   */
  async processFolder(folder) {
    try {
      Logger.info(`\n--- Verarbeite Ordner: ${folder.name} ---`);

      // Pfade definieren
      const folderFileSlug = this.sanitizeFolderName(folder.name);
      const mdFilePath = path.join(this.config.repoPath, this.config.contentPath, folderFileSlug) + '.md';
      // Assets unter docs/assets/{folderFileSlug} speichern
      const assetsDir = path.join(this.config.repoPath, this.config.contentPath, 'assets', folderFileSlug);
      const contentDir = path.dirname(mdFilePath);

      // Prüfe, ob Ordner aktualisiert werden muss
      const needsUpdate = await this.checkIfUpdateNeeded(folder, mdFilePath);

      if (!needsUpdate) {
        Logger.info(`✓ Ordner "${folder.name}" ist aktuell. Überspringe.`);
        return;
      }

      Logger.info(`→ Ordner "${folder.name}" hat Änderungen. Starte Verarbeitung...`);

      // Lade alle Dateien aus dem Ordner
      const files = await this.driveService.listFiles(folder.id);
      Logger.info(`  ${files.length} Dateien gefunden`);

      // Erstelle Verzeichnisse falls nötig
      await fs.mkdir(contentDir, { recursive: true });
      await fs.mkdir(assetsDir, { recursive: true });

      // Verarbeite Inhalte
      const { textContent, images } = await this.processFiles(files, assetsDir, folderFileSlug);

      // Lade existierenden Inhalt falls vorhanden
      let existingContent = null;
      try {
        existingContent = await fs.readFile(mdFilePath, 'utf-8');
        // Entferne alte Metadaten für die KI
        existingContent = existingContent.replace(/<!--\s*SYNC_METADATA:.*?-->/s, '').trim();
      } catch (error) {
        Logger.debug('Keine existierende Datei gefunden (neu)');
      }

      // Transformiere mit KI
      Logger.info('  Transformiere Inhalt mit KI...');
      const transformedContent = await this.contentProcessor.transformToMarkdown(
        textContent,
        images,
        existingContent,
        this.contextDocuments,
      );

      // Füge Metadaten ans Ende hinzu (damit Frontmatter nicht gestört wird)
      const metadata = this.contentProcessor.createMetadataComment(files, new Date());
      const finalContent = transformedContent + '\n\n' + metadata;

      // Speichere die Datei
      await fs.writeFile(mdFilePath, finalContent, 'utf-8');
      Logger.success(`  Datei gespeichert: ${mdFilePath}`);

      // Markiere, dass Änderungen vorliegen
      this.changesDetected = true;
      this.processedFolders.push(folder.name);

    } catch (error) {
      Logger.error(`Fehler beim Verarbeiten von Ordner "${folder.name}":`, error.message);
      // Fahre mit dem nächsten Ordner fort
    }
  }

  /**
   * Prüfe, ob ein Ordner aktualisiert werden muss
   */
  async checkIfUpdateNeeded(folder, mdFilePath) {
    try {
      // Versuche Metadaten aus der lokalen Datei zu lesen
      let localMetadata = null;

      try {
        const content = await fs.readFile(mdFilePath, 'utf-8');
        localMetadata = this.contentProcessor.extractMetadata(content);
      } catch (error) {
        // Datei existiert nicht - Update nötig
        Logger.debug('Lokale Datei existiert nicht - Update erforderlich');
        return true;
      }

      // Wenn keine Metadaten vorhanden sind, muss synchronisiert werden
      if (!localMetadata || !localMetadata.lastSync) {
        Logger.debug('Keine Sync-Metadaten gefunden - Update erforderlich');
        return true;
      }

      // Hole das neueste Änderungsdatum aus Drive
      const driveModifiedTime = await this.driveService.getLatestModifiedTime(folder.id);

      if (!driveModifiedTime) {
        Logger.debug('Keine Dateien in Drive Ordner');
        return false;
      }

      // Vergleiche Zeitstempel aus Metadaten mit Drive
      const lastSync = localMetadata.lastSync;
      Logger.debug(`Letzter Sync: ${lastSync.toISOString()}, Drive: ${driveModifiedTime.toISOString()}`);
      
      return driveModifiedTime > lastSync;

    } catch (error) {
      Logger.error('Fehler beim Prüfen der Aktualität:', error.message);
      // Im Fehlerfall aktualisieren
      return true;
    }
  }

  /**
   * Verarbeite alle Dateien in einem Ordner
   */
  async processFiles(files, assetsDir, fileSlug) {
    let textContent = '';
    const images = [];

    for (const file of files) {
      try {
        Logger.debug(`  Verarbeite: ${file.name} (${file.mimeType})`);

        // Google Docs
        if (file.mimeType === 'application/vnd.google-apps.document') {
          const content = await this.driveService.downloadDocContent(file.id);
          textContent += `\n\n## ${file.name}\n\n${content}`;
        }
        
        // Google Sheets
        else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
          const content = await this.driveService.downloadSheetContent(file.id);
          textContent += `\n\n## ${file.name}\n\n\`\`\`csv\n${content}\n\`\`\``;
        }
        
        // Bilder
        else if (file.mimeType.startsWith('image/')) {
          const imageBuffer = await this.driveService.downloadImage(file.id);
          const ext = this.getImageExtensionIfNeeded(file.name, file.mimeType);
          const imageName = this.sanitizeFileName(file.name);
          const imagePath = path.join(assetsDir, `${imageName}${ext}`);
          
          await fs.writeFile(imagePath, imageBuffer);
          
          // Pfad vom Markdown (docs/{fileSlug}.md) zum Bild (/assets/{fileSlug}/)
          const relativeImagePath = `/assets/${fileSlug}/${imageName}${ext}`;
          images.push({
            name: file.name,
            path: relativeImagePath
          });
          
          Logger.debug(`    Bild gespeichert: ${imagePath}`);
        }

      } catch (error) {
        Logger.error(`  Fehler beim Verarbeiten von "${file.name}":`, error.message);
      }
    }

    return { textContent, images };
  }

  /**
   * Erstelle einen Branch, committe Änderungen und submitte Merge Request
   */
  async createAndSubmitMergeRequest() {
    try {
      const timestamp = Date.now();
      const branchName = `contentupdate/${new Date(timestamp).toISOString().replace(/[:]/g, '-').replace(/[.]\d+/, '')}`;

      Logger.info('\n--- Erstelle Git Merge Request ---');

      // Erstelle Branch und merke Basis-Branch
      this.baseBranch = await this.gitService.createBranch(branchName);

      // Committe Änderungen
      const commitMessage = `Content Update: ${this.processedFolders.join(', ')}

Automatisch synchronisiert von Google Drive
Bearbeitete Ordner: ${this.processedFolders.length}
Timestamp: ${new Date(timestamp).toISOString()}`;

      const hasChanges = await this.gitService.commitChanges(commitMessage);

      if (!hasChanges) {
        Logger.info('Keine Git-Änderungen zum Pushen');
        await this.gitService.returnToMain();
        return;
      }

      // Pushe Branch
      await this.gitService.pushBranch(branchName);

      // Erstelle Merge Request zurück zum Basis-Branch
      const mrTitle = `🤖 Content Update vom ${new Date().toLocaleDateString('de-DE')}`;
      const mrDescription = `## Automatisches Content Update

Dieser Merge Request wurde automatisch erstellt durch das Content-Synchronisations-Skript.

### Geänderte Bereiche
${this.processedFolders.map(f => `- ${f}`).join('\n')}

### Details
- **Source Branch:** \`${branchName}\`
- **Target Branch:** \`${this.baseBranch}\`
- **Zeitstempel:** ${new Date().toISOString()}
- **Anzahl Ordner:** ${this.processedFolders.length}

---
*Generiert von sync-content.js*`;

      await this.gitProviderService.createMergeRequest(branchName, this.baseBranch, mrTitle, mrDescription);

      // Zurück zum Basis-Branch
      await this.gitService.returnToBranch(this.baseBranch);

      Logger.success('\n✓ Merge Request erfolgreich erstellt!');

    } catch (error) {
      Logger.error('Fehler beim Erstellen des Merge Requests:', error.message);
      throw error;
    }
  }

  /**
   * Hilfsfunktion: Bereinige Ordnernamen für URLs
   */
  sanitizeFolderName(name) {
    return name
      .toLowerCase()
      .replace(/[^a-zA-Z0-9\/]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Hilfsfunktion: Bereinige Dateinamen
   */
  sanitizeFileName(name) {
    return name
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/\s+/g, '_');
  }

  /**
   * Hilfsfunktion: Ermittle Dateiendung für Bild
   */
  getImageExtension(mimeType) {
    const extensions = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg'
    };
    return extensions[mimeType] || '.jpg';
  }

  /**
   * Hilfsfunktion: Ermittle Dateiendung nur, wenn der Dateiname noch keine passende hat
   * Vermeidet doppelte Endungen wie "Felix.jpg.jpg"
   */
  getImageExtensionIfNeeded(fileName, mimeType) {
    
    // Liste aller bekannten Bild-Endungen
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    
    // Prüfe ob der Dateiname bereits mit einer Bild-Endung endet
    const lowerFileName = fileName.toLowerCase();
    for (const ext of imageExtensions) {
      if (lowerFileName.endsWith(ext)) {
        // Dateiname hat bereits eine Bild-Endung - keine weitere hinzufügen
        return '';
      }
    }
    
    // Keine bekannte Endung gefunden - füge die passende hinzu
    return this.getImageExtension(mimeType);;
  }
}

// ========================================
// Hauptprogramm
// ========================================

async function main() {
  try {
    // Erstelle Synchronizer-Instanz
    const synchronizer = new ContentSynchronizer(CONFIG);

    // Starte Synchronisation
    await synchronizer.sync();

    process.exit(0);
  } catch (error) {
    Logger.error('\n❌ Synchronisation fehlgeschlagen:', error.message);
    Logger.debug(error.stack);
    process.exit(1);
  }
}

// Starte das Skript
main();
