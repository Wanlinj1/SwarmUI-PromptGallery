'use strict';

/** Pure text helpers for inserting/removing card text in a prompt. Kept free of DOM access so they're easy to reason about. */
const promptGalleryText = {
    /** Matches a separator-like punctuation char at the end/start of a string. */
    punctEnd: /[,.;:]$/,
    punctStart: /^[,.;:]/,

    /** Normalizes card text before inserting: trims and collapses trailing separators. */
    clean(text) {
        return (text || '').replace(/\r\n/g, '\n').trim().replace(/^[,;\s]+|[,;\s]+$/g, '');
    },

    /** Inserts 'text' into 'value' at 'pos', joining with 'sep'. Returns [newValue, cursorAfterText]. */
    insert(value, pos, text, sep) {
        if (pos < 0 || pos > value.length) {
            pos = value.length;
        }
        let before = value.substring(0, pos).replace(/\s+$/, '');
        let after = value.substring(pos).replace(/^\s+/, '');
        let result = '';
        if (before.length > 0) {
            result = before + (this.punctEnd.test(before) && sep != '\n' ? ' ' : sep);
        }
        result += text;
        let cursor = result.length;
        if (after.length > 0) {
            result += this.punctStart.test(after) ? after : sep + after;
        }
        return [result, cursor];
    },

    /** Removes the first occurrence of 'text' from 'value', tidying up the separator around it. Returns [newValue, cursorAtRemoval] or null if not found. */
    remove(value, text, sep) {
        let idx = value.indexOf(text);
        if (idx < 0 || !text) {
            return null;
        }
        let left = value.substring(0, idx).replace(/\s+$/, '');
        let right = value.substring(idx + text.length).replace(/^\s+/, '');
        let core = sep.trim();
        if (!left) {
            right = right.replace(/^[,.;:]\s*/, '');
            return [right, 0];
        }
        if (!right) {
            // Drop a dangling separator, but keep periods: a sentence before the card naturally ends with one.
            if (core && core != '.' && left.endsWith(core)) {
                left = left.substring(0, left.length - core.length).replace(/\s+$/, '');
            }
            return [left, left.length];
        }
        if (this.punctEnd.test(left) && this.punctStart.test(right)) {
            right = right.replace(/^[,.;:]\s*/, '');
            return [`${left} ${right}`, left.length + 1];
        }
        if (this.punctStart.test(right)) {
            return [left + right, left.length];
        }
        if (this.punctEnd.test(left)) {
            return [`${left} ${right}`, left.length + 1];
        }
        return [left + sep + right, left.length + sep.length];
    },

    /** True for a MOSS-Image JSON Layout prompt (a JSON object), where plain-text insertion would break the syntax. */
    isJsonLayout(value) {
        return (value || '').trimStart().startsWith('{');
    }
};

/** Reading the positive prompt out of image metadata. */
const promptGalleryMeta = {
    /** Resolves to the positive prompt stored in an image (URL, data URL or blob URL), or '' if none is found.
     * Uses Swarm's own 'parseMetadata' (Swarm, A1111/Forge, Fooocus, stealth PNG), then falls back to a ComfyUI workflow graph. */
    extractPrompt(src) {
        return new Promise(resolve => {
            let done = false;
            let finish = (prompt) => {
                if (!done) {
                    done = true;
                    resolve(prompt || '');
                }
            };
            let fallback = () => this.comfyPrompt(src).then(finish).catch(() => finish(''));
            // 'parseMetadata' may never call back if the image fails to decode, so don't wait forever.
            setTimeout(fallback, 8000);
            try {
                parseMetadata(src, (data, metadata) => {
                    let prompt = this.promptFromSwarmMetadata(metadata);
                    if (prompt) {
                        finish(prompt);
                    }
                    else {
                        fallback();
                    }
                });
            }
            catch (e) {
                fallback();
            }
        });
    },

    /** Returns the prompt from a Swarm metadata JSON string, or ''. */
    promptFromSwarmMetadata(metadata) {
        if (!metadata) {
            return '';
        }
        try {
            let params = JSON.parse(metadata).sui_image_params;
            return params && typeof params.prompt == 'string' ? params.prompt : '';
        }
        catch (e) {
            return '';
        }
    },

    /** Reads a ComfyUI 'prompt' (API graph) PNG chunk and returns the positive text, or ''. */
    async comfyPrompt(src) {
        let buffer = await (await fetch(src)).arrayBuffer();
        let parsed = await ExifReader.load(buffer, { async: true });
        let raw = parsed && (parsed.prompt || parsed.Prompt);
        if (!raw || typeof raw.value != 'string') {
            return '';
        }
        return this.comfyPositiveFromGraph(JSON.parse(raw.value)) || '';
    },

    /** Finds the positive prompt text in a ComfyUI API-format graph: follows a sampler/guider 'positive' link back to a text input. */
    comfyPositiveFromGraph(graph) {
        let textKeys = ['text', 'text_g', 'prompt', 'positive_prompt', 'string', 'value', 'text_l', 't5xxl', 'clip_l'];
        let linkKeys = ['conditioning', 'conditioning_1', 'conditioning_to', 'positive', 'clip_text', 'text'];
        let resolve = (ref, depth) => {
            if (typeof ref == 'string') {
                return ref.trim() ? ref : null;
            }
            if (!Array.isArray(ref) || depth > 12) {
                return null;
            }
            let node = graph[ref[0]];
            let inputs = node && node.inputs ? node.inputs : {};
            for (let key of textKeys.concat(linkKeys)) {
                if (key in inputs) {
                    let found = resolve(inputs[key], depth + 1);
                    if (found) {
                        return found;
                    }
                }
            }
            return null;
        };
        for (let node of Object.values(graph)) {
            if (node && node.inputs && Array.isArray(node.inputs.positive)) {
                let found = resolve(node.inputs.positive, 0);
                if (found) {
                    return found;
                }
            }
        }
        for (let node of Object.values(graph)) {
            if (node && node.class_type == 'CLIPTextEncode' && node.inputs && typeof node.inputs.text == 'string' && node.inputs.text.trim()) {
                return node.inputs.text;
            }
        }
        return null;
    },

    /** Suggests a card name: the first few words of the prompt, else the file name. */
    suggestName(prompt, fileName = '') {
        let words = (prompt || '').replace(/<[^>]*>/g, ' ').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').split(/[\s,.;]+/).filter(w => w.length > 0);
        let name = words.slice(0, 6).join(' ');
        if (name.length > 60) {
            name = name.substring(0, 60).trim();
        }
        if (!name && fileName) {
            name = fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').trim();
        }
        return name.replace(/^\.+|\.+$/g, '').trim();
    }
};

/** Preview aspect ratios, the same list as Swarm's Aspect Ratio parameter. */
const promptGalleryAspects = ['1:1', '4:3', '3:2', '8:5', '16:9', '21:9', '3:4', '2:3', '5:8', '9:16', '9:21'];

function promptGalleryAspectLabel(aspect) {
    let [w, h] = aspect.split(':').map(Number);
    return `${aspect} ${w == h ? '(square)' : w > h ? '(wide)' : '(tall)'}`;
}

/** In-page replacement for confirm()/prompt(): native dialogs are blocked in some embedded browsers (they silently return
 * "cancel"), and don't match Swarm's look. Drawn above everything, including open modals.
 * Resolves with true/false, or for an input dialog with the entered text or null. */
function promptGalleryDialog({ message, input = null, okLabel = 'OK', danger = false }) {
    return new Promise(resolve => {
        let overlay = document.createElement('div');
        overlay.className = 'pg-dialog-overlay';
        overlay.innerHTML = `<div class="pg-dialog" role="dialog" aria-modal="true">
            <div class="pg-dialog-message"></div>
            ${input != null ? '<input type="text" class="auto-text pg-dialog-input">' : ''}
            <div class="pg-dialog-buttons">
                <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} basic-button pg-dialog-ok"></button>
                <button type="button" class="btn btn-secondary basic-button pg-dialog-cancel">Cancel</button>
            </div>
        </div>`;
        overlay.querySelector('.pg-dialog-message').innerText = message;
        overlay.querySelector('.pg-dialog-ok').innerText = okLabel;
        let field = overlay.querySelector('.pg-dialog-input');
        if (field) {
            field.value = input;
        }
        let close = (result) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
            resolve(result);
        };
        let ok = () => close(field ? field.value : true);
        let cancel = () => close(field ? null : false);
        let onKey = (e) => {
            if (e.key == 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancel();
            }
            else if (e.key == 'Enter' && (field ? document.activeElement == field : true)) {
                e.preventDefault();
                e.stopPropagation();
                ok();
            }
        };
        overlay.querySelector('.pg-dialog-ok').addEventListener('click', ok);
        overlay.querySelector('.pg-dialog-cancel').addEventListener('click', cancel);
        overlay.addEventListener('mousedown', (e) => {
            if (e.target == overlay) {
                cancel();
            }
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(overlay);
        (field || overlay.querySelector('.pg-dialog-ok')).focus();
    });
}

/** Main controller for the Prompt Gallery tab. */
class PromptGalleryUI {

    constructor() {
        this.tabId = 'Prompt-Gallery-Tab';
        this.createTab();
        this.profiles = [];
        this.canEdit = false;
        this.profileName = localStorage.getItem('promptgallery_profile') || '';
        this.profileData = null;
        this.cards = null;
        this.folders = [];
        this.loadedOnce = false;
        this.lastTextbox = null;
        this.lastCursor = -1;
        this.shiftClick = false;
        this.editingCard = null;
        this.editingImage = '';
        this.editingProfile = null;
        this.promptBoxIds = ['alt_prompt_textbox', 'alt_negativeprompt_textbox', 'input_prompt', 'input_negativeprompt'];
        this.root = getRequiredElementById('pg_root');
        this.profileSelect = getRequiredElementById('pg_profile_select');
        this.emptyDiv = getRequiredElementById('pg_empty');
        this.browser = new GenPageBrowserClass('pg_browser', this.listFoldersAndFiles.bind(this), 'promptgallerybrowser', 'Big Thumbnails', this.describeCard.bind(this), this.selectCard.bind(this), '', 3);
        this.browser.sizeChangedEvent = () => this.fitLayout();
        this.browser.builtEvent = () => {
            this.fitLayout();
            this.restoreScroll();
        };
        if (typeof ResizeObserver != 'undefined') {
            new ResizeObserver(() => this.fitLayout()).observe(this.root);
        }
        this.buildModals();
        this.bindEvents();
        this.installImageButton();
    }

    /** Adds an "Add to Prompt Gallery" button to Swarm's image buttons (current image and history), by wrapping the global 'buttonsForImage'. */
    installImageButton() {
        if (typeof buttonsForImage != 'function') {
            return;
        }
        let original = buttonsForImage;
        let gallery = this;
        buttonsForImage = function (fullsrc, src, metadata, isCurrentImage = false) {
            let buttons = original.apply(this, arguments);
            try {
                let allowed = typeof permissions == 'undefined' || !permissions.hasPermission || permissions.hasPermission('prompt_gallery_edit');
                if (Array.isArray(buttons) && allowed && getMediaType(src) == 'image') {
                    buttons.push({
                        label: 'Add to Prompt Gallery',
                        title: 'Save this image as a Prompt Gallery card, with its prompt as the card text.',
                        onclick: () => gallery.addFromImage(src, metadata)
                    });
                }
            }
            catch (e) {
                console.error('Prompt Gallery: failed to add image button', e);
            }
            return buttons;
        };
    }

    /** Opens the card editor prefilled from a generated/history image. */
    addFromImage(src, metadata) {
        let open = (prompt) => this.openCardEditor(null, { image: src, prompt: prompt, name: promptGalleryMeta.suggestName(prompt, src.split('/').pop().split('?')[0]) });
        let prompt = promptGalleryMeta.promptFromSwarmMetadata(metadata);
        if (prompt) {
            open(prompt);
        }
        else {
            promptGalleryMeta.extractPrompt(src).then(open);
        }
    }

    // ===================== Bulk import =====================

    /** Creates one card per image file in the current folder, named after the file, with the prompt read from its metadata. */
    async importFiles(files) {
        let packs = [...files].filter(f => this.isZip(f));
        files = [...files].filter(f => f.type.startsWith('image/'));
        if (!this.profileData) {
            return;
        }
        for (let pack of packs) {
            await this.importPackFile(pack, { profile: this.profileData.name, folder: this.currentFolder() });
        }
        if (files.length == 0) {
            return;
        }
        let profile = this.profileData.name;
        let folder = this.currentFolder();
        let existing = new Set((this.cards || []).map(c => c.path.toLowerCase()));
        let done = 0, failed = [];
        let request = (input) => new Promise((resolve, reject) => genericRequest('PromptGallerySaveCard', input, resolve, 0, reject));
        for (let file of files) {
            doNoticePopover(`Importing ${done + failed.length + 1} / ${files.length}...`, 'notice-pop-green');
            let blobUrl = URL.createObjectURL(file);
            try {
                let prompt = await promptGalleryMeta.extractPrompt(blobUrl);
                let base = promptGalleryMeta.suggestName('', file.name) || 'image';
                let name = base;
                for (let i = 2; existing.has((folder ? `${folder}/${name}` : name).toLowerCase()); i++) {
                    name = `${base} (${i})`;
                }
                let path = folder ? `${folder}/${name}` : name;
                let image = await new Promise((resolve, reject) => {
                    let reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
                await request({ profile: profile, path: path, prompt: prompt, image: image, old_path: '' });
                existing.add(path.toLowerCase());
                done++;
            }
            catch (e) {
                failed.push(`${file.name}: ${e}`);
            }
            finally {
                URL.revokeObjectURL(blobUrl);
            }
        }
        if (this.profileData && this.profileData.name == profile) {
            this.softReload();
        }
        if (failed.length > 0) {
            showError(`Prompt Gallery: imported ${done}, failed ${failed.length}:\n${failed.join('\n')}`);
        }
        else {
            doNoticePopover(`Imported ${done} card${done == 1 ? '' : 's'}`, 'notice-pop-green');
        }
    }

    // ===================== Packs (share as .zip) =====================

    isZip(file) {
        return file.name.toLowerCase().endsWith('.zip') || file.type == 'application/zip' || file.type == 'application/x-zip-compressed';
    }

    /** The folder the browser is in, without slashes at the ends. */
    currentFolder() {
        return (this.browser.folder || '').replace(/^\/+|\/+$/g, '');
    }

    /** Downloads the current folder (or the whole profile at the top level) as a pack zip. */
    exportPack() {
        if (!this.profileData) {
            return;
        }
        let folder = this.currentFolder();
        let url = `PromptGalleryExport/${encodeURIComponent(this.profileData.name)}`;
        if (folder) {
            url += `?folder=${encodeURIComponent(folder)}`;
        }
        let link = document.createElement('a');
        link.href = url;
        link.download = '';
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    /** Uploads a pack zip. 'target' is {new_profile} to create a profile from it, or {profile, folder} to add its cards to a folder.
     * Resolves with the server's report, or null on failure (after showing the error). */
    async importPackFile(file, target) {
        let query = new URLSearchParams();
        for (let [key, value] of Object.entries(target)) {
            if (value) {
                query.set(key, value);
            }
        }
        doNoticePopover(`Importing pack '${file.name}'...`, 'notice-pop-green');
        let result;
        try {
            let response = await fetch(`PromptGalleryImport?${query}`, { method: 'POST', headers: { 'X-PromptGallery': 'import', 'Content-Type': 'application/zip' }, body: file, credentials: 'same-origin' });
            if (response.status == 401) {
                throw 'Not allowed (no edit permission, or the session expired).';
            }
            try {
                result = await response.json();
            }
            catch (e) {
                throw `Server returned status ${response.status}.`;
            }
            if (result.error) {
                throw result.error;
            }
        }
        catch (e) {
            showError(`Prompt Gallery: could not import '${file.name}': ${e}`);
            return null;
        }
        this.reportPackImport(result);
        return result;
    }

    /** Shows the outcome of a pack import and reloads the gallery if it changed the current profile. */
    reportPackImport(result) {
        let message = `Imported ${result.imported} card${result.imported == 1 ? '' : 's'} into '${result.profile}'`;
        let notes = [];
        if (result.skipped_existing > 0) {
            notes.push(`${result.skipped_existing} skipped because a card with that name already exists`);
        }
        if (result.skipped_invalid > 0) {
            notes.push(`${result.skipped_invalid} skipped as invalid:\n${result.problems.join('\n')}`);
        }
        if (notes.length > 0) {
            showError(`Prompt Gallery: ${message}.\n${notes.join('\n')}`);
        }
        else {
            doNoticePopover(message, 'notice-pop-green');
        }
        if (this.profileData && this.profileData.name == result.profile) {
            this.softReload();
        }
    }

    // ===================== Setup =====================

    /** Adds the gallery as a tab of the Generate page's right sidebar (next to Batch), registered with Swarm's movable-tab layout,
     * so the user can move it to the bottom bar or the left sidebar like any built-in tab.
     * This script runs before 'genpageLoad' (which calls 'genTabLayout.init()'), so registering here is in time. */
    createTab() {
        let nav = getRequiredElementById('rightsidebarcollection');
        let content = getRequiredElementById(nav.dataset.content);
        let li = document.createElement('li');
        li.className = 'nav-item';
        li.setAttribute('role', 'presentation');
        li.innerHTML = `<a class="nav-link translate" data-bs-toggle="tab" href="#${this.tabId}" id="${this.tabId}-nav" aria-selected="false" tabindex="-1" role="tab">Prompt Gallery</a>`;
        nav.appendChild(li);
        let pane = document.createElement('div');
        pane.className = 'tab-pane genpage-bottom-tab';
        pane.id = this.tabId;
        pane.setAttribute('role', 'tabpanel');
        pane.innerHTML = `
<div class="pg-root" id="pg_root">
    <div class="pg-toolbar">
        <label for="pg_profile_select" class="translate pg-profile-label">Profile:</label>
        <select id="pg_profile_select" class="pg-profile-select" title="Prompt Gallery profile (one per model family)"></select>
        <button class="basic-button pg-overflow pg-edit-only translate" id="pg_new_profile_button" title="Create a new profile">+ Profile</button>
        <button class="basic-button pg-overflow pg-edit-only translate" id="pg_edit_profile_button" title="Edit or delete the current profile">Edit</button>
        <span class="pg-toolbar-spacer pg-overflow"></span>
        <button class="basic-button pg-edit-only pg-needs-profile translate" id="pg_new_card_button" title="Create a new card in the current folder">+ Card</button>
        <button class="basic-button pg-overflow pg-edit-only pg-needs-profile translate" id="pg_import_button" title="Import into the current folder: image files become cards (prompts are read from their metadata), .zip packs add all their cards. You can also drop files onto the gallery.">Import</button>
        <input type="file" id="pg_import_files" accept="image/*,.zip,application/zip" multiple style="display:none">
        <button class="basic-button pg-overflow pg-needs-profile translate" id="pg_export_button" title="Download the current folder (or the whole profile, at the top level) as a .zip pack to share">Export</button>
        <button class="basic-button pg-overflow pg-edit-only pg-needs-profile translate" id="pg_new_folder_button" title="Create a subfolder in the current folder">+ Folder</button>
        <button class="basic-button pg-overflow pg-edit-only pg-needs-profile translate" id="pg_delete_folder_button" title="Delete the current folder (only if empty)">Delete Folder</button>
        <button class="basic-button pg-needs-profile translate" id="pg_random_tag_button" title="Insert a wildcard tag for this folder: every generation gets a random card from it (subfolders included). Click again to remove. Shift+click: negative prompt.">&#x1F3B2; Random</button>
        <button class="basic-button pg-needs-profile translate" id="pg_roll_button" title="Insert one random card from this folder (subfolders included) right now. Click again to re-roll. Shift+click: negative prompt.">&#x1F3B2; Roll</button>
        <button class="basic-button pg-more-button translate translate-no-text" id="pg_more_button" title="More actions: profiles, import/export, folders, previews">&#x22EF;</button>
        <button class="basic-button pg-overflow pg-edit-only pg-needs-profile translate" id="pg_folder_prompt_button" title="Set the prompt used to generate previews for cards in this folder, eg a subject for hairstyle cards. Subfolders inherit it.">Preview Prompt</button>
        <button class="basic-button pg-overflow pg-edit-only pg-needs-profile translate" id="pg_generate_previews_button" title="Generate an image for every card in this folder (and its subfolders) that has none, one at a time, using the current Generate settings and the profile's preview prompt">Generate Previews</button>
    </div>
    <div class="pg-hint translate" id="pg_hint">Click a card to add it at the prompt cursor, click again to remove it. Shift+click: negative prompt.</div>
    <div class="pg-gen-status" id="pg_gen_status" style="display:none"><span id="pg_gen_status_text"></span><button class="basic-button translate" id="pg_gen_stop" title="Stop after interrupting the current generation">Stop</button></div>
    <div class="pg-empty" id="pg_empty" style="display:none">
        <div class="translate">No profiles yet. A profile holds the cards for one model family (eg MOSS, Anima), since each one is prompted differently.</div>
        <button class="basic-button pg-edit-only translate" id="pg_empty_new_profile_button">Create Profile</button>
    </div>
    <div class="browser_container pg-browser" id="pg_browser"></div>
</div>`;
        content.appendChild(pane);
        genTabLayout.managedTabs.push(new MovableGenTab(li.querySelector('.nav-link'), genTabLayout));
    }

    bindEvents() {
        this.profileSelect.addEventListener('change', () => this.switchProfile(this.profileSelect.value));
        getRequiredElementById('pg_new_profile_button').addEventListener('click', () => this.openProfileEditor(null));
        getRequiredElementById('pg_empty_new_profile_button').addEventListener('click', () => this.openProfileEditor(null));
        getRequiredElementById('pg_edit_profile_button').addEventListener('click', () => this.openProfileEditor(this.profileData));
        getRequiredElementById('pg_new_card_button').addEventListener('click', () => this.openCardEditor(null));
        getRequiredElementById('pg_new_folder_button').addEventListener('click', () => this.createFolder());
        let importInput = getRequiredElementById('pg_import_files');
        getRequiredElementById('pg_import_button').addEventListener('click', () => importInput.click());
        importInput.addEventListener('change', () => {
            let files = [...importInput.files];
            importInput.value = '';
            this.importFiles(files);
        });
        // Dropping image files onto the gallery imports them. Stop propagation so Swarm's page-level drop handlers don't also act on them.
        let browserDiv = getRequiredElementById('pg_browser');
        let hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
        browserDiv.addEventListener('dragover', (e) => {
            if (hasFiles(e) && this.canEdit && this.profileData) {
                e.preventDefault();
                e.stopPropagation();
                browserDiv.classList.add('pg-drop-hover');
            }
        });
        browserDiv.addEventListener('dragleave', () => browserDiv.classList.remove('pg-drop-hover'));
        browserDiv.addEventListener('drop', (e) => {
            browserDiv.classList.remove('pg-drop-hover');
            if (hasFiles(e) && this.canEdit && this.profileData) {
                e.preventDefault();
                e.stopPropagation();
                this.importFiles(e.dataTransfer.files);
            }
        });
        getRequiredElementById('pg_delete_folder_button').addEventListener('click', () => this.deleteCurrentFolder());
        getRequiredElementById('pg_generate_previews_button').addEventListener('click', () => this.generateFolderPreviews());
        getRequiredElementById('pg_gen_stop').addEventListener('click', () => this.stopPreviews());
        getRequiredElementById('pg_random_tag_button').addEventListener('click', () => this.insertRandomTag());
        getRequiredElementById('pg_roll_button').addEventListener('click', () => this.rollRandomCard());
        getRequiredElementById('pg_export_button').addEventListener('click', () => this.exportPack());
        getRequiredElementById('pg_more_button').addEventListener('click', () => this.openMoreMenu());
        getRequiredElementById('pg_folder_prompt_button').addEventListener('click', () => this.openFolderPromptEditor());
        getRequiredElementById('pg_folder_prompt_save').addEventListener('click', () => this.saveFolderPrompt(getRequiredElementById('pg_folder_prompt_template').value, getRequiredElementById('pg_folder_prompt_aspect').value));
        getRequiredElementById('pg_folder_prompt_clear').addEventListener('click', () => this.saveFolderPrompt('', ''));
        getRequiredElementById('pg_folder_prompt_template').addEventListener('input', () => this.updateFolderPromptExample());
        getRequiredElementById('pg_image_modal').addEventListener('click', (e) => {
            if (!e.target.closest('.pg-image-modal-nav')) {
                $('#pg_image_modal').modal('hide');
            }
        });
        getRequiredElementById('pg_image_modal_prev').addEventListener('click', () => this.stepFullImage(-1));
        getRequiredElementById('pg_image_modal_next').addEventListener('click', () => this.stepFullImage(1));
        document.addEventListener('keydown', (e) => {
            if (this.fullImageCard && getRequiredElementById('pg_image_modal').classList.contains('show') && (e.key == 'ArrowLeft' || e.key == 'ArrowRight')) {
                e.preventDefault();
                this.stepFullImage(e.key == 'ArrowLeft' ? -1 : 1);
            }
        });
        // Remember the last prompt box the user typed in, and where the cursor was, so clicking a card can insert there.
        document.addEventListener('focusout', (e) => {
            if (e.target && this.promptBoxIds.includes(e.target.id)) {
                this.lastTextbox = e.target;
                this.lastCursor = e.target.selectionEnd;
            }
        }, true);
        // The browser's select callback doesn't receive the click event, so capture the Shift state here.
        this.root.addEventListener('mousedown', (e) => {
            this.shiftClick = e.shiftKey;
        }, true);
        // Keep the "already in prompt" highlight in sync when the user edits the prompt by hand.
        let rerenderSoon = this.debounce(() => this.rerenderIfVisible(), 400);
        for (let id of ['alt_prompt_textbox', 'alt_negativeprompt_textbox']) {
            let box = document.getElementById(id);
            if (box) {
                box.addEventListener('input', rerenderSoon);
            }
        }
        // Load lazily when the tab is first opened (or right away if the session is ready and the tab is visible).
        getRequiredElementById(`${this.tabId}-nav`).addEventListener('click', () => this.ensureLoaded());
        sessionReadyCallbacks.push(() => {
            if (typeof permissions != 'undefined' && permissions.hasPermission && !permissions.hasPermission('prompt_gallery_view')) {
                getRequiredElementById(`${this.tabId}-nav`).parentElement.style.display = 'none';
                return;
            }
            this.ensureLoaded();
        });
    }

    // ===================== Layout =====================

    /** Adapts the panel to its size, since it can sit in a narrow sidebar or the wide, short bottom bar:
     * - compact (narrow): rarely used buttons move into the "..." menu.
     * - stacked (very narrow): the folder tree goes above the cards instead of beside them.
     * - short: the usage hint is hidden (it's also in the button tooltips).
     * Side by side, the tree is kept to a share of the panel, so the cards always stay visible however the splitter was left. */
    fitLayout() {
        let width = this.root.clientWidth, height = this.root.clientHeight;
        if (width == 0) {
            return;
        }
        let stacked = width < 520;
        this.root.classList.toggle('pg-compact', width < 1000);
        this.root.classList.toggle('pg-stacked', stacked);
        this.root.classList.toggle('pg-short', height < 420 || stacked);
        let tree = this.browser.folderTreeDiv, content = this.browser.fullContentDiv;
        if (!tree || !content || stacked) {
            return;
        }
        let stored = parseInt(localStorage.getItem(`barspot_browser_${this.browser.id}`));
        let wanted = isNaN(stored) ? Math.round(width * 0.3) : stored;
        let treeWidth = Math.max(110, Math.min(wanted, Math.round(width * 0.45), isNaN(stored) ? 240 : 99999));
        tree.style.width = `${treeWidth}px`;
        content.style.width = `calc(100% - ${treeWidth + 1}px - 0.6rem)`;
    }

    /** The "..." menu: the actions hidden from the toolbar in compact mode. */
    openMoreMenu() {
        let hasProfile = !!this.profileData;
        let items = [];
        let add = (key, action, show = true) => {
            if (show) {
                items.push({ key: key, action: action });
            }
        };
        add('Import cards or pack...', () => getRequiredElementById('pg_import_files').click(), this.canEdit && hasProfile);
        add(this.currentFolder() ? 'Export this folder' : 'Export profile', () => this.exportPack(), hasProfile);
        add('New folder...', () => this.createFolder(), this.canEdit && hasProfile);
        add('Delete this folder', () => this.deleteCurrentFolder(), this.canEdit && hasProfile && !!this.currentFolder());
        add('Preview prompt for this folder...', () => this.openFolderPromptEditor(), this.canEdit && hasProfile);
        add('Generate previews', () => this.generateFolderPreviews(), this.canEdit && hasProfile);
        add('New profile...', () => this.openProfileEditor(null), this.canEdit);
        add('Edit profile...', () => this.openProfileEditor(this.profileData), this.canEdit && hasProfile);
        let button = getRequiredElementById('pg_more_button');
        let rect = button.getBoundingClientRect();
        new AdvancedPopover('pg_more_menu', items, false, rect.x, rect.y + button.offsetHeight + 6, document.body, null);
    }

    debounce(func, wait) {
        let timeout = null;
        return () => {
            clearTimeout(timeout);
            timeout = setTimeout(func, wait);
        };
    }

    ensureLoaded() {
        if (this.loadedOnce || !session_id) {
            return;
        }
        this.loadedOnce = true;
        this.loadProfiles();
    }

    rerenderIfVisible() {
        if (this.cards && this.root.offsetParent) {
            this.browser.rerender();
        }
    }

    // ===================== Profiles =====================

    loadProfiles(selectName = null) {
        genericRequest('PromptGalleryListProfiles', {}, data => {
            this.profiles = data.profiles;
            this.canEdit = data.can_edit;
            this.root.classList.toggle('pg-readonly', !this.canEdit);
            if (selectName) {
                this.profileName = selectName;
            }
            if (!this.profiles.some(p => p.name == this.profileName)) {
                this.profileName = this.profiles.length > 0 ? this.profiles[0].name : '';
            }
            this.profileSelect.innerHTML = '';
            for (let profile of this.profiles) {
                let option = document.createElement('option');
                option.value = profile.name;
                option.innerText = profile.name;
                this.profileSelect.appendChild(option);
            }
            this.profileSelect.value = this.profileName;
            this.switchProfile(this.profileName, true);
        });
    }

    switchProfile(name, force = false) {
        if (name == (this.profileData ? this.profileData.name : null) && !force) {
            return;
        }
        this.profileName = name;
        localStorage.setItem('promptgallery_profile', name);
        this.profileData = this.profiles.find(p => p.name == name) || null;
        let hasProfile = !!this.profileData;
        this.emptyDiv.style.display = hasProfile ? 'none' : '';
        this.root.classList.toggle('pg-no-profile', !hasProfile);
        this.cards = null;
        this.folders = [];
        this.reloadBrowser('');
    }

    /** Reloads cards from the server and redraws, optionally navigating to a folder. Safe to call before the browser was ever drawn. */
    /** Reloads cards after an edit without the jump of a full refresh: the list keeps its scroll position
     * (when staying in the same folder) and the folder tree keeps what's open. */
    softReload(folder = null) {
        if (!this.browser.contentDiv) {
            this.reloadBrowser(folder);
            return;
        }
        let sameFolder = folder == null || folder == this.browser.folder;
        this.pendingScroll = sameFolder ? this.browser.contentDiv.scrollTop : null;
        this.cards = null;
        if (folder != null) {
            this.browser.folder = folder;
        }
        this.browser.lastListCache = null;
        this.browser.update(false);
    }

    /** Called after every build: puts back the scroll position saved by softReload. */
    restoreScroll() {
        if (this.pendingScroll == null || !this.browser.contentDiv) {
            return;
        }
        this.browser.contentDiv.scrollTop = this.pendingScroll;
        this.pendingScroll = null;
        browserUtil.makeVisible(this.browser.contentDiv);
    }

    /** Full reload (scrolls to the top and rebuilds the folder tree): only for switching profiles and the refresh button. */
    reloadBrowser(folder = null) {
        this.cards = null;
        if (folder != null) {
            this.browser.folder = folder;
        }
        if (this.browser.contentDiv) {
            this.browser.refresh();
        }
        else {
            this.browser.lastListCache = null;
            this.browser.update();
        }
    }

    /** Separator used to join cards, from the active profile. */
    separator() {
        return this.profileData ? this.profileData.separator : ', ';
    }

    // ===================== Browser integration =====================

    listFoldersAndFiles(path, isRefresh, callback, depth) {
        let build = () => {
            let prefix = path == '' ? '' : (path.endsWith('/') ? path : `${path}/`);
            let folders = [];
            let addFolder = (sub) => {
                let parts = sub.split('/');
                for (let i = 1; i <= parts.length && i <= depth; i++) {
                    let folder = parts.slice(0, i).join('/');
                    if (!folders.includes(folder)) {
                        folders.push(folder);
                    }
                }
            };
            for (let folder of this.folders) {
                if (folder.startsWith(prefix) && folder.length > prefix.length) {
                    addFolder(folder.substring(prefix.length));
                }
            }
            let files = [];
            for (let card of this.cards || []) {
                if (!card.path.startsWith(prefix)) {
                    continue;
                }
                let sub = card.path.substring(prefix.length);
                let slashes = sub.split('/').length - 1;
                if (slashes < depth) {
                    files.push({ name: card.path, data: card });
                }
            }
            callback(folders, files);
        };
        if (!this.profileData) {
            this.cards = [];
            this.folders = [];
            build();
            return;
        }
        if (this.cards && !isRefresh) {
            build();
            return;
        }
        let profile = this.profileData.name;
        genericRequest('PromptGalleryListCards', { profile: profile }, data => {
            if (!this.profileData || this.profileData.name != profile) {
                return;
            }
            this.cards = data.cards;
            this.folders = data.folders;
            this.wildcards = data.wildcards || {};
            build();
        }, 0, (e) => {
            showError(e);
            this.cards = [];
            this.folders = [];
            build();
        });
    }

    imageUrl(card, thumb) {
        let path = card.path.split('/').map(encodeURIComponent).join('/');
        return `PromptGalleryImage/${encodeURIComponent(this.profileData.name)}/${path}?v=${encodeURIComponent(card.version)}${thumb ? '&thumb=1' : ''}`;
    }

    /** The prompt box a card click would go to right now. */
    targetBox(forceNegative = false) {
        if (forceNegative) {
            return document.getElementById('alt_negativeprompt_textbox');
        }
        if (this.lastTextbox && document.body.contains(this.lastTextbox)) {
            return this.lastTextbox;
        }
        return document.getElementById('alt_prompt_textbox');
    }

    isInPrompt(card) {
        let text = promptGalleryText.clean(card.prompt);
        if (!text) {
            return false;
        }
        for (let id of ['alt_prompt_textbox', 'alt_negativeprompt_textbox']) {
            let box = document.getElementById(id);
            if (box && box.value.includes(text)) {
                return true;
            }
        }
        return false;
    }

    describeCard(file) {
        let card = file.data;
        let name = card.path.includes('/') ? card.path.substring(card.path.lastIndexOf('/') + 1) : card.path;
        let buttons = [
            { label: 'Add to Negative Prompt', onclick: () => this.toggleCard(card, true) },
            { label: 'Replace Prompt', onclick: () => this.replacePrompt(card) },
            { label: 'Copy Text', onclick: () => {
                copyText(promptGalleryText.clean(card.prompt));
                doNoticePopover('Copied!', 'notice-pop-green');
            } }
        ];
        if (card.has_image) {
            buttons.push({ label: 'View Full Image', onclick: () => this.showFullImage(card) });
        }
        if (this.canEdit) {
            buttons.push({ label: card.has_image ? 'Regenerate Preview' : 'Generate Preview', onclick: () => this.generatePreviews([card]) });
            buttons.push({ label: 'Edit Card', onclick: () => this.openCardEditor(card) });
            buttons.push({ label: 'Delete Card', onclick: () => this.deleteCard(card) });
        }
        let promptText = card.prompt || '(empty)';
        let description = `<b>${escapeHtml(name)}</b><br>${escapeHtml(promptText.length > 600 ? promptText.substring(0, 600) + '…' : promptText)}`;
        let className = 'pg-card';
        if (this.isInPrompt(card)) {
            className += ' pg-card-in-prompt';
        }
        // A card without an image shows the placeholder in the shape its preview will have.
        let aspectRatio = null;
        if (!card.has_image) {
            let match = /^(\d+):(\d+)$/.exec(this.folderAspect(card.path.includes('/') ? card.path.substring(0, card.path.lastIndexOf('/')) : '').aspect);
            if (match) {
                className += ` pg-card-placeholder pg-aspect-${match[1]}-${match[2]}`;
                aspectRatio = parseInt(match[1]) / parseInt(match[2]);
            }
        }
        return {
            aspectRatio: aspectRatio,
            name: card.path,
            display: name,
            description: description,
            buttons: buttons,
            image: card.has_image ? this.imageUrl(card, true) : 'imgs/model_placeholder.jpg',
            className: className,
            searchable: `${card.path}\n${card.prompt}`
        };
    }

    selectCard(file, div) {
        let negative = this.shiftClick;
        this.shiftClick = false;
        this.toggleCard(file.data, negative);
    }

    // ===================== Full image view =====================

    /** Shows a card's image in a popup over the page (Esc, a click or the browser stays on the page). Arrows step through the visible cards with images. */
    showFullImage(card) {
        this.fullImageCard = card;
        let name = card.path.includes('/') ? card.path.substring(card.path.lastIndexOf('/') + 1) : card.path;
        getRequiredElementById('pg_image_modal_img').src = this.imageUrl(card, false);
        getRequiredElementById('pg_image_modal_name').innerText = name;
        let text = promptGalleryText.clean(card.prompt);
        getRequiredElementById('pg_image_modal_text').innerText = text.length > 300 ? text.substring(0, 300) + '…' : text;
        $('#pg_image_modal').modal('show');
    }

    stepFullImage(delta) {
        let visible = [...(this.browser.contentDiv ? this.browser.contentDiv.children : [])].map(div => div.dataset.name).filter(x => x);
        let withImages = visible.map(path => (this.cards || []).find(c => c.path == path)).filter(c => c && c.has_image);
        if (withImages.length == 0 || !this.fullImageCard) {
            return;
        }
        let index = withImages.findIndex(c => c.path == this.fullImageCard.path);
        let next = withImages[(index + delta + withImages.length) % withImages.length];
        this.showFullImage(next);
    }

    // ===================== Folder preview prompts =====================

    openFolderPromptEditor() {
        if (!this.profileData) {
            return;
        }
        let folder = this.currentFolder();
        this.editingPromptFolder = folder;
        getRequiredElementById('pg_folder_prompt_title').innerText = folder ? `Preview Prompt: ${folder}` : `Preview Prompt: profile '${this.profileData.name}'`;
        let own = folder ? ((this.profileData.folder_templates || {})[folder] || null) : this.profileData.preview_template;
        let inherited = folder ? this.folderTemplate(folder.includes('/') ? folder.substring(0, folder.lastIndexOf('/')) : '') : null;
        getRequiredElementById('pg_folder_prompt_template').value = own && own != '{card}' ? own : '';
        getRequiredElementById('pg_folder_prompt_template').placeholder = inherited ? inherited.template : '{card}';
        let note = folder
            ? (own ? 'This folder has its own prompt; its subfolders use it too unless they set their own.' : `Now inherited from ${inherited.source ? `folder '${inherited.source}'` : 'the profile'} (shown greyed out). Type to set this folder's own prompt.`)
            : 'This is the profile-wide default. Folders can override it, eg "portrait of a young woman, {card}" for hairstyles.';
        getRequiredElementById('pg_folder_prompt_note').innerText = note;
        let ownAspect = folder ? ((this.profileData.folder_aspects || {})[folder] || '') : (this.profileData.preview_aspect || '');
        let aspectSelect = getRequiredElementById('pg_folder_prompt_aspect');
        let inheritedAspect = folder ? this.folderAspect(folder.includes('/') ? folder.substring(0, folder.lastIndexOf('/')) : '').aspect : '';
        aspectSelect.innerHTML = '';
        aspectSelect.add(new Option(folder ? `Inherited (${inheritedAspect || 'Generate tab'})` : 'From the Generate tab', ''));
        for (let aspect of promptGalleryAspects) {
            aspectSelect.add(new Option(promptGalleryAspectLabel(aspect), aspect));
        }
        aspectSelect.value = ownAspect;
        getRequiredElementById('pg_folder_prompt_clear').style.display = folder && (own || ownAspect) ? '' : 'none';
        this.modalError('pg_folder_prompt_error', '');
        this.updateFolderPromptExample();
        $('#pg_folder_prompt_modal').modal('show');
    }

    updateFolderPromptExample() {
        let folder = this.editingPromptFolder || '';
        let typed = getRequiredElementById('pg_folder_prompt_template').value.trim();
        let template = typed || getRequiredElementById('pg_folder_prompt_template').placeholder || '{card}';
        let prefix = folder ? `${folder}/` : '';
        let card = (this.cards || []).find(c => c.path.startsWith(prefix) && promptGalleryText.clean(c.prompt));
        let example = getRequiredElementById('pg_folder_prompt_example');
        if (!card) {
            example.innerText = '';
            return;
        }
        let text = promptGalleryText.clean(card.prompt);
        let result = template.includes('{card}') ? template.replaceAll('{card}', text) : `(must contain {card})`;
        example.innerText = `Example: ${result.length > 300 ? result.substring(0, 300) + '…' : result}`;
    }

    saveFolderPrompt(template, aspect) {
        template = template.trim();
        if (template && !template.includes('{card}')) {
            this.modalError('pg_folder_prompt_error', 'The prompt must contain {card}.');
            return;
        }
        let folder = this.editingPromptFolder || '';
        let done = (profile) => {
            let index = this.profiles.findIndex(p => p.name == profile.name);
            if (index >= 0) {
                this.profiles[index] = profile;
            }
            this.profileData = profile;
            // Placeholders follow the folder's preview shape.
            this.browser.rerender();
            $('#pg_folder_prompt_modal').modal('hide');
            doNoticePopover('Preview prompt saved', 'notice-pop-green');
        };
        let fail = (e) => this.modalError('pg_folder_prompt_error', e);
        if (folder) {
            genericRequest('PromptGallerySetFolderTemplate', { profile: this.profileData.name, path: folder, template: template, aspect: aspect }, data => done(data.profile), 0, fail);
        }
        else {
            let p = this.profileData;
            genericRequest('PromptGallerySaveProfile', { name: p.name, old_name: p.name, separator: p.separator, description: p.description, preview_template: template || '{card}', preview_aspect: aspect }, data => done(data.profile), 0, fail);
        }
    }

    // ===================== Preview generation =====================

    /** Generates previews for cards without an image in the current folder and its subfolders. */
    async generateFolderPreviews() {
        let folder = this.currentFolder();
        let prefix = folder ? `${folder}/` : '';
        let cards = (this.cards || []).filter(c => !c.has_image && c.path.startsWith(prefix) && promptGalleryText.clean(c.prompt));
        if (cards.length == 0) {
            doNoticePopover('Every card here already has an image', 'notice-pop-green');
            return;
        }
        let example = this.previewPrompt(cards[0]);
        let ok = await promptGalleryDialog({
            message: `Generate ${cards.length} preview image${cards.length == 1 ? '' : 's'} with the current Generate settings? They run one at a time and can be stopped.\n\nFirst prompt:\n${example.length > 400 ? example.substring(0, 400) + '…' : example}`,
            okLabel: 'Generate'
        });
        if (!ok) {
            return;
        }
        this.generatePreviews(cards);
    }

    /** The preview template that applies to a folder: its own, else the nearest parent folder's, else the profile's.
     * Returns { template, source } where source is the folder it came from ('' for the profile). */
    folderTemplate(folder) {
        let templates = (this.profileData && this.profileData.folder_templates) || {};
        let lower = Object.fromEntries(Object.entries(templates).map(([k, v]) => [k.toLowerCase(), [k, v]]));
        let current = folder || '';
        while (current) {
            let hit = lower[current.toLowerCase()];
            if (hit) {
                return { template: hit[1], source: hit[0] };
            }
            current = current.includes('/') ? current.substring(0, current.lastIndexOf('/')) : '';
        }
        return { template: (this.profileData && this.profileData.preview_template) || '{card}', source: '' };
    }

    /** The preview aspect ratio that applies to a folder, inherited like the prompt. Returns { aspect, source }; aspect '' = the Generate tab's. */
    folderAspect(folder) {
        let aspects = (this.profileData && this.profileData.folder_aspects) || {};
        let lower = Object.fromEntries(Object.entries(aspects).map(([k, v]) => [k.toLowerCase(), [k, v]]));
        let current = folder || '';
        while (current) {
            let hit = lower[current.toLowerCase()];
            if (hit) {
                return { aspect: hit[1], source: hit[0] };
            }
            current = current.includes('/') ? current.substring(0, current.lastIndexOf('/')) : '';
        }
        return { aspect: (this.profileData && this.profileData.preview_aspect) || '', source: '' };
    }

    /** Sets width/height for an aspect ratio, keeping about the same pixel count as the Generate tab resolution. */
    applyPreviewAspect(input, aspect) {
        let match = /^(\d+):(\d+)$/.exec(aspect || '');
        let width = parseInt(input.width), height = parseInt(input.height);
        if (!match || !(width > 0) || !(height > 0)) {
            return;
        }
        let ratio = parseInt(match[1]) / parseInt(match[2]);
        let area = width * height;
        input.width = Math.max(64, Math.round(Math.sqrt(area * ratio) / 32) * 32);
        input.height = Math.max(64, Math.round(Math.sqrt(area / ratio) / 32) * 32);
        input.aspectratio = 'Custom';
    }

    /** The prompt sent for a card's preview: the template of its folder (or the profile's) with {card} replaced. */
    previewPrompt(card) {
        let folder = card.path.includes('/') ? card.path.substring(0, card.path.lastIndexOf('/')) : '';
        let template = this.folderTemplate(folder).template;
        let text = promptGalleryText.clean(card.prompt);
        return template.includes('{card}') ? template.replaceAll('{card}', text) : text;
    }

    /** Runs one generation through Swarm's normal API with the current Generate parameters. Resolves with the image src. */
    generatePreviewImage(card) {
        return new Promise((resolve, reject) => {
            let input = getGenInput();
            input.prompt = this.previewPrompt(card);
            // Previews show only the card: the negative prompt from the Generate tab is left out.
            input.negativeprompt = '';
            let seed = this.profileData ? this.profileData.preview_seed : -1;
            if (seed != null && seed >= 0) {
                input.seed = seed;
            }
            this.applyPreviewAspect(input, this.folderAspect(card.path.includes('/') ? card.path.substring(0, card.path.lastIndexOf('/')) : '').aspect);
            input.images = 1;
            delete input.batchsize;
            // The image belongs to the card, so keep it out of the user's Output history.
            input.donotsave = true;
            let image = null, finished = false;
            let finish = (error) => {
                if (finished) {
                    return;
                }
                finished = true;
                this.genSocket = null;
                if (image) {
                    resolve(image);
                }
                else {
                    reject(error || 'No image was generated.');
                }
            };
            let socket = makeWSRequestT2I('GenerateText2ImageWS', input, data => {
                if (data.image) {
                    image = typeof data.image == 'string' ? data.image : data.image.image;
                }
                if (data.socket_intention == 'close') {
                    finish();
                }
            }, (e) => {
                image = null;
                finish(e);
            });
            this.genSocket = socket || null;
            if (socket) {
                socket.addEventListener('close', () => finish(this.stopRequested ? 'Stopped.' : null));
            }
        });
    }

    /** Converts an image src (data URL or server path) to a data URL for upload. */
    /** Scales an image data URL down so its longest side is at most 'size' px, saved as WebP. 0 or a smaller image keeps it as is. */
    async shrinkImage(dataUrl, size) {
        if (!size || size <= 0) {
            return dataUrl;
        }
        let img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject('Could not read the generated image.');
            img.src = dataUrl;
        });
        let scale = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
        let canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        let ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        let result = canvas.toDataURL('image/webp', 0.9);
        // Browsers without WebP encoding fall back to PNG; JPEG is much smaller then.
        return result.startsWith('data:image/webp') ? result : canvas.toDataURL('image/jpeg', 0.9);
    }

    async toDataUrl(src) {
        if (src.startsWith('data:')) {
            return src;
        }
        let response = await fetch(src);
        if (!response.ok) {
            throw `Could not load the generated image (status ${response.status}).`;
        }
        let blob = await response.blob();
        return await new Promise((resolve, reject) => {
            let reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    setGenStatus(text) {
        getRequiredElementById('pg_gen_status').style.display = text ? '' : 'none';
        getRequiredElementById('pg_gen_status_text').innerText = text || '';
    }

    /** Generates a preview image for each card in turn and saves it as the card's image. Only ever started by the user. */
    async generatePreviews(cards) {
        if (this.generating) {
            doNoticePopover('Previews are already being generated', 'notice-pop-red');
            return;
        }
        if (typeof makeWSRequestT2I != 'function' || typeof getGenInput != 'function') {
            showError('Prompt Gallery: generation is not available on this page.');
            return;
        }
        let modelBox = document.getElementById('current_model');
        if (modelBox && !modelBox.value) {
            showError('Prompt Gallery: select a model in the Generate tab first.');
            return;
        }
        let profile = this.profileData.name;
        let request = (input) => new Promise((resolve, reject) => genericRequest('PromptGallerySaveCard', input, resolve, 0, reject));
        this.generating = true;
        this.stopRequested = false;
        let done = 0, failed = [];
        try {
            for (let i = 0; i < cards.length && !this.stopRequested; i++) {
                let card = cards[i];
                this.setGenStatus(`Generating preview ${i + 1} / ${cards.length}: ${card.path}`);
                try {
                    let src = await this.generatePreviewImage(card);
                    let image = await this.shrinkImage(await this.toDataUrl(src), this.profileData ? this.profileData.preview_size : 512);
                    await request({ profile: profile, path: card.path, prompt: card.prompt, image: image, old_path: card.path });
                    done++;
                    if (this.profileData && this.profileData.name == profile) {
                        this.showNewCardImage(card.path);
                    }
                }
                catch (e) {
                    if (this.stopRequested) {
                        break;
                    }
                    failed.push(`${card.path}: ${e}`);
                    // Repeated failures with no success usually mean a backend/model problem, so don't burn through the whole list.
                    if (done == 0 && failed.length >= 3) {
                        break;
                    }
                }
            }
        }
        finally {
            this.generating = false;
            this.setGenStatus('');
        }
        let summary = `Generated ${done} preview${done == 1 ? '' : 's'}${this.stopRequested ? ' (stopped)' : ''}`;
        if (failed.length > 0) {
            showError(`Prompt Gallery: ${summary}, failed ${failed.length}:\n${failed.join('\n')}`);
        }
        else {
            doNoticePopover(summary, 'notice-pop-green');
        }
    }

    /** Marks a card as having an image and swaps its thumbnail in place, without reloading the list
     * (a reload would jump back to the top and rebuild the folder tree after every preview). */
    showNewCardImage(path) {
        let card = (this.cards || []).find(c => c.path == path);
        if (!card) {
            return;
        }
        card.has_image = true;
        card.version = `${card.version || ''}-${Date.now()}`;
        this.replaceCardTile(card);
    }

    /** Rebuilds one card's tile in place, so its menu (View Full Image, Regenerate Preview) and shape match the card now,
     * without redrawing the whole list. */
    replaceCardTile(card) {
        let browser = this.browser;
        let container = browser.contentDiv;
        let oldDiv = container ? [...container.children].find(d => d.dataset.name == card.path) : null;
        if (!oldDiv) {
            return;
        }
        let oldMenu = oldDiv.previousElementSibling;
        if (!oldMenu || !oldMenu.classList.contains('sui-popover')) {
            oldMenu = null;
        }
        this.tileCounter = (this.tileCounter || 100000) + 1;
        let chunks = browser.chunksRendered;
        browser.buildContentList(container, [{ name: card.path, data: card }], oldDiv, this.tileCounter);
        browser.chunksRendered = chunks;
        let newDiv = oldDiv.previousElementSibling;
        if (!newDiv || newDiv.dataset.name != card.path) {
            return;
        }
        oldDiv.remove();
        if (oldMenu) {
            oldMenu.remove();
        }
    }

    stopPreviews() {
        if (!this.generating) {
            return;
        }
        this.stopRequested = true;
        this.setGenStatus('Stopping...');
        genericRequest('InterruptAll', { other_sessions: false }, () => {});
        if (this.genSocket) {
            this.genSocket.close();
        }
    }

    // ===================== Prompt editing =====================

    /** Adds the card to the target prompt box at the cursor, or removes it if it's already there. */
    toggleCard(card, negative = false) {
        let text = promptGalleryText.clean(card.prompt);
        if (!text) {
            doNoticePopover('This card has no prompt text', 'notice-pop-red');
            return;
        }
        this.toggleText(text, negative);
    }

    /** Adds text to the target prompt box at the cursor, or removes it if it's already there. */
    toggleText(text, negative = false) {
        let box = this.targetBox(negative);
        if (!box) {
            return;
        }
        let sep = this.separator();
        let removed = promptGalleryText.remove(box.value, text, sep);
        let newValue, cursor;
        if (removed) {
            [newValue, cursor] = removed;
            doNoticePopover('Removed from prompt', 'notice-pop-green');
        }
        else if (promptGalleryText.isJsonLayout(box.value)) {
            // MOSS JSON Layout prompts: inserting prose anywhere would make the JSON invalid.
            doNoticePopover('The prompt is a JSON layout, inserting text would break it. Use Copy Text and paste it into the right field yourself.', 'notice-pop-red');
            return;
        }
        else if (promptGalleryText.isJsonLayout(text) && box.value.trim()) {
            doNoticePopover('This card is a JSON layout and cannot be mixed with other text. Use Replace Prompt instead.', 'notice-pop-red');
            return;
        }
        else {
            let pos = box == this.lastTextbox && this.lastCursor >= 0 ? this.lastCursor : box.value.length;
            [newValue, cursor] = promptGalleryText.insert(box.value, pos, text, sep);
        }
        this.applyToBox(box, newValue, cursor);
    }

    // ===================== Random (Swarm wildcards) =====================

    /** Cards of the current folder and its subfolders that have text. */
    folderCards(folder) {
        let prefix = `${folder}/`;
        return (this.cards || []).filter(c => c.path.startsWith(prefix) && promptGalleryText.clean(c.prompt));
    }

    /** Toggles a wildcard tag for the current folder: Swarm then picks a random card from it (with subfolders) on every generation. */
    insertRandomTag() {
        let folder = this.currentFolder();
        let negative = this.shiftClick;
        this.shiftClick = false;
        if (!folder) {
            doNoticePopover('Open a folder first: the random tag picks from the current folder', 'notice-pop-red');
            return;
        }
        if (this.folderCards(folder).length == 0) {
            doNoticePopover('This folder has no cards with text', 'notice-pop-red');
            return;
        }
        let name = (this.wildcards || {})[folder];
        if (!name) {
            doNoticePopover('The wildcard for this folder is not ready yet, try again in a moment', 'notice-pop-red');
            return;
        }
        this.toggleText(`<wildcard:${name}>`, negative);
    }

    /** Picks one random card from the current folder (with subfolders) and inserts its text now, replacing the previous roll from this folder. */
    rollRandomCard() {
        let folder = this.currentFolder();
        let negative = this.shiftClick;
        this.shiftClick = false;
        if (!folder) {
            doNoticePopover('Open a folder first: Roll picks from the current folder', 'notice-pop-red');
            return;
        }
        let box = this.targetBox(negative);
        if (!box) {
            return;
        }
        if (promptGalleryText.isJsonLayout(box.value)) {
            doNoticePopover('The prompt is a JSON layout, inserting text would break it.', 'notice-pop-red');
            return;
        }
        this.lastRolls = this.lastRolls || {};
        let key = `${negative ? 'neg' : 'pos'}:${folder}`;
        let previous = this.lastRolls[key];
        let candidates = this.folderCards(folder).filter(c => !box.value.includes(promptGalleryText.clean(c.prompt)));
        if (candidates.length == 0) {
            doNoticePopover('Every card of this folder is already in the prompt', 'notice-pop-red');
            return;
        }
        let card = candidates[Math.floor(Math.random() * candidates.length)];
        let text = promptGalleryText.clean(card.prompt);
        let sep = this.separator();
        let value = box.value;
        let pos = box == this.lastTextbox && this.lastCursor >= 0 ? this.lastCursor : value.length;
        // Re-rolling swaps the previous pick in place, so repeated clicks don't pile up text.
        if (previous && value.includes(previous)) {
            let removed = promptGalleryText.remove(value, previous, sep);
            if (removed) {
                [value, pos] = removed;
            }
        }
        let [newValue, cursor] = promptGalleryText.insert(value, pos, text, sep);
        this.lastRolls[key] = text;
        this.applyToBox(box, newValue, cursor);
        let name = card.path.substring(card.path.lastIndexOf('/') + 1);
        doNoticePopover(`Rolled: ${name}`, 'notice-pop-green');
    }

    replacePrompt(card) {
        let box = this.targetBox(false);
        let text = promptGalleryText.clean(card.prompt);
        this.applyToBox(box, text, text.length);
    }

    applyToBox(box, value, cursor) {
        box.value = value;
        box.selectionStart = cursor;
        box.selectionEnd = cursor;
        this.lastTextbox = box;
        this.lastCursor = cursor;
        triggerChangeFor(box);
        this.browser.rerender();
    }

    // ===================== Modals =====================

    buildModals() {
        let html = `
<div class="modal" tabindex="-1" role="dialog" id="pg_card_modal">
    <div class="modal-dialog" role="document">
        <div class="modal-content">
            <div class="modal-header"><h5 class="modal-title" id="pg_card_modal_title">Card</h5></div>
            <div class="modal-body">
                <div class="pg-form-row"><label for="pg_card_profile" class="translate">Profile</label><select id="pg_card_profile"></select></div>
                <div class="pg-form-row"><label for="pg_card_folder" class="translate">Folder</label><input type="text" class="auto-text" id="pg_card_folder" placeholder="(root)" list="pg_folder_list" autocomplete="off"><datalist id="pg_folder_list"></datalist></div>
                <div class="pg-form-row"><label for="pg_card_name" class="translate">Name</label><input type="text" class="auto-text" id="pg_card_name" placeholder="Card name (shown as caption)"></div>
                <div class="pg-form-row pg-form-row-block"><label for="pg_card_prompt" class="translate">Prompt text</label><textarea class="auto-text auto-text-block" id="pg_card_prompt" rows="6" placeholder="Text to insert into the prompt"></textarea></div>
                <div class="pg-form-row pg-form-row-block">
                    <label class="translate">Image</label>
                    <div class="pg-image-drop" id="pg_card_image_drop" title="Drop or paste an image here">
                        <img id="pg_card_image_preview" class="pg-image-preview" alt="">
                        <span id="pg_card_image_placeholder" class="translate">Drop, paste (Ctrl+V) or choose an image</span>
                    </div>
                    <div class="pg-image-buttons">
                        <input type="file" id="pg_card_image_file" accept="image/*" style="display:none">
                        <button type="button" class="basic-button translate" id="pg_card_image_choose">Choose File</button>
                        <button type="button" class="basic-button translate" id="pg_card_image_current" title="Use the image currently shown in the main view, and its prompt if the text is empty">Use Current Image</button>
                        <button type="button" class="basic-button translate" id="pg_card_image_clear">Remove Image</button>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <span id="pg_card_modal_error" class="modal_error_bottom"></span>
                <button type="button" class="btn btn-primary basic-button translate" id="pg_card_save">Save</button>
                <button type="button" class="btn btn-secondary basic-button translate" onclick="$('#pg_card_modal').modal('hide')">Cancel</button>
            </div>
        </div>
    </div>
</div>
<div class="modal" tabindex="-1" role="dialog" id="pg_folder_prompt_modal">
    <div class="modal-dialog" role="document">
        <div class="modal-content">
            <div class="modal-header"><h5 class="modal-title" id="pg_folder_prompt_title">Preview Prompt</h5></div>
            <div class="modal-body">
                <div class="pg-form-row pg-form-row-block"><label for="pg_folder_prompt_template" class="translate">Prompt used to generate previews here. {card} is replaced by the card text.</label><textarea class="auto-text auto-text-block" id="pg_folder_prompt_template" rows="3"></textarea></div>
                <div class="pg-form-row"><label for="pg_folder_prompt_aspect" class="translate" title="Shape of the generated previews. Tall (2:3) suits full-body shots, wide (3:2) suits places. The pixel count stays about the same as the Generate tab resolution.">Preview shape</label><select id="pg_folder_prompt_aspect"></select></div>
                <div class="pg-profile-source-note" id="pg_folder_prompt_note"></div>
                <div class="pg-profile-source-note pg-folder-prompt-example" id="pg_folder_prompt_example"></div>
            </div>
            <div class="modal-footer">
                <span id="pg_folder_prompt_error" class="modal_error_bottom"></span>
                <button type="button" class="btn btn-secondary basic-button translate" id="pg_folder_prompt_clear" title="Remove this folder's own prompt, so it uses the parent folder's or the profile's">Use Inherited</button>
                <button type="button" class="btn btn-primary basic-button translate" id="pg_folder_prompt_save">Save</button>
                <button type="button" class="btn btn-secondary basic-button translate" onclick="$('#pg_folder_prompt_modal').modal('hide')">Cancel</button>
            </div>
        </div>
    </div>
</div>
<div class="modal pg-image-modal" tabindex="-1" role="dialog" id="pg_image_modal">
    <div class="modal-dialog pg-image-modal-inner">
        <img id="pg_image_modal_img" alt="">
        <div class="pg-image-modal-caption"><b id="pg_image_modal_name"></b> <span id="pg_image_modal_text"></span></div>
        <div class="pg-image-modal-nav">
            <button class="basic-button" id="pg_image_modal_prev" title="Previous image (Left arrow)">&#x2039;</button>
            <button class="basic-button" id="pg_image_modal_next" title="Next image (Right arrow)">&#x203A;</button>
        </div>
    </div>
</div>
<div class="modal" tabindex="-1" role="dialog" id="pg_profile_modal">
    <div class="modal-dialog" role="document">
        <div class="modal-content">
            <div class="modal-header"><h5 class="modal-title" id="pg_profile_modal_title">Profile</h5></div>
            <div class="modal-body">
                <div class="pg-form-row"><label for="pg_profile_name" class="translate">Name</label><input type="text" class="auto-text" id="pg_profile_name" placeholder="eg MOSS, Anima, MiniMax H3"></div>
                <div class="pg-form-row" id="pg_profile_source_row"><label for="pg_profile_source" class="translate">Start from</label>
                    <select id="pg_profile_source" title="Fill the new profile with the cards of a pack"></select>
                    <input type="file" id="pg_profile_source_file" accept=".zip,application/zip" style="display:none">
                </div>
                <div class="pg-form-row pg-profile-source-note" id="pg_profile_source_note" style="display:none"></div>
                <div class="pg-form-row" id="pg_profile_separator_row"><label for="pg_profile_separator" class="translate">Join cards with</label>
                    <select id="pg_profile_separator">
                        <option value=", ">Comma — tag style (a, b, c)</option>
                        <option value=". ">Period — sentences (A. B. C)</option>
                        <option value="\n">New line</option>
                        <option value=" ">Space</option>
                    </select>
                </div>
                <div class="pg-form-row pg-form-row-block" id="pg_profile_description_row"><label for="pg_profile_description" class="translate">Description</label><textarea class="auto-text auto-text-block" id="pg_profile_description" rows="2" placeholder="Optional notes, eg which models this is for"></textarea></div>
                <div class="pg-form-row pg-form-row-block" id="pg_profile_preview_row"><label for="pg_profile_preview_template" class="translate" title="Prompt used by Generate Preview. {card} is replaced by the card text. Other parameters come from the Generate tab.">Preview prompt ({card} = card text)</label><textarea class="auto-text auto-text-block" id="pg_profile_preview_template" rows="2" placeholder="{card}"></textarea></div>
                <div class="pg-form-row" id="pg_profile_preview_seed_row"><label for="pg_profile_preview_seed" class="translate" title="The same seed for every card makes previews comparable. -1 = a random seed each time.">Preview seed</label><input type="number" class="auto-text" id="pg_profile_preview_seed" min="-1" step="1"></div>
                <div class="pg-form-row" id="pg_profile_preview_size_row"><label for="pg_profile_preview_size" class="translate" title="Preview images are scaled down to this size (longest side) before they are saved to the card, to keep the gallery and packs small. Generation itself uses the Generate tab resolution.">Preview image size</label>
                    <select id="pg_profile_preview_size">
                        <option value="256">256 px</option>
                        <option value="384">384 px</option>
                        <option value="512">512 px</option>
                        <option value="768">768 px</option>
                        <option value="1024">1024 px</option>
                        <option value="0">Original size</option>
                    </select>
                </div>
            </div>
            <div class="modal-footer">
                <span id="pg_profile_modal_error" class="modal_error_bottom"></span>
                <button type="button" class="btn btn-danger basic-button translate" id="pg_profile_delete" title="Only possible when the profile has no cards">Delete Profile</button>
                <button type="button" class="btn btn-primary basic-button translate" id="pg_profile_save">Save</button>
                <button type="button" class="btn btn-secondary basic-button translate" onclick="$('#pg_profile_modal').modal('hide')">Cancel</button>
            </div>
        </div>
    </div>
</div>`;
        let holder = document.createElement('div');
        holder.innerHTML = html;
        for (let child of [...holder.children]) {
            document.body.appendChild(child);
        }
        // Set separator values from JS so the newline value is exact (not subject to HTML attribute parsing).
        let sepOptions = getRequiredElementById('pg_profile_separator').options;
        [', ', '. ', '\n', ' '].forEach((value, i) => sepOptions[i].value = value);
        let drop = getRequiredElementById('pg_card_image_drop');
        let fileInput = getRequiredElementById('pg_card_image_file');
        getRequiredElementById('pg_card_image_choose').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                this.loadImageFile(fileInput.files[0]);
            }
            fileInput.value = '';
        });
        drop.addEventListener('click', () => fileInput.click());
        drop.addEventListener('dragover', (e) => {
            e.preventDefault();
            drop.classList.add('pg-image-drop-hover');
        });
        drop.addEventListener('dragleave', () => drop.classList.remove('pg-image-drop-hover'));
        drop.addEventListener('drop', (e) => {
            e.preventDefault();
            drop.classList.remove('pg-image-drop-hover');
            let file = [...(e.dataTransfer.files || [])].find(f => f.type.startsWith('image/'));
            if (file) {
                this.loadImageFile(file);
            }
            else {
                let uri = e.dataTransfer.getData('text/uri-list');
                if (uri) {
                    this.loadImageFromUrl(uri);
                }
            }
        });
        getRequiredElementById('pg_card_modal').addEventListener('paste', (e) => {
            let item = [...(e.clipboardData ? e.clipboardData.items : [])].find(i => i.type.startsWith('image/'));
            if (item) {
                e.preventDefault();
                this.loadImageFile(item.getAsFile());
            }
        });
        getRequiredElementById('pg_card_image_current').addEventListener('click', () => this.useCurrentImage());
        getRequiredElementById('pg_card_image_clear').addEventListener('click', () => this.setEditorImage('clear'));
        getRequiredElementById('pg_card_save').addEventListener('click', () => this.saveCard());
        getRequiredElementById('pg_card_profile').addEventListener('change', () => this.fillFolderList(getRequiredElementById('pg_card_profile').value));
        let sourceSelect = getRequiredElementById('pg_profile_source');
        let sourceFile = getRequiredElementById('pg_profile_source_file');
        sourceSelect.addEventListener('change', () => {
            if (sourceSelect.value == 'file') {
                sourceFile.click();
            }
            this.updateProfileSource();
        });
        sourceFile.addEventListener('change', () => {
            this.profileSourceFile = sourceFile.files.length > 0 ? sourceFile.files[0] : null;
            sourceFile.value = '';
            if (!this.profileSourceFile) {
                sourceSelect.value = '';
            }
            this.updateProfileSource();
        });
        getRequiredElementById('pg_profile_save').addEventListener('click', () => this.saveProfile());
        getRequiredElementById('pg_profile_delete').addEventListener('click', () => this.deleteProfile());
    }

    modalError(id, text) {
        getRequiredElementById(id).innerText = text || '';
    }

    // ===================== Card editor =====================

    /** Opens the card editor.
     * card: an existing card to edit, or null for a new one.
     * preset (new cards only): optional { image: url, prompt, name } to prefill, eg when adding a generated image. */
    openCardEditor(card, preset = null) {
        if (this.profiles.length == 0) {
            doNoticePopover('Create a profile first', 'notice-pop-red');
            this.openProfileEditor(null);
            return;
        }
        let profileName = this.profileData ? this.profileData.name : this.profiles[0].name;
        this.editingCard = card;
        this.editingImage = '';
        let folder = this.profileData && profileName == this.profileData.name ? (this.browser.folder || '') : '';
        let name = '';
        if (card) {
            let slash = card.path.lastIndexOf('/');
            folder = slash >= 0 ? card.path.substring(0, slash) : '';
            name = slash >= 0 ? card.path.substring(slash + 1) : card.path;
        }
        else if (preset && preset.name) {
            name = preset.name;
        }
        // A card can be created in any profile, but an existing card stays in its own profile.
        let profileSelect = getRequiredElementById('pg_card_profile');
        profileSelect.innerHTML = '';
        for (let profile of this.profiles) {
            let option = document.createElement('option');
            option.value = profile.name;
            option.innerText = profile.name;
            profileSelect.appendChild(option);
        }
        profileSelect.value = profileName;
        profileSelect.disabled = !!card;
        getRequiredElementById('pg_card_modal_title').innerText = card ? 'Edit Card' : (preset ? 'Add to Prompt Gallery' : 'New Card');
        getRequiredElementById('pg_card_folder').value = folder;
        getRequiredElementById('pg_card_name').value = name;
        getRequiredElementById('pg_card_prompt').value = card ? card.prompt : (preset && preset.prompt ? preset.prompt : '');
        this.fillFolderList(profileName);
        this.showEditorPreview(card && card.has_image ? this.imageUrl(card, true) : null);
        if (preset && preset.image) {
            this.loadImageFromUrl(preset.image);
        }
        this.modalError('pg_card_modal_error', '');
        $('#pg_card_modal').modal('show');
        setTimeout(() => getRequiredElementById(card ? 'pg_card_prompt' : 'pg_card_name').focus(), 300);
    }

    /** Fills the folder suggestions of the card editor for a profile (fetching its folders if it isn't the active one). */
    fillFolderList(profileName) {
        let datalist = getRequiredElementById('pg_folder_list');
        let fill = (folders) => {
            datalist.innerHTML = '';
            for (let f of folders) {
                let option = document.createElement('option');
                option.value = f;
                datalist.appendChild(option);
            }
        };
        if (this.profileData && profileName == this.profileData.name && this.cards) {
            fill(this.folders);
            return;
        }
        fill([]);
        genericRequest('PromptGalleryListCards', { profile: profileName }, data => fill(data.folders), 0, () => {});
    }

    showEditorPreview(src) {
        let img = getRequiredElementById('pg_card_image_preview');
        let placeholder = getRequiredElementById('pg_card_image_placeholder');
        if (src) {
            img.src = src;
            img.style.display = '';
            placeholder.style.display = 'none';
        }
        else {
            img.removeAttribute('src');
            img.style.display = 'none';
            placeholder.style.display = '';
        }
    }

    /** Sets the pending image for the card editor: a data URL, or 'clear'. */
    setEditorImage(dataUrl) {
        this.editingImage = dataUrl;
        this.showEditorPreview(dataUrl == 'clear' ? null : dataUrl);
    }

    loadImageFile(file) {
        if (!file || !file.type.startsWith('image/')) {
            this.modalError('pg_card_modal_error', 'That file is not an image.');
            return;
        }
        let reader = new FileReader();
        reader.onload = () => {
            this.setEditorImage(reader.result);
            this.fillPromptFromImage(reader.result);
        };
        reader.readAsDataURL(file);
    }

    /** If the editor's text is still empty, fills it (and an empty name) from the image's metadata. */
    fillPromptFromImage(src) {
        let promptBox = getRequiredElementById('pg_card_prompt');
        if (promptBox.value.trim()) {
            return;
        }
        promptGalleryMeta.extractPrompt(src).then(prompt => {
            if (prompt && !promptBox.value.trim()) {
                promptBox.value = prompt;
                let nameBox = getRequiredElementById('pg_card_name');
                if (!nameBox.value.trim()) {
                    nameBox.value = promptGalleryMeta.suggestName(prompt);
                }
            }
        });
    }

    loadImageFromUrl(url) {
        fetch(url).then(r => r.blob()).then(blob => {
            if (!blob.type.startsWith('image/')) {
                throw new Error('not an image');
            }
            this.loadImageFile(new File([blob], 'image', { type: blob.type }));
        }).catch(() => this.modalError('pg_card_modal_error', 'Could not load that image.'));
    }

    /** Uses the image currently shown in Swarm's main view, and fills the text from its metadata if empty. */
    useCurrentImage() {
        if (typeof currentImgSrc == 'undefined' || !currentImgSrc) {
            this.modalError('pg_card_modal_error', 'There is no current image in the main view.');
            return;
        }
        let promptBox = getRequiredElementById('pg_card_prompt');
        let prompt = typeof currentMetadataVal != 'undefined' ? promptGalleryMeta.promptFromSwarmMetadata(currentMetadataVal) : '';
        if (prompt && !promptBox.value.trim()) {
            promptBox.value = prompt;
        }
        // loadImageFromUrl also tries the image's own metadata if the text is still empty.
        this.loadImageFromUrl(currentImgSrc);
    }

    saveCard() {
        let folder = getRequiredElementById('pg_card_folder').value.trim().replace(/^\/+|\/+$/g, '');
        let name = getRequiredElementById('pg_card_name').value.trim();
        if (!name) {
            this.modalError('pg_card_modal_error', 'Please enter a name.');
            return;
        }
        if (name.includes('/') || name.includes('\\')) {
            this.modalError('pg_card_modal_error', 'The name cannot contain slashes, use the Folder field instead.');
            return;
        }
        let path = folder ? `${folder}/${name}` : name;
        let profileName = getRequiredElementById('pg_card_profile').value;
        let input = {
            profile: profileName,
            path: path,
            prompt: getRequiredElementById('pg_card_prompt').value,
            image: this.editingImage || '',
            old_path: this.editingCard ? this.editingCard.path : ''
        };
        let saveButton = getRequiredElementById('pg_card_save');
        saveButton.disabled = true;
        genericRequest('PromptGallerySaveCard', input, () => {
            saveButton.disabled = false;
            $('#pg_card_modal').modal('hide');
            if (this.profileData && profileName == this.profileData.name) {
                this.softReload();
            }
            else {
                doNoticePopover(`Saved to profile '${profileName}'`, 'notice-pop-green');
            }
        }, 0, (e) => {
            saveButton.disabled = false;
            this.modalError('pg_card_modal_error', e);
        });
    }

    async deleteCard(card) {
        if (!await promptGalleryDialog({ message: `Delete card '${card.path}'? Its text and image files will be removed.`, okLabel: 'Delete', danger: true })) {
            return;
        }
        genericRequest('PromptGalleryDeleteCard', { profile: this.profileData.name, path: card.path }, () => this.softReload());
    }

    // ===================== Folders =====================

    async createFolder() {
        if (!this.profileData) {
            return;
        }
        let base = this.browser.folder || '';
        let name = await promptGalleryDialog({ message: base ? `New folder inside '${base}':` : 'New folder name:', input: '', okLabel: 'Create' });
        if (!name || !name.trim()) {
            return;
        }
        let path = base ? `${base}/${name.trim()}` : name.trim();
        genericRequest('PromptGalleryCreateFolder', { profile: this.profileData.name, path: path }, () => this.softReload(path));
    }

    async deleteCurrentFolder() {
        let folder = this.browser.folder || '';
        if (!this.profileData || !folder) {
            doNoticePopover('Open a folder first', 'notice-pop-red');
            return;
        }
        if (!await promptGalleryDialog({ message: `Delete folder '${folder}'? This only works if it has no cards.`, okLabel: 'Delete', danger: true })) {
            return;
        }
        genericRequest('PromptGalleryDeleteFolder', { profile: this.profileData.name, path: folder }, () => this.softReload(folder.includes('/') ? folder.substring(0, folder.lastIndexOf('/')) : ''));
    }

    // ===================== Profile editor =====================

    openProfileEditor(profile) {
        this.editingProfile = profile;
        this.profileSourceFile = null;
        getRequiredElementById('pg_profile_modal_title').innerText = profile ? `Edit Profile '${profile.name}'` : 'New Profile';
        getRequiredElementById('pg_profile_name').value = profile ? profile.name : '';
        getRequiredElementById('pg_profile_separator').value = profile ? profile.separator : ', ';
        getRequiredElementById('pg_profile_description').value = profile ? profile.description : '';
        getRequiredElementById('pg_profile_preview_template').value = profile && profile.preview_template != '{card}' ? profile.preview_template : '';
        getRequiredElementById('pg_profile_preview_seed').value = profile && profile.preview_seed != null ? profile.preview_seed : 1;
        let sizeSelect = getRequiredElementById('pg_profile_preview_size');
        let size = `${profile && profile.preview_size != null ? profile.preview_size : 512}`;
        if (![...sizeSelect.options].some(o => o.value == size)) {
            sizeSelect.add(new Option(`${size} px`, size));
        }
        sizeSelect.value = size;
        getRequiredElementById('pg_profile_delete').style.display = profile ? '' : 'none';
        getRequiredElementById('pg_profile_source_row').style.display = profile ? 'none' : '';
        let sourceSelect = getRequiredElementById('pg_profile_source');
        sourceSelect.innerHTML = '<option value="">Empty profile</option><option value="file">Pack file (.zip)...</option>';
        sourceSelect.value = '';
        this.updateProfileSource();
        this.modalError('pg_profile_modal_error', '');
        $('#pg_profile_modal').modal('show');
        setTimeout(() => getRequiredElementById('pg_profile_name').focus(), 300);
    }

    /** Shows what the selected "Start from" source will do. A pack brings its own separator and preview prompt. */
    updateProfileSource() {
        let value = getRequiredElementById('pg_profile_source').value;
        let note = getRequiredElementById('pg_profile_source_note');
        let fromPack = !this.editingProfile && value != '';
        getRequiredElementById('pg_profile_separator_row').style.display = fromPack ? 'none' : '';
        getRequiredElementById('pg_profile_preview_row').style.display = fromPack ? 'none' : '';
        getRequiredElementById('pg_profile_preview_seed_row').style.display = fromPack ? 'none' : '';
        getRequiredElementById('pg_profile_preview_size_row').style.display = fromPack ? 'none' : '';
        getRequiredElementById('pg_profile_description_row').style.display = fromPack ? 'none' : '';
        let nameBox = getRequiredElementById('pg_profile_name');
        let text = '';
        if (value == 'file' && this.profileSourceFile) {
            text = `File: ${this.profileSourceFile.name}`;
            if (!nameBox.value.trim()) {
                nameBox.value = this.profileSourceFile.name.replace(/\.zip$/i, '');
            }
        }
        if (fromPack) {
            text += (text ? ' ' : '') + 'The separator and preview prompt come from the pack; you can change them later with Edit.';
        }
        note.innerText = text;
        note.style.display = text ? '' : 'none';
    }

    async saveProfile() {
        let name = getRequiredElementById('pg_profile_name').value.trim();
        if (!name) {
            this.modalError('pg_profile_modal_error', 'Please enter a name.');
            return;
        }
        let source = this.editingProfile ? '' : getRequiredElementById('pg_profile_source').value;
        let done = (profileName) => {
            $('#pg_profile_modal').modal('hide');
            this.loadProfiles(profileName);
        };
        if (source == 'file') {
            if (!this.profileSourceFile) {
                this.modalError('pg_profile_modal_error', 'Choose a .zip pack file first.');
                return;
            }
            let saveButton = getRequiredElementById('pg_profile_save');
            saveButton.disabled = true;
            try {
                let result = await this.importPackFile(this.profileSourceFile, { new_profile: name });
                if (result) {
                    done(result.profile);
                }
            }
            finally {
                saveButton.disabled = false;
            }
            return;
        }
        let input = {
            name: name,
            separator: getRequiredElementById('pg_profile_separator').value,
            description: getRequiredElementById('pg_profile_description').value,
            old_name: this.editingProfile ? this.editingProfile.name : '',
            preview_template: getRequiredElementById('pg_profile_preview_template').value.trim() || '{card}',
            preview_seed: getRequiredElementById('pg_profile_preview_seed').value.trim() || '1',
            preview_size: getRequiredElementById('pg_profile_preview_size').value
        };
        genericRequest('PromptGallerySaveProfile', input, data => {
            done(data.profile.name);
        }, 0, (e) => this.modalError('pg_profile_modal_error', e));
    }

    async deleteProfile() {
        let profile = this.editingProfile;
        if (!profile || !await promptGalleryDialog({ message: `Delete profile '${profile.name}'? This only works if it has no cards.`, okLabel: 'Delete', danger: true })) {
            return;
        }
        genericRequest('PromptGalleryDeleteProfile', { name: profile.name }, () => {
            $('#pg_profile_modal').modal('hide');
            this.loadProfiles();
        }, 0, (e) => this.modalError('pg_profile_modal_error', e));
    }
}

let promptGallery = null;
try {
    if (document.getElementById('rightsidebarcollection') && typeof genTabLayout != 'undefined') {
        promptGallery = new PromptGalleryUI();
    }
}
catch (e) {
    console.error('Prompt Gallery failed to initialize', e);
}
