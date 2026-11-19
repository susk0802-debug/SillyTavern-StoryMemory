import {
    activateSendButtons,
    deactivateSendButtons,
    doNewChat,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateRaw,
    isGenerating,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParamsExtended,
} from '../../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { parseReasoningFromString } from '../../../reasoning.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { debounce, waitUntilCondition } from '../../../utils.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';

const MODULE = 'story_memory';
const EXTENSION_PATH = `third-party/${new URL(import.meta.url).pathname.split('/').at(-2)}`;
/** Key in `message.extra`: a summary stored there covers that message and everything before it. */
const ANCHOR_KEY = 'story_memory';
/** Key in `chat_metadata`: `{ seed }` is a summary carried over from another chat, covering none of this chat's messages. */
const META_KEY = 'story_memory';
/** Transient chat index tag, copied by Generate() into its prompt copies of the messages; never serialized. */
const INDEX_TAG = Symbol('storyMemoryIndex');
const TAG = 'Story Memory';

const defaultPrompt = `You are maintaining a running summary of an ongoing story between {{user}} and {{char}}.
Merge the existing summary (if one is given) with the new messages into ONE updated summary.
- Keep every important fact: characters, relationships, locations, items, promises, secrets, open plot threads and the current situation.
- Keep earlier events, but compress them more than recent ones.
- Write in past tense, third person, plain prose.
- Limit the summary to about {{words}} words.
Respond with the updated summary only, without any preamble or commentary.`;

const defaultAppendPrompt = `You are keeping a running record of an ongoing story between {{user}} and {{char}}.
The existing summary (if one is given) is read-only context: do NOT repeat, rewrite, shorten or correct it.
Write only the continuation that covers the new messages; it will be appended directly after the existing summary.
- Keep every important fact: characters, relationships, locations, items, promises, secrets, open plot threads and the current situation.
- Write in past tense, third person, plain prose.
- Limit the new part to about {{words}} words.
Respond with the new part only, without any preamble or commentary.`;

const modes = Object.freeze({
    /** The summarizer returns a full summary that replaces the previous one. */
    REWRITE: 'rewrite',
    /** The summarizer only sees the previous summary and its output is appended to it. */
    APPEND: 'append',
});

const SETTINGS_VERSION = 2;

const defaultSettings = Object.freeze({
    settingsVersion: SETTINGS_VERSION,
    enabled: true,
    profileId: '',
    mode: modes.REWRITE,
    prompt: defaultPrompt,
    appendPrompt: defaultAppendPrompt,
    words: 400,
    responseLength: 2048,
    autoInterval: 20,
    maxMessagesPerRequest: 0,
    contextBudget: 0,
    blockSending: true,
    template: '[Story so far:\n{{summary}}]',
    position: extension_prompt_types.IN_PROMPT,
    depth: 2,
    role: extension_prompt_roles.SYSTEM,
    scan: false,
    keepMessages: 0,
    onlyHideSummarized: true,
});

/**
 * Loads saved settings over the defaults and upgrades values saved by older versions.
 */
function loadSettings() {
    const saved = extension_settings[MODULE] ?? {};
    const s = { ...defaultSettings, ...saved, settingsVersion: SETTINGS_VERSION };
    if (!(saved.settingsVersion >= 2) && saved.maxMessagesPerRequest === 40) {
        // v1 split summaries into 40-message requests by default; v2 sends every pending message at once.
        s.maxMessagesPerRequest = 0;
    }
    extension_settings[MODULE] = s;
}

let busy = false;
let stopRequested = false;

function settings() {
    return extension_settings[MODULE];
}

/**
 * Current summary state of the open chat.
 * @returns {{ index: number, summary: string, source: 'anchor' | 'seed' | 'none' }}
 */
function getState() {
    const { chat, chatMetadata } = getContext();
    for (let i = chat.length - 1; i >= 0; i--) {
        const anchor = chat[i]?.extra?.[ANCHOR_KEY];
        if (anchor && typeof anchor.summary === 'string') {
            return { index: i, summary: anchor.summary, source: 'anchor' };
        }
    }
    const seed = chatMetadata?.[META_KEY]?.seed;
    if (typeof seed === 'string' && seed) {
        return { index: -1, summary: seed, source: 'seed' };
    }
    return { index: -1, summary: '', source: 'none' };
}

function hasOpenChat() {
    return !!getContext().getCurrentChatId();
}

function isSummarizable(message) {
    return !!message && !message.is_system && typeof message.mes === 'string' && message.mes.trim().length > 0;
}

/**
 * Chat indices not yet covered by the summary.
 * @param {boolean} includeLast Whether the newest message counts (it may still be swiped/regenerated)
 * @returns {number[]}
 */
function getPendingIndices(includeLast) {
    const { chat } = getContext();
    const { index } = getState();
    const end = includeLast ? chat.length : chat.length - 1;
    const pending = [];
    for (let i = index + 1; i < end; i++) {
        if (isSummarizable(chat[i])) {
            pending.push(i);
        }
    }
    return pending;
}

/**
 * @returns {number} Token limit for one summary request, or 0 for no limit
 */
function getSummaryBudget() {
    return Math.max(0, settings().contextBudget || 0);
}

function applyInjection() {
    const s = settings();
    const summary = hasOpenChat() ? getState().summary.trim() : '';
    const value = s.enabled && summary ? substituteParamsExtended(s.template, { summary }) : '';
    setExtensionPrompt(MODULE, value, s.position, s.depth, s.scan, s.role);
}

/**
 * Sends one summarization request through the selected connection profile or the current main API.
 * @param {string} systemPrompt
 * @param {string} userText
 * @returns {Promise<string>} Summary text with reasoning removed
 */
async function requestSummary(systemPrompt, userText) {
    const s = settings();
    let raw;
    if (s.profileId) {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userText },
        ];
        const prompt = ConnectionManagerRequestService.constructPrompt(messages, s.profileId);
        const result = await ConnectionManagerRequestService.sendRequest(s.profileId, prompt, s.responseLength, {
            stream: false,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
        });
        raw = typeof result === 'string' ? result : (result && 'content' in result ? result.content : '');
    } else {
        raw = await generateRaw({ prompt: userText, systemPrompt, responseLength: s.responseLength });
    }
    const text = String(raw ?? '');
    // Strip a leading reasoning block even when reasoning auto-parse is off: it never belongs in the summary.
    return (parseReasoningFromString(text)?.content ?? text).trim();
}

/**
 * Summarizes the oldest pending messages that fit in one request and anchors the result.
 * @param {number[]} pending Pending chat indices, ascending
 * @param {string} chatId Chat the request belongs to
 * @returns {Promise<number>} Number of messages folded into the summary
 */
async function summarizeBatch(pending, chatId) {
    const s = settings();
    const { chat } = getContext();
    const previous = getState().summary.trim();
    const append = s.mode === modes.APPEND;
    const systemPrompt = substituteParamsExtended(append ? s.appendPrompt : s.prompt, { words: s.words });
    const header = previous
        ? `[${append ? 'Existing summary (read-only)' : 'Current summary'}]\n${previous}\n\n[New messages]\n`
        : '[Messages]\n';
    const budget = getSummaryBudget();
    const PADDING = 64;
    let used = budget > 0 ? await getTokenCountAsync(`${systemPrompt}\n${header}`, PADDING) : 0;
    const lines = [];
    let lastIndex = -1;

    for (const i of pending) {
        const message = chat[i];
        const line = `${message.name}: ${message.mes}`;
        if (budget > 0) {
            const tokens = await getTokenCountAsync(`${line}\n\n`);
            if (used + tokens > budget) {
                break;
            }
            used += tokens;
        }
        lines.push(line);
        lastIndex = i;
        if (s.maxMessagesPerRequest > 0 && lines.length >= s.maxMessagesPerRequest) {
            break;
        }
    }

    if (!lines.length) {
        throw new Error(`Message #${pending[0]} does not fit: prompt + current summary use ~${used} of ${budget} budget tokens. Raise "Summary request token budget" (0 = no limit) or shorten the summary.`);
    }

    const target = chat[lastIndex];
    const result = await requestSummary(systemPrompt, header + lines.join('\n\n'));
    if (!result) {
        throw new Error('The summarizer returned an empty response.');
    }
    const summary = append && previous ? `${previous}\n\n${result}` : result;

    const context = getContext();
    if (context.getCurrentChatId() !== chatId || context.chat[lastIndex] !== target) {
        throw new Error('The chat changed while summarizing; the result was discarded.');
    }

    target.extra ??= {};
    target.extra[ANCHOR_KEY] = { summary, created: Date.now() };
    await context.saveChat();
    refresh();
    return lines.length;
}

/**
 * Folds pending messages into the summary, one request per batch, until none are left.
 * @param {object} options
 * @param {boolean} options.includeLast Whether to summarize the newest message too
 * @returns {Promise<boolean>} True when no pending messages remain
 */
async function summarizePending({ includeLast }) {
    if (busy) {
        toastr.info('A summary update is already running.', TAG);
        return false;
    }
    const chatId = getContext().getCurrentChatId();
    if (!chatId) {
        return false;
    }

    busy = true;
    stopRequested = false;
    renderButtons();
    const block = settings().blockSending;
    if (block) {
        deactivateSendButtons();
    }

    let toast = null;
    let done = 0;
    try {
        for (;;) {
            const pending = getPendingIndices(includeLast);
            if (!pending.length) {
                return true;
            }
            if (stopRequested) {
                toastr.info(`Stopped. ${pending.length} messages are still unsummarized.`, TAG);
                return false;
            }
            toastr.clear(toast);
            toast = toastr.info(`${done} summarized, ${pending.length} pending…`, `${TAG}: summarizing`, { timeOut: 0, extendedTimeOut: 0 });
            done += await summarizeBatch(pending, chatId);
        }
    } catch (error) {
        console.error(`[${TAG}]`, error);
        toastr.error(error instanceof Error ? error.message : String(error), `${TAG}: summary failed`, { timeOut: 10000 });
        return false;
    } finally {
        toastr.clear(toast);
        busy = false;
        if (block) {
            activateSendButtons();
        }
        refresh();
    }
}

async function onMessageRendered() {
    const s = settings();
    if (!s.enabled || s.autoInterval <= 0 || busy) {
        return;
    }
    try {
        await waitUntilCondition(() => !isGenerating(), 120000, 250);
    } catch {
        return;
    }
    if (getPendingIndices(false).length >= s.autoInterval) {
        await summarizePending({ includeLast: false });
    }
}

/**
 * Generate interceptor: drops the oldest chat messages from the prompt so that at most `keepMessages` remain.
 * With `onlyHideSummarized`, only messages already covered by the summary are dropped.
 * @param {object[]} chat Prompt copy of the chat built by Generate()
 */
globalThis.storyMemory_trimContext = function (chat) {
    const s = settings();
    if (!s?.enabled || !(s.keepMessages > 0) || chat.length <= s.keepMessages || !hasOpenChat()) {
        return;
    }
    let drop = chat.length - s.keepMessages;
    if (s.onlyHideSummarized) {
        const covered = getState().index;
        let coveredDrop = 0;
        while (coveredDrop < drop) {
            const index = chat[coveredDrop][INDEX_TAG];
            if (typeof index !== 'number' || index > covered) {
                break;
            }
            coveredDrop++;
        }
        drop = coveredDrop;
    }
    if (drop > 0) {
        chat.splice(0, drop);
        console.debug(`[${TAG}] Left ${drop} old messages out of the prompt`);
    }
};

function tagChatIndices() {
    getContext().chat.forEach((message, index) => {
        message[INDEX_TAG] = index;
    });
}

const saveChatDebounced = debounce(() => getContext().saveChat(), 500);

function onSummaryInput() {
    if (!hasOpenChat()) {
        return;
    }
    const value = String($('#story_memory_text').val());
    const context = getContext();
    const state = getState();
    if (state.source === 'anchor') {
        context.chat[state.index].extra[ANCHOR_KEY].summary = value;
    } else {
        context.chatMetadata[META_KEY] = { ...context.chatMetadata[META_KEY], seed: value };
    }
    applyInjection();
    renderStatus();
    saveChatDebounced();
}

async function onUndoClick() {
    if (busy || !hasOpenChat()) {
        return;
    }
    const context = getContext();
    const state = getState();
    if (state.source === 'anchor') {
        delete context.chat[state.index].extra[ANCHOR_KEY];
    } else if (state.source === 'seed') {
        const confirmed = await callGenericPopup('Remove the summary carried over from the previous chat?', POPUP_TYPE.CONFIRM);
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        delete context.chatMetadata[META_KEY];
    } else {
        toastr.info('There is no summary to undo.', TAG);
        return;
    }
    await context.saveChat();
    refresh(true);
}

async function onSummarizeClick() {
    if (busy) {
        stopRequested = true;
        renderButtons();
        return;
    }
    if (!hasOpenChat()) {
        return;
    }
    if (isGenerating()) {
        toastr.warning('Wait for the current generation to finish.', TAG);
        return;
    }
    if (!getPendingIndices(true).length) {
        toastr.info('Every message is already in the summary.', TAG);
        return;
    }
    if (await summarizePending({ includeLast: true })) {
        toastr.success('Summary is up to date.', TAG);
    }
}

async function onNewChatClick() {
    if (busy || !hasOpenChat()) {
        return;
    }
    if (isGenerating()) {
        toastr.warning('Wait for the current generation to finish.', TAG);
        return;
    }

    const pending = getPendingIndices(true).length;
    if (pending > 0) {
        const choice = await callGenericPopup(
            `${pending} messages of this chat are not in the summary yet. Summarize them before starting the new chat?`,
            POPUP_TYPE.CONFIRM,
            '',
            {
                okButton: 'Summarize first',
                cancelButton: 'Cancel',
                customButtons: [{ text: 'Use summary as is', result: POPUP_RESULT.CUSTOM1, appendAtEnd: true }],
            },
        );
        if (choice === POPUP_RESULT.AFFIRMATIVE) {
            if (!await summarizePending({ includeLast: true })) {
                return;
            }
        } else if (choice !== POPUP_RESULT.CUSTOM1) {
            return;
        }
    }

    const summary = getState().summary.trim();
    if (!summary) {
        toastr.warning('There is no summary to carry over.', TAG);
        return;
    }
    const fromChat = getContext().getCurrentChatId();

    await doNewChat({ deleteCurrentChat: false });

    const context = getContext();
    if (!context.getCurrentChatId() || context.getCurrentChatId() === fromChat) {
        toastr.error('Could not start a new chat.', TAG);
        return;
    }
    context.chatMetadata[META_KEY] = { seed: summary, from: fromChat };
    await context.saveMetadata();
    refresh(true);
    toastr.success('New chat started from the summary.', TAG);
}

async function onImportClick() {
    if (busy || !hasOpenChat()) {
        return;
    }
    const context = getContext();
    const builtIn = context.chat.findLast(message => typeof message?.extra?.memory === 'string' && message.extra.memory.trim())?.extra.memory.trim();
    if (!builtIn) {
        toastr.info('This chat has no summary from the built-in Summarize extension.', TAG);
        return;
    }
    if (getState().source !== 'none') {
        const confirmed = await callGenericPopup('Replace the current Story Memory summary with the built-in one? All messages of this chat will count as not yet summarized.', POPUP_TYPE.CONFIRM);
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
    }
    for (const message of context.chat) {
        if (message?.extra?.[ANCHOR_KEY]) {
            delete message.extra[ANCHOR_KEY];
        }
    }
    context.chatMetadata[META_KEY] = { ...context.chatMetadata[META_KEY], seed: builtIn };
    await context.saveChat();
    refresh(true);
    toastr.success('Imported. Click "Summarize now" to fold this chat\'s messages into it.', TAG);
}

function renderButtons() {
    const open = hasOpenChat();
    $('#story_memory_summarize span').text(busy ? (stopRequested ? 'Stopping…' : 'Stop after this batch') : 'Summarize now');
    $('#story_memory_summarize').toggleClass('disabled', !open || stopRequested);
    $('#story_memory_undo, #story_memory_new_chat, #story_memory_import').toggleClass('disabled', !open || busy);
    $('#story_memory_text').prop('disabled', !open);
}

function renderStatus() {
    const s = settings();
    if (!hasOpenChat()) {
        $('#story_memory_status').text('No chat open.');
        return;
    }
    const { chat } = getContext();
    const state = getState();
    const lines = [];

    if (state.source === 'anchor') {
        lines.push(`Covers messages #0–#${state.index}.`);
    } else if (state.source === 'seed') {
        lines.push('Carried over from a previous chat; covers none of this chat\'s messages yet.');
    } else {
        lines.push('No summary yet.');
    }
    lines.push(`${getPendingIndices(true).length} messages not yet summarized.`);

    const prompted = [];
    chat.forEach((message, index) => !message.is_system && prompted.push(index));
    if (s.enabled && s.keepMessages > 0 && prompted.length > s.keepMessages) {
        const overLimit = prompted.length - s.keepMessages;
        const covered = prompted.filter(index => index <= state.index).length;
        const dropped = s.onlyHideSummarized ? Math.min(overLimit, covered) : overLimit;
        lines.push(`Next prompt: ${prompted.length - dropped} of ${prompted.length} messages, ${dropped} left out.`);
        if (dropped < overLimit) {
            lines.push(`${overLimit - dropped} messages over the limit are still sent because they are not summarized yet.`);
        }
    }

    $('#story_memory_status').text(lines.join('\n'));
}

/**
 * Re-reads the chat state into the prompt and the UI.
 * @param {boolean} [force] Overwrite the summary box even while it has focus
 */
function refresh(force = false) {
    applyInjection();
    const textarea = $('#story_memory_text');
    if (force || !textarea.is(':focus')) {
        textarea.val(hasOpenChat() ? getState().summary : '');
    }
    renderStatus();
    renderButtons();
    $('#story_memory_builtin_warning').toggle(!extension_settings.disabledExtensions.includes('memory'));
    const append = settings().mode === modes.APPEND;
    $('#story_memory_prompt_block').toggle(!append);
    $('#story_memory_append_prompt_block').toggle(append);
}

function populateProfiles() {
    const select = $('#story_memory_profile');
    const current = settings().profileId;
    select.empty().append(new Option('Same as current connection', ''));
    let profiles = [];
    try {
        profiles = ConnectionManagerRequestService.getSupportedProfiles();
    } catch {
        // Connection Manager disabled: only the current connection is available.
    }
    for (const profile of [...profiles].sort((a, b) => a.name.localeCompare(b.name))) {
        select.append(new Option(profile.name, profile.id));
    }
    if (current && !profiles.some(profile => profile.id === current)) {
        select.append(new Option('(missing profile)', current));
    }
    select.val(current);
}

function bindSettings() {
    const s = settings();
    $('#story_memory_settings [data-sm-setting]').each(function () {
        const element = $(this);
        const key = element.data('sm-setting');
        const isCheckbox = element.is(':checkbox');
        const isNumber = element.attr('type') === 'number' || element.data('sm-type') === 'number';

        if (isCheckbox) {
            element.prop('checked', !!s[key]);
        } else {
            element.val(s[key]);
        }

        element.on(isCheckbox || element.is('select') ? 'change' : 'input', () => {
            if (isCheckbox) {
                s[key] = element.prop('checked');
            } else if (isNumber) {
                const value = Number(element.val());
                if (!Number.isFinite(value)) {
                    return;
                }
                s[key] = value;
            } else {
                s[key] = String(element.val());
            }
            saveSettingsDebounced();
            refresh();
        });
    });

    $('#story_memory_profile').on('change', function () {
        s.profileId = String($(this).val());
        saveSettingsDebounced();
    });
    $('#story_memory_prompt_restore').on('click', () => {
        $('#story_memory_prompt').val(defaultPrompt).trigger('input');
    });
    $('#story_memory_append_prompt_restore').on('click', () => {
        $('#story_memory_append_prompt').val(defaultAppendPrompt).trigger('input');
    });
    $('#story_memory_text').on('input', onSummaryInput);
    $('#story_memory_summarize').on('click', onSummarizeClick);
    $('#story_memory_undo').on('click', onUndoClick);
    $('#story_memory_new_chat').on('click', onNewChatClick);
    $('#story_memory_import').on('click', onImportClick);
}

jQuery(async () => {
    loadSettings();

    const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    $('#extensions_settings2').append(html);
    populateProfiles();
    bindSettings();
    refresh(true);

    const refreshNow = () => refresh();
    for (const event of [
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_UPDATED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.CHARACTER_MESSAGE_RENDERED,
    ]) {
        eventSource.on(event, refreshNow);
    }
    eventSource.on(event_types.CHAT_CHANGED, () => refresh(true));
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, tagChatIndices);
    for (const event of [
        event_types.CONNECTION_PROFILE_CREATED,
        event_types.CONNECTION_PROFILE_DELETED,
        event_types.CONNECTION_PROFILE_UPDATED,
    ]) {
        eventSource.on(event, populateProfiles);
    }
});
