/**
 * sync-content.js
 * 
 * Automatisierungsskript zur Synchronisierung von Inhalten aus Google Drive
 * mit einem VitePress-Repository auf GitLab.
 * 
 * Autor: GitHub Copilot Cloud Agent
 * Sprache: Deutsch (Kommentare)
 */

import 'dotenv/config';
import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import simpleGit from 'simple-git';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

// ================================
// Konfiguration aus Umgebungsvariablen
// ================================

const CONFIG = {
  // Google Drive Konfiguration
  driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
  googleApiKey: process.env.GOOGLE_API_KEY,
  
  // Gemini API Konfiguration
  geminiApiKey: process.env.GEMINI_API_KEY,
  
  // GitLab Konfiguration
  gitlabUrl: process.env.GITLAB_URL || 'https://gitlab.com',
  gitlabProjectId: process.env.GITLAB_PROJECT_ID,
  gitlabToken: process.env.GITLAB_TOKEN,
  
  // Git Konfiguration
  gitUserName: process.env.GIT_USER_NAME || 'Content Bot',
  gitUserEmail: process.env.GIT_USER_EMAIL || 'bot@example.com',
  
  // VitePress Pfade
  srcPath: process.env.VITEPRESS_SRC_PATH || 'src',
  publicPath: process.env.VITEPRESS_PUBLIC_PATH || 'public/assets',
};

// ================================
// Validierung der Konfiguration
// ================================

/**
 * Überprüft, ob alle erforderlichen Umgebungsvariablen gesetzt sind.
 * @throws {Error} Wenn eine erforderliche Variable fehlt.
 */
function validateConfig() {
  const requiredVars = [
    'GOOGLE_DRIVE_FOLDER_ID',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'GITLAB_PROJECT_ID',
    'GITLAB_TOKEN',
  ];
  
  const missing = requiredVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0) {
    throw new Error(`Fehlende Umgebungsvariablen: ${missing.join(', ')}`);
  }
}

// ================================
// Google Drive API Initialisierung
// ================================

/**
 * Initialisiert die Google Drive API mit API-Schlüssel.
 * @returns {google.drive_v3.Drive} Die initialisierte Drive API Instanz.
 */
function initDriveApi() {
  return google.drive({
    version: 'v3',
    auth: CONFIG.googleApiKey,
  });
}

/**
 * Initialisiert die Google Gemini AI.
 * @returns {GoogleGenerativeAI} Die initialisierte Gemini AI Instanz.
 */
function initGeminiAI() {
  return new GoogleGenerativeAI(CONFIG.geminiApiKey);
}

// ================================
// Hilfsfunktionen
// ================================

/**
 * Formatiert ein Datum als ISO-String für Metadaten.
 * @param {string|Date} date - Das zu formatierende Datum.
 * @returns {string} Das formatierte Datum als ISO-String.
 */
function formatDate(date) {
  return new Date(date).toISOString();
}

/**
 * Erstellt einen sicheren Dateinamen aus einem Google Drive Ordnernamen.
 * @param {string} name - Der ursprüngliche Name.
 * @returns {string} Der bereinigte Dateiname.
 */
function sanitizeName(name) {
  return name
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Extrahiert Metadaten aus einer bestehenden Markdown-Datei.
 * @param {string} content - Der Inhalt der Markdown-Datei.
 * @returns {Object|null} Die extrahierten Metadaten oder null.
 */
function extractMetadata(content) {
  // Suche nach verstecktem Metadaten-Block am Ende der Datei
  const metaMatch = content.match(/<!--\s*SYNC_META:\s*({.*?})\s*-->/s);
  if (metaMatch) {
    try {
      return JSON.parse(metaMatch[1]);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Generiert einen Metadaten-Block für die Markdown-Datei.
 * @param {Object} meta - Die Metadaten.
 * @returns {string} Der formatierte Metadaten-Block.
 */
function generateMetaBlock(meta) {
  return `\n\n<!-- SYNC_META: ${JSON.stringify(meta)} -->`;
}

// ================================
// Google Drive Funktionen
// ================================

/**
 * Ruft alle Unterordner eines Google Drive Ordners ab.
 * @param {google.drive_v3.Drive} drive - Die Drive API Instanz.
 * @param {string} parentFolderId - Die ID des übergeordneten Ordners.
 * @returns {Promise<Array>} Liste der Unterordner.
 */
async function getSubfolders(drive, parentFolderId) {
  try {
    const response = await drive.files.list({
      q: `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'name',
    });
    
    return response.data.files || [];
  } catch (error) {
    console.error('Fehler beim Abrufen der Unterordner:', error.message);
    throw error;
  }
}

/**
 * Ruft alle Dateien eines Google Drive Ordners ab.
 * @param {google.drive_v3.Drive} drive - Die Drive API Instanz.
 * @param {string} folderId - Die ID des Ordners.
 * @returns {Promise<Array>} Liste der Dateien.
 */
async function getFolderContents(drive, folderId) {
  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime)',
      orderBy: 'modifiedTime desc',
    });
    
    return response.data.files || [];
  } catch (error) {
    console.error('Fehler beim Abrufen der Ordnerinhalte:', error.message);
    throw error;
  }
}

/**
 * Lädt den Inhalt eines Google Docs als Text herunter.
 * @param {google.drive_v3.Drive} drive - Die Drive API Instanz.
 * @param {string} fileId - Die ID der Datei.
 * @returns {Promise<string>} Der Textinhalt des Dokuments.
 */
async function downloadDocAsText(drive, fileId) {
  try {
    const response = await drive.files.export({
      fileId: fileId,
      mimeType: 'text/plain',
    });
    
    return response.data;
  } catch (error) {
    console.error('Fehler beim Herunterladen des Dokuments:', error.message);
    throw error;
  }
}

/**
 * Lädt den Inhalt eines Google Sheets als CSV herunter.
 * @param {google.drive_v3.Drive} drive - Die Drive API Instanz.
 * @param {string} fileId - Die ID der Datei.
 * @returns {Promise<string>} Der CSV-Inhalt des Spreadsheets.
 */
async function downloadSheetAsCsv(drive, fileId) {
  try {
    const response = await drive.files.export({
      fileId: fileId,
      mimeType: 'text/csv',
    });
    
    return response.data;
  } catch (error) {
    console.error('Fehler beim Herunterladen des Spreadsheets:', error.message);
    throw error;
  }
}

/**
 * Lädt ein Bild aus Google Drive herunter.
 * @param {google.drive_v3.Drive} drive - Die Drive API Instanz.
 * @param {string} fileId - Die ID der Datei.
 * @param {string} destPath - Der Zielpfad für die Datei.
 */
async function downloadImage(drive, fileId, destPath) {
  try {
    // Stelle sicher, dass der Zielordner existiert
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    
    const response = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    
    const dest = createWriteStream(destPath);
    await pipeline(response.data, dest);
    
    console.log(`  → Bild heruntergeladen: ${destPath}`);
  } catch (error) {
    console.error('Fehler beim Herunterladen des Bildes:', error.message);
    throw error;
  }
}

// ================================
// KI-Transformation
// ================================

/**
 * Transformiert Rohinhalte mit Google Gemini AI.
 * @param {GoogleGenerativeAI} genAI - Die Gemini AI Instanz.
 * @param {string} rawContent - Der rohe Textinhalt.
 * @param {string} existingContent - Der bestehende Markdown-Inhalt (falls vorhanden).
 * @param {Array<string>} imageNames - Liste der verfügbaren Bildnamen.
 * @returns {Promise<string>} Der transformierte Markdown-Inhalt.
 */
async function transformWithAI(genAI, rawContent, existingContent, imageNames) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  
  const systemPrompt = `Du bist ein Redakteur. Wandle diesen Text in sauberes Markdown für VitePress um. 
Korrigiere Rechtschreibung und Grammatik. 
Erstelle einen YAML-Frontmatter-Block mit title (aus dem Inhalt) und description.
Füge die Bilder an passenden Stellen ein, wenn der Text Platzhalter enthält, oder am Ende.
Erstelle auch eine ca. 100 Wörter lange Zusammenfassung als TL;DR Block am Anfang.
Nutze gerade auch den Inhalt der aktuellen .md-Datei und versuche Struktur und bestehenden Inhalt nur zu ergänzen durch den neuen Inhalt.
Arbeite mit Überschriften und Navigation.

Verfügbare Bilder: ${imageNames.join(', ')}

Bestehender Inhalt:
${existingContent || '(Kein bestehender Inhalt)'}

Neuer Rohinhalt:
${rawContent}`;

  try {
    const result = await model.generateContent(systemPrompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('Fehler bei der KI-Transformation:', error.message);
    throw error;
  }
}

// ================================
// Dateioperationen
// ================================

/**
 * Liest den Inhalt einer lokalen Markdown-Datei.
 * @param {string} filePath - Der Pfad zur Datei.
 * @returns {Promise<string|null>} Der Inhalt oder null, wenn nicht vorhanden.
 */
async function readLocalFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Schreibt Inhalt in eine lokale Datei.
 * @param {string} filePath - Der Pfad zur Datei.
 * @param {string} content - Der zu schreibende Inhalt.
 */
async function writeLocalFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Prüft, ob eine lokale Datei existiert.
 * @param {string} filePath - Der Pfad zur Datei.
 * @returns {Promise<boolean>} True, wenn die Datei existiert.
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ================================
// Git-Operationen
// ================================

/**
 * Initialisiert Git mit den konfigurierten Benutzerinformationen.
 * @param {string} repoPath - Der Pfad zum Repository.
 * @returns {SimpleGit} Die initialisierte Git-Instanz.
 */
async function initGit(repoPath) {
  const git = simpleGit(repoPath);
  
  await git.addConfig('user.name', CONFIG.gitUserName);
  await git.addConfig('user.email', CONFIG.gitUserEmail);
  
  return git;
}

/**
 * Erstellt einen neuen Branch für die Content-Updates.
 * @param {SimpleGit} git - Die Git-Instanz.
 * @returns {Promise<string>} Der Name des neuen Branches.
 */
async function createContentBranch(git) {
  const timestamp = Date.now();
  const branchName = `content-update-${timestamp}`;
  
  // Hole die neuesten Änderungen
  await git.fetch();
  
  // Wechsle zum main-Branch und erstelle einen neuen Branch
  await git.checkout('main');
  await git.pull('origin', 'main');
  await git.checkoutLocalBranch(branchName);
  
  return branchName;
}

/**
 * Führt einen Commit für alle geänderten Dateien durch.
 * @param {SimpleGit} git - Die Git-Instanz.
 * @param {string} message - Die Commit-Nachricht.
 */
async function commitChanges(git, message) {
  await git.add('.');
  await git.commit(message);
}

/**
 * Pusht den Branch zum Remote-Repository.
 * @param {SimpleGit} git - Die Git-Instanz.
 * @param {string} branchName - Der Name des Branches.
 */
async function pushBranch(git, branchName) {
  await git.push('origin', branchName, ['--set-upstream']);
}

// ================================
// GitLab API Funktionen
// ================================

/**
 * Erstellt einen Merge Request in GitLab.
 * @param {string} branchName - Der Name des Source-Branches.
 * @param {string} title - Der Titel des Merge Requests.
 * @param {string} description - Die Beschreibung des Merge Requests.
 * @returns {Promise<Object>} Die Antwort der GitLab API.
 */
async function createMergeRequest(branchName, title, description) {
  const url = `${CONFIG.gitlabUrl}/api/v4/projects/${CONFIG.gitlabProjectId}/merge_requests`;
  
  try {
    const response = await axios.post(url, {
      source_branch: branchName,
      target_branch: 'main',
      title: `Draft: ${title}`,
      description: description,
      labels: 'Content-Update,Draft',
    }, {
      headers: {
        'PRIVATE-TOKEN': CONFIG.gitlabToken,
        'Content-Type': 'application/json',
      },
    });
    
    console.log(`✅ Merge Request erstellt: ${response.data.web_url}`);
    return response.data;
  } catch (error) {
    console.error('Fehler beim Erstellen des Merge Requests:', error.response?.data || error.message);
    throw error;
  }
}

// ================================
// Hauptverarbeitungslogik
// ================================

/**
 * Verarbeitet einen einzelnen Drive-Ordner.
 * @param {google.drive_v3.Drive} drive - Die Drive API Instanz.
 * @param {GoogleGenerativeAI} genAI - Die Gemini AI Instanz.
 * @param {Object} folder - Die Ordnerinformationen.
 * @param {string} repoPath - Der Pfad zum Repository.
 * @returns {Promise<boolean>} True, wenn Änderungen vorgenommen wurden.
 */
async function processFolder(drive, genAI, folder, repoPath) {
  const folderSlug = sanitizeName(folder.name);
  const localMdPath = path.join(repoPath, CONFIG.srcPath, folderSlug, 'index.md');
  const localAssetsPath = path.join(repoPath, CONFIG.publicPath, folderSlug);
  
  console.log(`\n📁 Verarbeite Ordner: ${folder.name} (${folderSlug})`);
  
  // Lade den bestehenden lokalen Inhalt
  const existingContent = await readLocalFile(localMdPath);
  const existingMeta = existingContent ? extractMetadata(existingContent) : null;
  
  // Prüfe das letzte Änderungsdatum
  const driveModTime = new Date(folder.modifiedTime);
  const localModTime = existingMeta?.lastSync ? new Date(existingMeta.lastSync) : null;
  
  // Vergleiche die Änderungsdaten
  if (localModTime && driveModTime <= localModTime) {
    console.log(`  ⏭️  Keine Änderungen (Drive: ${driveModTime.toISOString()}, Lokal: ${localModTime.toISOString()})`);
    return false;
  }
  
  console.log(`  🔄 Änderungen gefunden - wird aktualisiert...`);
  
  // Hole alle Dateien aus dem Ordner
  const files = await getFolderContents(drive, folder.id);
  
  // Kategorisiere die Dateien
  const docs = files.filter(f => f.mimeType === 'application/vnd.google-apps.document');
  const sheets = files.filter(f => f.mimeType === 'application/vnd.google-apps.spreadsheet');
  const images = files.filter(f => f.mimeType.startsWith('image/'));
  
  console.log(`  📄 Dokumente: ${docs.length}, 📊 Tabellen: ${sheets.length}, 🖼️  Bilder: ${images.length}`);
  
  // Sammle den Rohinhalt
  let rawContent = '';
  const processedFiles = [];
  
  // Verarbeite Dokumente
  for (const doc of docs) {
    const content = await downloadDocAsText(drive, doc.id);
    rawContent += `\n\n## ${doc.name}\n\n${content}`;
    processedFiles.push({ id: doc.id, name: doc.name, modifiedTime: doc.modifiedTime });
  }
  
  // Verarbeite Tabellen
  for (const sheet of sheets) {
    const csvContent = await downloadSheetAsCsv(drive, sheet.id);
    rawContent += `\n\n## ${sheet.name} (Tabelle)\n\n\`\`\`csv\n${csvContent}\n\`\`\``;
    processedFiles.push({ id: sheet.id, name: sheet.name, modifiedTime: sheet.modifiedTime });
  }
  
  // Lade Bilder herunter
  const imageNames = [];
  for (const image of images) {
    const ext = image.mimeType.split('/')[1] || 'png';
    const imageName = sanitizeName(image.name.replace(/\.[^/.]+$/, '')) + '.' + ext;
    const imagePath = path.join(localAssetsPath, imageName);
    
    await downloadImage(drive, image.id, imagePath);
    imageNames.push(`/assets/${folderSlug}/${imageName}`);
    processedFiles.push({ id: image.id, name: image.name, modifiedTime: image.modifiedTime });
  }
  
  // Wenn kein Inhalt gefunden wurde
  if (!rawContent.trim() && images.length === 0) {
    console.log(`  ⚠️  Ordner ist leer oder hat keine unterstützten Dateien`);
    return false;
  }
  
  // Transformiere den Inhalt mit der KI
  console.log(`  🤖 KI-Transformation wird durchgeführt...`);
  let transformedContent;
  
  try {
    transformedContent = await transformWithAI(
      genAI,
      rawContent || '(Nur Bilder im Ordner)',
      existingContent?.replace(/<!--\s*SYNC_META:.*?-->/s, '') || null,
      imageNames
    );
  } catch (error) {
    console.error(`  ❌ KI-Transformation fehlgeschlagen: ${error.message}`);
    // Fallback: Einfache Markdown-Formatierung
    transformedContent = `---
title: ${folder.name}
description: Automatisch synchronisierter Inhalt aus Google Drive
---

# ${folder.name}

${rawContent}

${imageNames.length > 0 ? '## Bilder\n\n' + imageNames.map(img => `![](${img})`).join('\n\n') : ''}
`;
  }
  
  // Füge Metadaten hinzu
  const meta = {
    lastSync: new Date().toISOString(),
    driveModTime: folder.modifiedTime,
    files: processedFiles.map(f => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime })),
  };
  
  const finalContent = transformedContent + generateMetaBlock(meta);
  
  // Speichere die Datei
  await writeLocalFile(localMdPath, finalContent);
  console.log(`  ✅ Gespeichert: ${localMdPath}`);
  
  return true;
}

/**
 * Hauptfunktion des Synchronisierungsskripts.
 */
async function main() {
  console.log('🚀 Content-Synchronisierung gestartet\n');
  console.log('='.repeat(50));
  
  try {
    // Validiere die Konfiguration
    validateConfig();
    
    // Initialisiere die APIs
    const drive = initDriveApi();
    const genAI = initGeminiAI();
    
    // Ermittle den Repository-Pfad (aktuelles Verzeichnis)
    const repoPath = process.cwd();
    console.log(`📂 Repository-Pfad: ${repoPath}`);
    
    // Initialisiere Git
    const git = await initGit(repoPath);
    
    // Hole alle Unterordner aus dem Hauptordner
    console.log(`\n📂 Lade Ordner aus Google Drive...`);
    const folders = await getSubfolders(drive, CONFIG.driveFolderId);
    console.log(`   Gefunden: ${folders.length} Ordner`);
    
    if (folders.length === 0) {
      console.log('\n⚠️  Keine Unterordner gefunden. Beende.');
      return;
    }
    
    // Verarbeite jeden Ordner
    let changesDetected = false;
    const updatedFolders = [];
    
    for (const folder of folders) {
      const hasChanges = await processFolder(drive, genAI, folder, repoPath);
      if (hasChanges) {
        changesDetected = true;
        updatedFolders.push(folder.name);
      }
    }
    
    // Wenn Änderungen vorgenommen wurden, erstelle einen Branch und Merge Request
    if (changesDetected) {
      console.log('\n' + '='.repeat(50));
      console.log('📤 Änderungen werden gepusht...\n');
      
      // Erstelle einen neuen Branch
      const branchName = await createContentBranch(git);
      console.log(`  🌿 Branch erstellt: ${branchName}`);
      
      // Commit und Push
      const commitMessage = `Content-Update: ${updatedFolders.join(', ')}`;
      await commitChanges(git, commitMessage);
      console.log(`  💾 Commit: ${commitMessage}`);
      
      await pushBranch(git, branchName);
      console.log(`  ⬆️  Branch gepusht`);
      
      // Erstelle einen Merge Request
      await createMergeRequest(
        branchName,
        `Content-Update: ${new Date().toLocaleDateString('de-DE')}`,
        `## Automatische Content-Synchronisierung\n\n### Aktualisierte Ordner:\n${updatedFolders.map(f => `- ${f}`).join('\n')}\n\n*Automatisch erstellt von sync-content.js*`
      );
      
      console.log('\n✅ Synchronisierung abgeschlossen!\n');
    } else {
      console.log('\n' + '='.repeat(50));
      console.log('ℹ️  Keine Änderungen gefunden. Kein Merge Request erstellt.\n');
    }
    
  } catch (error) {
    console.error('\n❌ Fehler bei der Synchronisierung:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Starte die Hauptfunktion
main();
