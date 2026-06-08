const path = require('path');
const vscode = require('vscode');

const LEGACY_NOTES_KEY = 'meuBlocoDeNotas.notes';
const ACTIVE_NOTE_KEY = 'meuBlocoDeNotas.activeNoteId';
const SETTINGS_KEY = 'meuBlocoDeNotas.settings';
const NOTES_FOLDER_KEY = 'meuBlocoDeNotas.notesFolder';
const VIEW_ID = 'meuBlocoDeNotas.notesView';

class NotesViewProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.mode = 'list';
    this.messageQueue = Promise.resolve();
  }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    try {
      webviewView.webview.html = await this.getHtml(webviewView.webview);
      this.updateChrome('list');
    } catch (error) {
      webviewView.webview.html = getErrorHtml(error);
    }

    webviewView.webview.onDidReceiveMessage((message) => {
      this.messageQueue = this.messageQueue
        .then(() => this.handleMessage(message))
        .catch((error) => {
          vscode.window.showErrorMessage(`Erro no bloco de notas: ${error.message || String(error)}`);
        });
    });
  }

  async handleMessage(message) {
    if (message.type === 'createNote') {
      await this.createNote();
      return;
    }

    if (message.type === 'selectNote') {
      await this.setActiveNote(message.id, message.title);
      return;
    }

    if (message.type === 'showList') {
      this.updateChrome('list');
      return;
    }

    if (message.type === 'renameNote') {
      await this.renameNote(message.id, message.title);
      return;
    }

    if (message.type === 'saveContent') {
      await this.saveContent(message.id, message.content);
      return;
    }

    if (message.type === 'deleteNote') {
      await this.deleteNote(message.id);
      return;
    }

    if (message.type === 'saveSettings') {
      await this.saveSettings(message.settings);
      return;
    }

    if (message.type === 'selectFolder') {
      await this.selectFolder();
    }
  }

  async createNote() {
    const folder = await this.ensureFolder();

    if (!folder) {
      return;
    }

    const state = await this.getState();
    const fileName = await this.getAvailableFileName(folder, `Nota ${state.notes.length + 1}`);
    const note = { id: fileName, title: basenameWithoutMd(fileName), content: '' };

    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, fileName), Buffer.from('', 'utf8'));
    await this.context.globalState.update(ACTIVE_NOTE_KEY, fileName);
    this.updateChrome('editor', note.title);
    await this.postState({ notes: [note, ...state.notes], activeNoteId: fileName, folderPath: folder.fsPath });
  }

  async setActiveNote(id, title) {
    if (typeof id !== 'string' || !id) {
      return;
    }

    this.updateChrome('editor', title || basenameWithoutMd(id));
    await this.context.globalState.update(ACTIVE_NOTE_KEY, id);
  }

  async renameNote(id, title) {
    const folder = this.getFolderUri();

    if (!folder) {
      return;
    }

    const cleanTitle = normalizeTitle(title);
    const currentId = id;
    const oldUri = vscode.Uri.joinPath(folder, currentId);

    if (!await fileExists(oldUri)) {
      return;
    }

    const oldTitle = basenameWithoutMd(currentId);
    let nextFileName = `${toSafeFileName(cleanTitle)}.md`;

    if (nextFileName !== currentId) {
      nextFileName = await this.getAvailableFileName(folder, cleanTitle, currentId);
      await vscode.workspace.fs.rename(oldUri, vscode.Uri.joinPath(folder, nextFileName), { overwrite: false });
      await this.context.globalState.update(ACTIVE_NOTE_KEY, nextFileName);
    }

    this.updateChrome('editor', cleanTitle || oldTitle);
    await this.postState();
  }

  async saveContent(id, content) {
    const folder = this.getFolderUri();

    if (!folder) {
      return;
    }

    const targetId = id;
    const targetUri = vscode.Uri.joinPath(folder, targetId);

    if (!await fileExists(targetUri)) {
      return;
    }

    try {
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content ?? '', 'utf8'));
    } catch (error) {
      vscode.window.showErrorMessage(`Nao foi possivel salvar a nota "${targetId}": ${error.message || String(error)}`);
    }
  }

  async deleteNote(id) {
    const folder = this.getFolderUri();

    if (!folder) {
      return;
    }

    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, id));
    } catch (error) {
      vscode.window.showErrorMessage(`Nao foi possivel excluir a nota: ${error.message || String(error)}`);
    }

    const state = await this.getState();
    const activeNoteId = state.notes[0]?.id;
    await this.context.globalState.update(ACTIVE_NOTE_KEY, activeNoteId);
    this.updateChrome('list');
    await this.postState({ ...state, activeNoteId });
  }

  async selectFolder() {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Usar esta pasta',
      title: 'Escolha a pasta das notas Markdown'
    });

    if (!selection?.[0]) {
      return;
    }

    await this.context.globalState.update(NOTES_FOLDER_KEY, selection[0].toString());
    await this.migrateLegacyNotes(selection[0]);
    this.updateChrome('list');
    await this.postState();
  }

  async ensureFolder() {
    const folder = this.getFolderUri();

    if (folder) {
      return folder;
    }

    await this.selectFolder();
    return this.getFolderUri();
  }

  getFolderUri() {
    const value = this.context.globalState.get(NOTES_FOLDER_KEY);
    return typeof value === 'string' && value ? vscode.Uri.parse(value) : undefined;
  }

  async getState() {
    const folder = this.getFolderUri();

    if (!folder) {
      return { notes: [], activeNoteId: undefined, folderPath: '' };
    }

    let entries = [];

    try {
      entries = await vscode.workspace.fs.readDirectory(folder);
    } catch {
      return { notes: [], activeNoteId: undefined, folderPath: folder.fsPath };
    }

    const notes = await Promise.all(entries
      .filter(([fileName, fileType]) => fileType === vscode.FileType.File && fileName.toLowerCase().endsWith('.md'))
      .map(async ([fileName]) => {
        const uri = vscode.Uri.joinPath(folder, fileName);
        const [contentBytes, stat] = await Promise.all([
          vscode.workspace.fs.readFile(uri),
          vscode.workspace.fs.stat(uri)
        ]);

        return {
          id: fileName,
          title: basenameWithoutMd(fileName),
          content: Buffer.from(contentBytes).toString('utf8'),
          updatedAt: stat.mtime
        };
      }));

    notes.sort((first, second) => second.updatedAt - first.updatedAt || first.title.localeCompare(second.title));

    const storedActiveId = this.context.globalState.get(ACTIVE_NOTE_KEY);
    const activeNoteId = notes.some((note) => note.id === storedActiveId) ? storedActiveId : notes[0]?.id;

    return { notes, activeNoteId, folderPath: folder.fsPath };
  }

  async postState(state) {
    const nextState = state ?? await this.getState();

    this.view?.webview.postMessage({
      type: 'setState',
      state: nextState,
      settings: this.getSettings()
    });
  }

  openSettings() {
    this.updateChrome('settings');
    this.view?.webview.postMessage({
      type: 'openSettings',
      settings: this.getSettings()
    });
  }

  goBack() {
    this.updateChrome('list');
    this.view?.webview.postMessage({ type: 'showList' });
  }

  updateChrome(mode, title) {
    this.mode = mode;
    const fallbackTitle = mode === 'settings' ? 'Configuracoes' : 'Bloco de Notas';
    const viewTitle = mode === 'editor' ? normalizeTitle(title) : fallbackTitle;

    if (this.view) {
      this.view.title = viewTitle;
    }

    vscode.commands.executeCommand('setContext', 'meuBlocoDeNotas.canGoBack', mode !== 'list');
  }

  getSettings() {
    return normalizeSettings(this.context.globalState.get(SETTINGS_KEY));
  }

  async saveSettings(settings) {
    const nextSettings = normalizeSettings(settings);
    await this.context.globalState.update(SETTINGS_KEY, nextSettings);

    this.view?.webview.postMessage({
      type: 'setSettings',
      settings: nextSettings
    });
  }

  async getHtml(webview) {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css'));
    const initialState = encodeURIComponent(JSON.stringify(await this.getState()));
    const initialSettings = encodeURIComponent(JSON.stringify(this.getSettings()));

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Bloco de Notas</title>
</head>
<body>
  <div class="app">
    <section class="screen" id="listScreen">
      <div class="notesList" id="notesList" aria-label="Notas"></div>
    </section>

    <section class="screen hidden" id="editorScreen">
      <input class="titleInput" id="titleInput" type="text" aria-label="Nome da nota" maxlength="80">
      <div class="editor">
        <div class="editorInputWrap">
          <div class="lineNumbers" id="lineNumbers" aria-hidden="true">1</div>
          <textarea id="contentInput" spellcheck="true" placeholder="Escreva suas anotacoes em Markdown..."></textarea>
        </div>
        <span class="status" id="status">Pronto</span>
      </div>
    </section>

    <section class="screen hidden" id="settingsScreen">
      <div class="settingsPanel">
        <div class="settingRow">
          <label>Pasta das notas</label>
          <button class="folderButton" id="selectFolderButton" type="button">Escolher pasta</button>
          <span class="folderPath" id="folderPath"></span>
        </div>
        <div class="settingRow">
          <label for="fontFamilyInput">Fonte</label>
          <select id="fontFamilyInput">
            <option value="default">Padrao do editor</option>
            <option value="monospace">Monospace</option>
            <option value="sans">Sans serif</option>
            <option value="serif">Serif</option>
            <option value="custom">Fonte manual</option>
          </select>
          <input class="hidden" id="customFontInput" type="text" placeholder="Ex: JetBrains Mono, Fira Code">
        </div>
        <div class="settingRow">
          <label for="fontSizeInput">Tamanho</label>
          <div class="sizeControl">
            <input id="fontSizeInput" type="range" min="12" max="24" step="1">
            <input id="fontSizeNumberInput" type="number" min="12" max="24" step="1">
          </div>
        </div>
      </div>
    </section>
  </div>

  <script nonce="${nonce}">
    try {
      const vscode = acquireVsCodeApi();
      const listScreen = document.getElementById('listScreen');
      const editorScreen = document.getElementById('editorScreen');
      const settingsScreen = document.getElementById('settingsScreen');
      const notesList = document.getElementById('notesList');
      const titleInput = document.getElementById('titleInput');
      const contentInput = document.getElementById('contentInput');
      const lineNumbers = document.getElementById('lineNumbers');
      const status = document.getElementById('status');
      const folderPath = document.getElementById('folderPath');
      const selectFolderButton = document.getElementById('selectFolderButton');
      const fontFamilyInput = document.getElementById('fontFamilyInput');
      const customFontInput = document.getElementById('customFontInput');
      const fontSizeInput = document.getElementById('fontSizeInput');
      const fontSizeNumberInput = document.getElementById('fontSizeNumberInput');
      const lineMeasure = document.createElement('div');
      let state = normalizeState(JSON.parse(decodeURIComponent('${initialState}')));
      let settings = normalizeSettings(JSON.parse(decodeURIComponent('${initialSettings}')));
      let screen = 'list';
      let saveContentTimer;
      let saveTitleTimer;

      lineMeasure.setAttribute('aria-hidden', 'true');
      document.body.appendChild(lineMeasure);

      function normalizeState(value) {
        return {
          notes: Array.isArray(value?.notes) ? value.notes.map((note) => ({
            id: String(note.id || ''),
            title: String(note.title || 'Sem titulo'),
            content: String(note.content || '')
          })).filter((note) => note.id) : [],
          activeNoteId: value?.activeNoteId,
          folderPath: String(value?.folderPath || '')
        };
      }

      function normalizeSettings(value) {
        const allowedFonts = ['default', 'monospace', 'sans', 'serif', 'custom'];
        const fontFamily = allowedFonts.includes(value?.fontFamily) ? value.fontFamily : 'default';
        const customFontFamily = String(value?.customFontFamily || '');
        const fontSize = Math.min(24, Math.max(12, Number(value?.fontSize) || 14));
        return { fontFamily, customFontFamily, fontSize };
      }

      function getActiveNote() {
        return state.notes.find((note) => note.id === state.activeNoteId) || state.notes[0];
      }

      function render() {
        const activeNote = getActiveNote();
        listScreen.classList.toggle('hidden', screen !== 'list');
        editorScreen.classList.toggle('hidden', screen !== 'editor');
        settingsScreen.classList.toggle('hidden', screen !== 'settings');
        notesList.innerHTML = '';

        if (!state.folderPath) {
          const empty = document.createElement('div');
          empty.className = 'emptyState';
          empty.textContent = 'Escolha uma pasta para ler e salvar suas notas .md.';
          const button = document.createElement('button');
          button.className = 'folderButton';
          button.type = 'button';
          button.textContent = 'Escolher pasta';
          button.addEventListener('click', () => vscode.postMessage({ type: 'selectFolder' }));
          notesList.appendChild(empty);
          notesList.appendChild(button);
        } else if (state.notes.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'emptyState';
          empty.textContent = 'Nenhum arquivo .md nesta pasta. Clique no + para criar uma nota.';
          notesList.appendChild(empty);
        } else {
          state.notes.forEach((note) => {
            const button = document.createElement('div');
            button.className = 'noteItem' + (note.id === state.activeNoteId ? ' active' : '');
            button.setAttribute('role', 'button');
            button.tabIndex = 0;
            button.title = note.title;

            const name = document.createElement('span');
            name.className = 'noteName';
            name.textContent = note.title;
            button.appendChild(name);

            const deleteButton = document.createElement('button');
            deleteButton.className = 'noteDeleteButton';
            deleteButton.type = 'button';
            deleteButton.title = 'Excluir nota';
            deleteButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><path d="M0 0h24v24H0z" fill="none"></path><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7h16m-10 4v6m4-6v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"></path></svg>';
            deleteButton.addEventListener('mousedown', (event) => {
              event.preventDefault();
              event.stopPropagation();
            });
            deleteButton.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              deleteNote(note.id);
            });
            button.appendChild(deleteButton);

            button.addEventListener('click', (event) => {
              if (event.target.closest('.noteDeleteButton')) {
                return;
              }
              selectNote(note.id);
            });
            button.addEventListener('keydown', (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectNote(note.id);
              }
            });
            notesList.appendChild(button);
          });
        }

        if (activeNote) {
          titleInput.value = activeNote.title;
          contentInput.value = activeNote.content;
        }

        folderPath.textContent = state.folderPath || 'Nenhuma pasta selecionada';
        applySettings();
        updateLineNumbers();
      }

      function selectNote(id) {
        flushPendingSaves();
        const selectedNote = state.notes.find((note) => note.id === id);
        state.activeNoteId = id;
        screen = 'editor';
        render();
        vscode.postMessage({ type: 'selectNote', id, title: selectedNote?.title });
        status.textContent = 'Pronto';
        contentInput.focus();
      }

      function updateLocalNote(fields) {
        const note = getActiveNote();
        if (note) {
          Object.assign(note, fields);
        }
        return note;
      }

      function scheduleContentSave() {
        const note = updateLocalNote({ content: contentInput.value });
        if (!note) return;
        updateLineNumbers();
        status.textContent = 'Salvando...';
        window.clearTimeout(saveContentTimer);
        saveContentTimer = window.setTimeout(() => {
          vscode.postMessage({ type: 'saveContent', id: note.id, content: note.content });
          status.textContent = 'Salvo';
        }, 250);
      }

      function scheduleTitleSave() {
        const title = titleInput.value.trim() || 'Sem titulo';
        const note = updateLocalNote({ title });
        if (!note) return;
        renderListOnly();
        status.textContent = 'Renomeando...';
        window.clearTimeout(saveTitleTimer);
        saveTitleTimer = window.setTimeout(() => {
          vscode.postMessage({ type: 'saveContent', id: note.id, content: contentInput.value });
          vscode.postMessage({ type: 'renameNote', id: note.id, title: note.title });
          status.textContent = 'Salvo';
        }, 450);
      }

      function renderListOnly() {
        const currentTitle = titleInput.value;
        const currentContent = contentInput.value;
        render();
        titleInput.value = currentTitle;
        contentInput.value = currentContent;
        updateLineNumbers();
      }

      function flushPendingSaves() {
        if (screen !== 'editor') return;
        const note = updateLocalNote({
          title: titleInput.value.trim() || 'Sem titulo',
          content: contentInput.value
        });
        if (!note) return;
        window.clearTimeout(saveContentTimer);
        window.clearTimeout(saveTitleTimer);
        vscode.postMessage({ type: 'saveContent', id: note.id, content: note.content });
        vscode.postMessage({ type: 'renameNote', id: note.id, title: note.title });
      }

      function deleteNote(id) {
        const note = state.notes.find((item) => item.id === id);
        if (!note) return;

        window.clearTimeout(saveContentTimer);
        window.clearTimeout(saveTitleTimer);
        state.notes = state.notes.filter((item) => item.id !== id);
        if (state.activeNoteId === id) {
          state.activeNoteId = state.notes[0]?.id;
        }
        showList();
        vscode.postMessage({ type: 'deleteNote', id });
      }

      function showList() {
        flushPendingSaves();
        screen = 'list';
        render();
        vscode.postMessage({ type: 'showList' });
      }

      function openSettings() {
        flushPendingSaves();
        screen = 'settings';
        renderSettings();
        render();
      }

      function renderSettings() {
        fontFamilyInput.value = settings.fontFamily;
        customFontInput.value = settings.customFontFamily;
        customFontInput.classList.toggle('hidden', settings.fontFamily !== 'custom');
        fontSizeInput.value = String(settings.fontSize);
        fontSizeNumberInput.value = String(settings.fontSize);
      }

      function applySettings() {
        const fontMap = {
          default: 'var(--vscode-editor-font-family, var(--vscode-font-family))',
          monospace: 'var(--vscode-editor-font-family, Consolas, monospace)',
          sans: 'var(--vscode-font-family, Arial, sans-serif)',
          serif: 'Georgia, serif',
          custom: settings.customFontFamily || 'var(--vscode-editor-font-family, var(--vscode-font-family))'
        };
        contentInput.style.fontFamily = fontMap[settings.fontFamily] || fontMap.default;
        contentInput.style.fontSize = settings.fontSize + 'px';
        lineNumbers.style.fontFamily = fontMap[settings.fontFamily] || fontMap.default;
        lineNumbers.style.fontSize = settings.fontSize + 'px';
      }

      function updateLineNumbers() {
        const lines = contentInput.value.split('\\n');
        const rows = [];

        syncLineMeasure();

        lines.forEach((line, index) => {
          const wrappedRows = getWrappedRowCount(line);
          rows.push(String(index + 1));

          for (let row = 1; row < wrappedRows; row += 1) {
            rows.push('');
          }
        });

        lineNumbers.textContent = rows.join('\\n') || '1';
        lineNumbers.style.minWidth = Math.max(3, String(lines.length).length + 1) + 'ch';
        lineNumbers.scrollTop = contentInput.scrollTop;
      }

      function syncLineMeasure() {
        const style = window.getComputedStyle(contentInput);
        const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const measureWidth = Math.max(1, contentInput.clientWidth - horizontalPadding);

        Object.assign(lineMeasure.style, {
          position: 'absolute',
          top: '-10000px',
          left: '-10000px',
          visibility: 'hidden',
          boxSizing: 'border-box',
          width: measureWidth + 'px',
          minHeight: '0',
          height: 'auto',
          padding: '0',
          border: '0',
          overflow: 'hidden',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'break-word',
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontStyle: style.fontStyle,
          fontWeight: style.fontWeight,
          letterSpacing: style.letterSpacing,
          lineHeight: style.lineHeight
        });
      }

      function getWrappedRowCount(line) {
        const style = window.getComputedStyle(contentInput);
        const lineHeight = parseFloat(style.lineHeight) || settings.fontSize * 1.45;
        lineMeasure.textContent = line || ' ';
        return Math.max(1, Math.round(lineMeasure.scrollHeight / lineHeight));
      }

      function saveSettings() {
        settings = normalizeSettings({
          fontFamily: fontFamilyInput.value,
          customFontFamily: customFontInput.value,
          fontSize: fontSizeNumberInput.value
        });
        renderSettings();
        applySettings();
        updateLineNumbers();
        vscode.postMessage({ type: 'saveSettings', settings });
      }

      titleInput.addEventListener('input', scheduleTitleSave);
      titleInput.addEventListener('blur', flushPendingSaves);
      contentInput.addEventListener('input', scheduleContentSave);
      contentInput.addEventListener('blur', flushPendingSaves);
      contentInput.addEventListener('scroll', () => {
        lineNumbers.scrollTop = contentInput.scrollTop;
      });
      window.addEventListener('resize', updateLineNumbers);
      selectFolderButton.addEventListener('click', () => vscode.postMessage({ type: 'selectFolder' }));
      fontFamilyInput.addEventListener('change', saveSettings);
      customFontInput.addEventListener('input', saveSettings);
      fontSizeInput.addEventListener('input', () => {
        fontSizeNumberInput.value = fontSizeInput.value;
        saveSettings();
      });
      fontSizeNumberInput.addEventListener('input', () => {
        fontSizeInput.value = fontSizeNumberInput.value;
        saveSettings();
      });
      window.addEventListener('blur', flushPendingSaves);
      window.addEventListener('pagehide', flushPendingSaves);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          flushPendingSaves();
        }
      });

      window.addEventListener('message', (event) => {
        if (event.data.type === 'setState') {
          const oldCount = state.notes.length;
          state = normalizeState(event.data.state);
          if (state.notes.length > oldCount) {
            screen = 'editor';
            if (state.activeNoteId) {
              const activeNote = getActiveNote();
              vscode.postMessage({ type: 'selectNote', id: state.activeNoteId, title: activeNote?.title });
            }
          }
          render();
          status.textContent = 'Pronto';
        }

        if (event.data.type === 'setSettings') {
          settings = normalizeSettings(event.data.settings);
          renderSettings();
          applySettings();
        }

        if (event.data.type === 'openSettings') {
          settings = normalizeSettings(event.data.settings);
          openSettings();
        }

        if (event.data.type === 'showList') {
          showList();
        }
      });

      renderSettings();
      applySettings();
      render();
    } catch (error) {
      document.body.innerHTML = '<div style="padding:12px 0;">Erro ao carregar notas: ' + String(error.message || error) + '</div>';
    }
  </script>
</body>
</html>`;
  }

  async getAvailableFileName(folder, title, currentFileName) {
    const baseName = toSafeFileName(title);
    let fileName = `${baseName}.md`;
    let suffix = 2;

    while (fileName !== currentFileName && await fileExists(vscode.Uri.joinPath(folder, fileName))) {
      fileName = `${baseName}-${suffix}.md`;
      suffix += 1;
    }

    return fileName;
  }

  async migrateLegacyNotes(folder) {
    const legacyNotes = this.context.globalState.get(LEGACY_NOTES_KEY);

    if (!Array.isArray(legacyNotes) || legacyNotes.length === 0) {
      return;
    }

    for (const note of legacyNotes) {
      const title = normalizeTitle(note?.title);
      const fileName = await this.getAvailableFileName(folder, title);
      const content = typeof note?.content === 'string' ? note.content : '';
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, fileName), Buffer.from(content, 'utf8'));
    }

    await this.context.globalState.update(LEGACY_NOTES_KEY, []);
  }
}

function activate(context) {
  const provider = new NotesViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('meuBlocoDeNotas.openNotes', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.meuBlocoDeNotas');
    }),
    vscode.commands.registerCommand('meuBlocoDeNotas.createNote', async () => {
      await provider.createNote();
      await vscode.commands.executeCommand('workbench.view.extension.meuBlocoDeNotas');
    }),
    vscode.commands.registerCommand('meuBlocoDeNotas.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.meuBlocoDeNotas');
      provider.openSettings();
      setTimeout(() => provider.openSettings(), 100);
    }),
    vscode.commands.registerCommand('meuBlocoDeNotas.selectFolder', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.meuBlocoDeNotas');
      await provider.selectFolder();
    }),
    vscode.commands.registerCommand('meuBlocoDeNotas.goBack', async () => {
      provider.goBack();
    })
  );
}

function deactivate() {}

function normalizeTitle(title) {
  const text = typeof title === 'string' ? title.trim() : '';
  return text || 'Sem titulo';
}

function normalizeSettings(settings) {
  const allowedFonts = ['default', 'monospace', 'sans', 'serif', 'custom'];
  const fontFamily = allowedFonts.includes(settings?.fontFamily) ? settings.fontFamily : 'default';
  const customFontFamily = typeof settings?.customFontFamily === 'string' ? settings.customFontFamily.trim() : '';
  const fontSize = Math.min(24, Math.max(12, Number(settings?.fontSize) || 14));

  return { fontFamily, customFontFamily, fontSize };
}

function toSafeFileName(title) {
  const safeName = normalizeTitle(title)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim();

  return safeName || 'Nota';
}

function basenameWithoutMd(fileName) {
  return path.basename(fileName, path.extname(fileName));
}

async function fileExists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (let index = 0; index < 32; index += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return text;
}

function getErrorHtml(error) {
  const message = escapeHtml(error?.message || String(error));

  return `<!DOCTYPE html>
<html lang="pt-BR">
<body>
  <div style="padding:12px 0;font-family:sans-serif;">
    Erro ao abrir o bloco de notas: ${message}
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  activate,
  deactivate
};
