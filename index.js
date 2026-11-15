import {
    extension_prompt_roles,
    extension_prompt_types,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { selected_world_info, loadWorldInfo } from '../../../world-info.js';

const MODULE_NAME = 'grimoire';
const EXTENSION_PROMPT_KEY = 'GRIMOIRE';

const defaultSettings = {
    enabled: true,
    url: 'http://127.0.0.1:5005',
    apiKey: '',
    maxTokens: 2000,
    depth: 2,
    position: extension_prompt_types.IN_CHAT,
    role: extension_prompt_roles.SYSTEM,
    scan: false,
    messageCount: 10,
    externalUserId: '',
    sendCharacter: true,
    sendLorebook: true,
    includeNames: true,
};

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    applySettingsToUI();
}

function applySettingsToUI() {
    const s = extension_settings[MODULE_NAME];
    $('#grimoire_enabled').prop('checked', s.enabled);
    $('#grimoire_url').val(s.url);
    $('#grimoire_api_key').val(s.apiKey);
    $('#grimoire_max_tokens').val(s.maxTokens);
    $('#grimoire_depth').val(s.depth);
    $(`input[name="grimoire_position"][value="${s.position}"]`).prop('checked', true);
    $('#grimoire_role').val(s.role);
    $('#grimoire_scan').prop('checked', s.scan);
    $('#grimoire_message_count').val(s.messageCount);
    $('#grimoire_external_user_id').val(s.externalUserId);
    $('#grimoire_send_character').prop('checked', s.sendCharacter);
    $('#grimoire_send_lorebook').prop('checked', s.sendLorebook);
    $('#grimoire_include_names').prop('checked', s.includeNames);
}

/**
 * Collect enabled lorebook entries from the active character book and global world info books.
 * @returns {Promise<Array<{keys: string[], description: string}>>}
 */
async function getActiveLorebookEntries() {
    const entries = [];
    const ctx = getContext();

    // Character book entries (no async fetch needed — loaded in memory with the character)
    const char = ctx.characters[ctx.characterId];
    if (char?.data?.character_book?.entries) {
        for (const e of char.data.character_book.entries) {
            if (e.enabled !== false && e.key?.length && e.content) {
                entries.push({ keys: e.key, description: e.content });
            }
        }
    }

    // Global world info books (live binding — always reflects current selection)
    for (const bookName of (selected_world_info ?? [])) {
        try {
            const book = await loadWorldInfo(bookName);
            if (book?.entries) {
                for (const e of Object.values(book.entries)) {
                    if (e.enabled !== false && e.key?.length && e.content) {
                        entries.push({ keys: e.key, description: e.content });
                    }
                }
            }
        } catch (err) {
            console.warn(`Grimoire: Failed to load world info book "${bookName}"`, err);
        }
    }

    return entries;
}

/**
 * Generate interceptor: called by ST before each generation.
 * Fetches relevant memories from Grimoire and injects them into the prompt.
 * @param {object[]} chat Array of chat message objects
 * @param {number} _contextSize Context size (unused)
 * @param {function} _abort Abort callback (unused)
 * @param {string} type Generation type (e.g. 'normal', 'quiet', 'impersonate')
 */
globalThis.grimoire_intercept = async function(chat, _contextSize, _abort, type) {
    const s = extension_settings[MODULE_NAME];

    // Always clear any previous injection first
    setExtensionPrompt(EXTENSION_PROMPT_KEY, '', s.position, s.depth, s.scan, s.role);

    if (!s.enabled) {
        return;
    }

    // Skip quiet/internal generations that don't go to the user
    if (type === 'quiet') {
        return;
    }

    if (!chat || !Array.isArray(chat) || chat.length === 0) {
        return;
    }

    const ctx = getContext();
    const chatId = ctx.getCurrentChatId();
    if (!chatId) {
        console.debug('Grimoire: No active chat, skipping');
        return;
    }

    try {
        // Build messages payload from recent non-system messages
        const recentMessages = chat
            .filter(m => !m.is_system && m.mes)
            .slice(-s.messageCount)
            .map(m => ({ sender_name: m.name, text: m.mes }));

        if (recentMessages.length === 0) {
            return;
        }

        /** @type {object} */
        const chatData = {
            external_chat_id: chatId,
            external_user_id: s.externalUserId || ctx.name1 || null,
            include_names: s.includeNames,
            max_tokens: s.maxTokens || null,
            messages: recentMessages,
        };

        // Active character card (solo chats only; skip for group chats)
        if (s.sendCharacter && ctx.characterId !== undefined && ctx.characterId !== null) {
            const char = ctx.characters[ctx.characterId];
            if (char) {
                chatData.characters = [{
                    name: char.name,
                    description: char.description || null,
                    character_note: char.data?.creator_notes || null,
                }];
            }
        }

        // Active lorebook entries
        if (s.sendLorebook) {
            chatData.lorebook_entries = await getActiveLorebookEntries();
        }

        const headers = { 'Content-Type': 'application/json' };
        if (s.apiKey) {
            headers['Authorization'] = `Bearer ${s.apiKey}`;
        }

        const response = await fetch(`${s.url}/grimoire/get_data`, {
            method: 'POST',
            headers,
            body: JSON.stringify(chatData),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.warn(`Grimoire: API returned ${response.status}`, text);
            toastr.warning(`Grimoire: API error (${response.status}). Memory not injected.`, 'Grimoire');
            return;
        }

        /** @type {Array<{text: string, relevance: number}>} */
        const knowledge = await response.json();

        if (!Array.isArray(knowledge) || knowledge.length === 0) {
            console.debug('Grimoire: No memories returned for this context');
            return;
        }

        const injectedText = knowledge.map(k => k.text).join('\n');
        setExtensionPrompt(EXTENSION_PROMPT_KEY, injectedText, s.position, s.depth, s.scan, s.role);
        console.debug(`Grimoire: Injected ${knowledge.length} memory entries at depth ${s.depth}`);

    } catch (err) {
        console.error('Grimoire: Failed to retrieve memories', err);
        toastr.warning('Grimoire: Connection failed. Memory not injected.', 'Grimoire');
    }
};

async function init() {
    const html = await renderExtensionTemplateAsync('third-party/Grimoire-ST-Extension', 'settings');
    $('#extensions_settings').append(html);
    loadSettings();

    $('#grimoire_enabled').on('change', () => {
        extension_settings[MODULE_NAME].enabled = !!$('#grimoire_enabled').prop('checked');
        saveSettingsDebounced();
    });
    $('#grimoire_url').on('input', () => {
        extension_settings[MODULE_NAME].url = String($('#grimoire_url').val()).trim();
        saveSettingsDebounced();
    });
    $('#grimoire_api_key').on('input', () => {
        extension_settings[MODULE_NAME].apiKey = String($('#grimoire_api_key').val());
        saveSettingsDebounced();
    });
    $('#grimoire_max_tokens').on('input', () => {
        extension_settings[MODULE_NAME].maxTokens = Number($('#grimoire_max_tokens').val());
        saveSettingsDebounced();
    });
    $('#grimoire_depth').on('input', () => {
        extension_settings[MODULE_NAME].depth = Number($('#grimoire_depth').val());
        saveSettingsDebounced();
    });
    $('input[name="grimoire_position"]').on('change', () => {
        extension_settings[MODULE_NAME].position = Number($('input[name="grimoire_position"]:checked').val());
        saveSettingsDebounced();
    });
    $('#grimoire_role').on('change', () => {
        extension_settings[MODULE_NAME].role = Number($('#grimoire_role').val());
        saveSettingsDebounced();
    });
    $('#grimoire_scan').on('change', () => {
        extension_settings[MODULE_NAME].scan = !!$('#grimoire_scan').prop('checked');
        saveSettingsDebounced();
    });
    $('#grimoire_message_count').on('input', () => {
        extension_settings[MODULE_NAME].messageCount = Number($('#grimoire_message_count').val());
        saveSettingsDebounced();
    });
    $('#grimoire_external_user_id').on('input', () => {
        extension_settings[MODULE_NAME].externalUserId = String($('#grimoire_external_user_id').val()).trim();
        saveSettingsDebounced();
    });
    $('#grimoire_send_character').on('change', () => {
        extension_settings[MODULE_NAME].sendCharacter = !!$('#grimoire_send_character').prop('checked');
        saveSettingsDebounced();
    });
    $('#grimoire_send_lorebook').on('change', () => {
        extension_settings[MODULE_NAME].sendLorebook = !!$('#grimoire_send_lorebook').prop('checked');
        saveSettingsDebounced();
    });
    $('#grimoire_include_names').on('change', () => {
        extension_settings[MODULE_NAME].includeNames = !!$('#grimoire_include_names').prop('checked');
        saveSettingsDebounced();
    });
}

init();
