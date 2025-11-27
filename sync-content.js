/**
 * sync-content.js
 * 
 * Automatisierungsskript zur Synchronisation von Google Drive Inhalten
 * mit einem VitePress Repository für GitLab Pages.
 * 
 * Funktionen:
 * - Intelligenter Abgleich basierend auf Änderungszeitstempel
 * - Download von Google Docs, Sheets und Bildern
 * - KI-Transformation mit Google Gemini API
 * - Automatische Git-Operationen und GitLab MR-Erstellung
 */

import 'dotenv/config';
import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import simpleGit from 'simple-git';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// ES Module Workaround für __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// KONFIGURATION
// ============================================================================

const CONFIG = {
  // Google Drive Einstellungen
  googleApiKey: process.env.GOOGLE_API_KEY,
  driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
  
  // Gemini AI Einstellungen
  geminiApiKey: process.env.GEMINI_API_KEY,
  
  // GitLab Einstellungen
  gitlabUrl: process.env.GITLAB_URL || 'https://gitlab.com',
  gitlabProjectId: process.env.GITLAB_PROJECT_ID,
  gitlabAccessToken: process.env.GITLAB_ACCESS_TOKEN,
  gitlabTargetBranch: process.env.GITLAB_TARGET_BRANCH || 'main',
  
  // VitePress Pfade (relativ zum Repository-Root)
  vitepressSrcPath: process.env.VITEPRESS_SRC_PATH || 'src',
  vitepressAssetsPath: process.env.VITEPRESS_ASSETS_PATH || 'public/assets',
};

// System-Prompt für die KI-Transformation
const AI_SYSTEM_PROMPT = `Du bist ein Redakteur. Wandle diesen Text in sauberes Markdown für VitePress um. 
Korrigiere Rechtschreibung und Grammatik. 
Erstelle einen YAML-Frontmatter-Block mit title (aus dem Inhalt) und description. 
Füge die Bilder an passenden Stellen ein, wenn der Text Platzhalter enthält, oder am Ende. 
Erstelle auch eine ca. 100 Wörter lange Zusammenfassung als TL;DR Block am Anfang. 
Nutze gerade auch den Inhalt der aktuellen .md-Datei und versuche Struktur und bestehenden Inhalt nur zu ergänzen durch den neuen Inhalt. 
Arbeite mit Überschriften und Navigation.
Antworte NUR mit dem Markdown-Inhalt, ohne zusätzliche Erklärungen.`;

// ============================================================================
// GOOGLE DRIVE API INITIALISIERUNG
// ============================================================================

/**
 * Initialisiert die Google Drive API mit API Key für öffentliche Ordner
 * @returns {google.drive_v3.Drive} Drive API Instanz
 */
function initDriveApi() {
  return google.drive({
    version: 'v3',
    auth: CONFIG.googleApiKey,
  });
}

/**
 * Initialisiert die Google Gemini AI API
 * @returns {GoogleGenerativeAI} Gemini AI Instanz
 */
function initGeminiAI() {
  return new GoogleGenerativeAI(CONFIG.geminiApiKey);
}

// ============================================================================
// DRIVE OPERATIONEN
// ============================================================================

/**
 * Listet alle Unterordner im Hauptordner auf
 * @param {google.drive_v3.Drive} drive - Drive API Instanz
 * @returns {Promise<Array>} Liste der Unterordner mit ID, Name und modifiedTime
 */
async function listSubfolders(drive) {
  try {
    const response = await drive.files.list({
      q: `'${CONFIG.driveFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'name',
    });
    
    return response.data.files || [];
  } catch (error) {
    console.error('Fehler beim Auflisten der Unterordner:', error.message);
    throw error;
  }
}

/**
 * Listet alle Dateien in einem Ordner auf
 * @param {google.drive_v3.Drive} drive - Drive API Instanz
 * @param {string} folderId - ID des Ordners
 * @returns {Promise<Array>} Liste der Dateien
 */
async function listFilesInFolder(drive, folderId) {
  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime)',
      orderBy: 'name',
    });
    
    return response.data.files || [];
  } catch (error) {
    console.error('Fehler beim Auflisten der Dateien:', error.message);
    throw error;
  }
}

/**
 * Ermittelt das neueste Änderungsdatum aus einer Liste von Dateien
 * @param {Array} files - Liste der Dateien
 * @returns {Date|null} Das neueste Änderungsdatum oder null
 */
function getLatestModifiedTime(files) {
  if (!files || files.length === 0) return null;
  
  const dates = files.map(file => new Date(file.modifiedTime));
  return new Date(Math.max(...dates));
}

/**
 * Lädt ein Google Doc als Text herunter
 * @param {google.drive_v3.Drive} drive - Drive API Instanz
 * @param {string} fileId - ID der Datei
 * @returns {Promise<string>} Textinhalt des Dokuments
 */
async function downloadGoogleDoc(drive, fileId) {
  try {
    const response = await drive.files.export({
      fileId: fileId,
      mimeType: 'text/plain',
    });
    
    return response.data;
  } catch (error) {
    console.error('Fehler beim Herunterladen des Google Docs:', error.message);
    throw error;
  }
}

/**
 * Lädt ein Google Sheet als CSV herunter
 * @param {google.drive_v3.Drive} drive - Drive API Instanz
 * @param {string} fileId - ID der Datei
 * @returns {Promise<string>} CSV-Inhalt der Tabelle
 */
async function downloadGoogleSheet(drive, fileId) {
  try {
    const response = await drive.files.export({
      fileId: fileId,
      mimeType: 'text/csv',
    });
    
    return response.data;
  } catch (error) {
    console.error('Fehler beim Herunterladen des Google Sheets:', error.message);
    throw error;
  }
}

/**
 * Lädt ein Bild herunter und speichert es lokal
 * @param {google.drive_v3.Drive} drive - Drive API Instanz
 * @param {string} fileId - ID der Datei
 * @param {string} fileName - Name der Datei
 * @param {string} folderName - Name des Zielordners
 * @returns {Promise<string>} Relativer Pfad zum gespeicherten Bild
 */
async function downloadImage(drive, fileId, fileName, folderName) {
  try {
    const response = await drive.files.get({
      fileId: fileId,
      alt: 'media',
    }, {
      responseType: 'arraybuffer',
    });
    
    // Zielverzeichnis erstellen
    const assetsDir = path.join(__dirname, CONFIG.vitepressAssetsPath, folderName);
    await fs.mkdir(assetsDir, { recursive: true });
    
    // Datei speichern
    const filePath = path.join(assetsDir, fileName);
    await fs.writeFile(filePath, Buffer.from(response.data));
    
    // Relativen Pfad für Markdown zurückgeben
    return `/${CONFIG.vitepressAssetsPath}/${folderName}/${fileName}`;
  } catch (error) {
    console.error('Fehler beim Herunterladen des Bildes:', error.message);
    throw error;
  }
}

// ============================================================================
// LOKALE DATEIOPERATIONEN
// ============================================================================

/**
 * Liest die lokale Markdown-Datei und extrahiert Meta-Informationen
 * @param {string} folderName - Name des Ordners
 * @returns {Promise<{content: string, metadata: Object}|null>} Inhalt und Metadaten oder null
 */
async function readLocalMarkdown(folderName) {
  const filePath = path.join(__dirname, CONFIG.vitepressSrcPath, folderName, 'index.md');
  
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Extrahiere Meta-Informationen aus HTML-Kommentaren
    const metadataMatch = content.match(/<!--\s*SYNC_METADATA\s*([\s\S]*?)\s*-->/);
    let metadata = {};
    
    if (metadataMatch) {
      try {
        metadata = JSON.parse(metadataMatch[1]);
      } catch {
        // Metadata parsing fehlgeschlagen, ignorieren
      }
    }
    
    return { content, metadata };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // Datei existiert nicht
    }
    throw error;
  }
}

/**
 * Speichert die Markdown-Datei mit Meta-Informationen
 * @param {string} folderName - Name des Ordners
 * @param {string} content - Markdown-Inhalt
 * @param {Object} metadata - Meta-Informationen
 */
async function saveLocalMarkdown(folderName, content, metadata) {
  const dirPath = path.join(__dirname, CONFIG.vitepressSrcPath, folderName);
  const filePath = path.join(dirPath, 'index.md');
  
  // Verzeichnis erstellen
  await fs.mkdir(dirPath, { recursive: true });
  
  // Meta-Informationen als HTML-Kommentar anhängen (wird nicht gerendert)
  const metadataComment = `\n\n<!-- SYNC_METADATA\n${JSON.stringify(metadata, null, 2)}\n-->`;
  
  await fs.writeFile(filePath, content + metadataComment, 'utf-8');
}

/**
 * Listet alle lokalen Markdown-Ordner auf
 * @returns {Promise<string[]>} Liste der Ordnernamen
 */
async function listLocalMarkdownFolders() {
  const srcPath = path.join(__dirname, CONFIG.vitepressSrcPath);
  
  try {
    const entries = await fs.readdir(srcPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// ============================================================================
// KI-TRANSFORMATION
// ============================================================================

/**
 * Transformiert den Rohtext mit Google Gemini AI
 * @param {GoogleGenerativeAI} genAI - Gemini AI Instanz
 * @param {string} rawText - Roher Text aus Google Drive
 * @param {string} existingContent - Bestehender Markdown-Inhalt (optional)
 * @param {string[]} imagePaths - Pfade zu den Bildern
 * @returns {Promise<string>} Transformierter Markdown-Text
 */
async function transformWithAI(genAI, rawText, existingContent, imagePaths) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    // Prompt zusammenstellen
    let userPrompt = `Hier ist der neue Text aus Google Drive:\n\n${rawText}\n\n`;
    
    if (existingContent) {
      userPrompt += `Hier ist der bestehende Markdown-Inhalt:\n\n${existingContent}\n\n`;
    }
    
    if (imagePaths && imagePaths.length > 0) {
      userPrompt += `Verfügbare Bilder (bitte an passenden Stellen einfügen):\n`;
      imagePaths.forEach(imgPath => {
        userPrompt += `- ![Bild](${imgPath})\n`;
      });
    }
    
    const result = await model.generateContent([
      { text: AI_SYSTEM_PROMPT },
      { text: userPrompt },
    ]);
    
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('Fehler bei der KI-Transformation:', error.message);
    throw error;
  }
}

// ============================================================================
// GIT OPERATIONEN
// ============================================================================

/**
 * Führt Git-Operationen durch und erstellt einen neuen Branch
 * @returns {Promise<{git: SimpleGit, branchName: string, hasChanges: boolean}>}
 */
async function prepareGitBranch() {
  const git = simpleGit(__dirname);
  
  // Aktuellen Status prüfen
  const status = await git.status();
  
  if (status.files.length === 0) {
    return { git, branchName: null, hasChanges: false };
  }
  
  // Neuen Branch erstellen (Git-kompatibles Format: lowercase, keine Doppelpunkte)
  const timestamp = new Date().toISOString().replace(/[:.T]/g, '-').toLowerCase().slice(0, 19);
  const branchName = `content-update-${timestamp}`;
  
  await git.checkoutLocalBranch(branchName);
  
  return { git, branchName, hasChanges: true };
}

/**
 * Führt Commit und Push durch
 * @param {SimpleGit} git - Git-Instanz
 * @param {string} message - Commit-Nachricht
 */
async function commitAndPush(git, message) {
  // Nur die relevanten VitePress-Verzeichnisse hinzufügen
  await git.add([CONFIG.vitepressSrcPath, CONFIG.vitepressAssetsPath]);
  await git.commit(message);
  await git.push('origin', 'HEAD');
}

// ============================================================================
// GITLAB API
// ============================================================================

/**
 * Erstellt einen Merge Request in GitLab
 * @param {string} sourceBranch - Quell-Branch
 * @param {string[]} updatedFolders - Liste der aktualisierten Ordner
 * @returns {Promise<Object>} Merge Request Daten
 */
async function createMergeRequest(sourceBranch, updatedFolders) {
  const title = `[Draft] Content-Update: ${updatedFolders.join(', ')}`;
  const description = `
## Automatisches Content-Update

Dieses MR wurde automatisch erstellt durch das Sync-Script.

### Aktualisierte Seiten:
${updatedFolders.map(f => `- ${f}`).join('\n')}

### Quelle
Google Drive Synchronisation

---
*Erstellt am: ${new Date().toISOString()}*
  `.trim();
  
  try {
    const response = await axios.post(
      `${CONFIG.gitlabUrl}/api/v4/projects/${CONFIG.gitlabProjectId}/merge_requests`,
      {
        source_branch: sourceBranch,
        target_branch: CONFIG.gitlabTargetBranch,
        title: title,
        description: description,
        labels: 'Content-Update,Draft',
        draft: true,
      },
      {
        headers: {
          'PRIVATE-TOKEN': CONFIG.gitlabAccessToken,
          'Content-Type': 'application/json',
        },
      }
    );
    
    return response.data;
  } catch (error) {
    console.error('Fehler beim Erstellen des Merge Requests:', error.message);
    throw error;
  }
}

// ============================================================================
// HAUPTLOGIK
// ============================================================================

/**
 * Prüft ob ein Ordner aktualisiert werden muss
 * @param {Date} driveModifiedTime - Änderungsdatum in Drive
 * @param {Object} localMetadata - Lokale Metadaten
 * @returns {boolean} True wenn Update nötig
 */
function needsUpdate(driveModifiedTime, localMetadata) {
  if (!localMetadata || !localMetadata.lastSync) {
    return true; // Keine lokale Version, Update nötig
  }
  
  const lastSyncTime = new Date(localMetadata.lastSync);
  return driveModifiedTime > lastSyncTime;
}

/**
 * Verarbeitet einen einzelnen Ordner
 * @param {google.drive_v3.Drive} drive - Drive API Instanz
 * @param {GoogleGenerativeAI} genAI - Gemini AI Instanz
 * @param {Object} folder - Ordner-Objekt
 * @returns {Promise<boolean>} True wenn Änderungen vorgenommen wurden
 */
async function processFolder(drive, genAI, folder) {
  console.log(`\n📁 Verarbeite Ordner: ${folder.name}`);
  
  try {
    // Dateien im Ordner auflisten
    const files = await listFilesInFolder(drive, folder.id);
    
    if (files.length === 0) {
      console.log(`   ⚠️  Ordner ist leer, überspringe.`);
      return false;
    }
    
    // Neuestes Änderungsdatum ermitteln
    const driveModifiedTime = getLatestModifiedTime(files);
    
    // Lokale Datei lesen
    const localData = await readLocalMarkdown(folder.name);
    
    // Prüfen ob Update nötig
    if (localData && !needsUpdate(driveModifiedTime, localData.metadata)) {
      console.log(`   ✓ Keine Änderungen (Drive: ${driveModifiedTime.toISOString()}, Lokal: ${localData.metadata.lastSync})`);
      return false;
    }
    
    console.log(`   🔄 Änderungen erkannt, lade Inhalte herunter...`);
    
    // Inhalte sammeln
    let textContent = '';
    const imagePaths = [];
    const processedFiles = [];
    
    for (const file of files) {
      console.log(`   📄 Verarbeite: ${file.name} (${file.mimeType})`);
      
      if (file.mimeType === 'application/vnd.google-apps.document') {
        // Google Doc
        const docContent = await downloadGoogleDoc(drive, file.id);
        textContent += `\n\n## ${file.name}\n\n${docContent}`;
        processedFiles.push({ name: file.name, type: 'doc', id: file.id });
        
      } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
        // Google Sheet
        const sheetContent = await downloadGoogleSheet(drive, file.id);
        textContent += `\n\n## Tabelle: ${file.name}\n\n\`\`\`csv\n${sheetContent}\n\`\`\``;
        processedFiles.push({ name: file.name, type: 'sheet', id: file.id });
        
      } else if (file.mimeType.startsWith('image/')) {
        // Bilder
        const imagePath = await downloadImage(drive, file.id, file.name, folder.name);
        imagePaths.push(imagePath);
        processedFiles.push({ name: file.name, type: 'image', id: file.id, path: imagePath });
      }
    }
    
    if (!textContent.trim()) {
      console.log(`   ⚠️  Keine Textinhalte gefunden, überspringe.`);
      return false;
    }
    
    // KI-Transformation
    console.log(`   🤖 Transformiere mit KI...`);
    const existingContent = localData ? localData.content.replace(/<!--\s*SYNC_METADATA[\s\S]*?-->/, '').trim() : '';
    const transformedContent = await transformWithAI(genAI, textContent, existingContent, imagePaths);
    
    // Metadaten erstellen
    const metadata = {
      lastSync: new Date().toISOString(),
      driveModifiedTime: driveModifiedTime.toISOString(),
      driveFolderId: folder.id,
      processedFiles: processedFiles,
    };
    
    // Speichern
    console.log(`   💾 Speichere Markdown...`);
    await saveLocalMarkdown(folder.name, transformedContent, metadata);
    
    console.log(`   ✅ Erfolgreich aktualisiert!`);
    return true;
    
  } catch (error) {
    console.error(`   ❌ Fehler bei Ordner ${folder.name}:`, error.message);
    return false;
  }
}

/**
 * Prüft auf gelöschte Ordner in Drive
 * @param {string[]} driveFolderNames - Namen der Drive-Ordner
 * @param {string[]} localFolderNames - Namen der lokalen Ordner
 * @returns {string[]} Liste der gelöschten Ordner
 */
function findDeletedFolders(driveFolderNames, localFolderNames) {
  return localFolderNames.filter(local => !driveFolderNames.includes(local));
}

/**
 * Hauptfunktion des Sync-Scripts
 */
async function main() {
  console.log('🚀 Starte Google Drive zu VitePress Synchronisation\n');
  console.log('='.repeat(60));
  
  // Konfiguration validieren
  const requiredEnvVars = [
    'GOOGLE_API_KEY',
    'GOOGLE_DRIVE_FOLDER_ID',
    'GEMINI_API_KEY',
    'GITLAB_PROJECT_ID',
    'GITLAB_ACCESS_TOKEN',
  ];
  
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.error(`❌ Fehlende Umgebungsvariablen: ${missingVars.join(', ')}`);
    process.exit(1);
  }
  
  try {
    // APIs initialisieren
    console.log('\n📡 Initialisiere APIs...');
    const drive = initDriveApi();
    const genAI = initGeminiAI();
    
    // Ordner aus Drive laden
    console.log('📂 Lade Ordner aus Google Drive...');
    const folders = await listSubfolders(drive);
    console.log(`   Gefunden: ${folders.length} Ordner`);
    
    // Lokale Ordner ermitteln
    const localFolders = await listLocalMarkdownFolders();
    
    // Auf gelöschte Ordner prüfen
    const deletedFolders = findDeletedFolders(
      folders.map(f => f.name),
      localFolders
    );
    
    if (deletedFolders.length > 0) {
      console.log(`\n⚠️  Folgende lokale Ordner existieren nicht mehr in Drive:`);
      deletedFolders.forEach(f => console.log(`   - ${f}`));
    }
    
    // Ordner verarbeiten
    const updatedFolders = [];
    
    for (const folder of folders) {
      const wasUpdated = await processFolder(drive, genAI, folder);
      if (wasUpdated) {
        updatedFolders.push(folder.name);
      }
    }
    
    // Git-Operationen nur wenn Änderungen vorhanden
    if (updatedFolders.length > 0) {
      console.log('\n' + '='.repeat(60));
      console.log('📦 Git-Operationen...');
      
      const { git, branchName, hasChanges } = await prepareGitBranch();
      
      if (hasChanges && branchName) {
        console.log(`   Branch erstellt: ${branchName}`);
        
        await commitAndPush(git, `Content-Update: ${updatedFolders.join(', ')}`);
        console.log(`   Änderungen committed und gepusht.`);
        
        // Merge Request erstellen
        console.log('\n🔀 Erstelle Merge Request...');
        const mr = await createMergeRequest(branchName, updatedFolders);
        console.log(`   ✅ MR erstellt: ${mr.web_url}`);
      }
    } else {
      console.log('\n' + '='.repeat(60));
      console.log('✓ Keine Änderungen erforderlich. Kein Merge Request erstellt.');
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('🎉 Synchronisation abgeschlossen!\n');
    
  } catch (error) {
    console.error('\n❌ Kritischer Fehler:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Script ausführen
main();
