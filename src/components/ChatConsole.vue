<script setup lang="ts">
/**
 * A BAR-style chat console: message lines in the corner, sender names in
 * team colors, a channel tag when the room is split, an input row with a
 * channel toggle. One component for all three rooms — the HOME global chat,
 * the lobby's shared room, and the battle's TEAM/ALL split — the host
 * decides which channels exist and what the messages are.
 *
 * Two BAR behaviors are contractual here:
 *   - New messages are never hidden behind the scrollbar: the log sticks to
 *     the bottom unless the player has deliberately scrolled up to read
 *     history, and re-sticks the moment they return to the bottom.
 *   - Enter sends and keeps focus; Escape blurs out of the input so game
 *     hotkeys work again.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_MESSAGES_PER_ROOM,
  sanitizeChatMessageText,
} from '../game/network/chatPolicy';
import type { ChatChannelOption, ChatConsoleMessage } from './chatConsoleTypes';

const props = defineProps<{
  messages: readonly ChatConsoleMessage[];
  /** Selectable outgoing channels. One entry hides the toggle. */
  channels: readonly ChatChannelOption[];
  activeChannelId: string;
  placeholder: string;
  /** BAR-style transient mode for gameplay surfaces (the battle HUD):
   *  lines expire after CHAT_LINE_TTL_MS (BAR gui_chat lineTTL = 40s),
   *  the input row exists only while chat is OPEN (Enter / focusInput,
   *  closed again on send or Escape), and hovering the log — or having
   *  the input open — reveals the full history, so an idle battle shows
   *  no chat chrome at all. Persistent mode (the default) keeps log and
   *  input visible: HOME and the lobby are social surfaces. */
  transient?: boolean;
}>();

const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'update:activeChannelId', id: string): void;
}>();

/** BAR gui_chat lineTTL: a line simply stops drawing after 40 seconds. */
const CHAT_LINE_TTL_MS = 40_000;
/** BAR shows at most ~5 unexpired chat lines outside history mode. */
const CHAT_FRESH_LINE_LIMIT = 6;

const draft = ref('');
const logRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
/** False while the player has scrolled up to read history. */
const stickToBottom = ref(true);
/** Transient mode: whether the input row is open. */
const inputOpen = ref(false);
/** Transient mode: hovering the log holds expired lines on screen. */
const hovering = ref(false);
const nowMs = ref(Date.now());
const firstSeenById = new Map<string, number>();
let ttlTimer: number | null = null;

watch(
  () => props.messages,
  (messages) => {
    const now = Date.now();
    const liveIds = new Set<string>();
    for (const message of messages) {
      liveIds.add(message.id);
      if (!firstSeenById.has(message.id)) firstSeenById.set(message.id, now);
    }
    for (const id of firstSeenById.keys()) {
      if (!liveIds.has(id)) firstSeenById.delete(id);
    }
  },
  { immediate: true },
);

onMounted(() => {
  if (props.transient !== true) return;
  ttlTimer = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (ttlTimer !== null) window.clearInterval(ttlTimer);
});

const visibleMessages = computed<readonly ChatConsoleMessage[]>(() => {
  const recentMessages = props.messages.slice(-CHAT_MESSAGES_PER_ROOM);
  if (props.transient !== true || inputOpen.value || hovering.value) {
    return recentMessages;
  }
  const cutoff = nowMs.value - CHAT_LINE_TTL_MS;
  const fresh = recentMessages.filter(
    (message) => (firstSeenById.get(message.id) ?? 0) >= cutoff,
  );
  return fresh.slice(-CHAT_FRESH_LINE_LIMIT);
});

const showInputRow = computed(() => props.transient !== true || inputOpen.value);

function handleLogScroll(): void {
  const log = logRef.value;
  if (log === null) return;
  stickToBottom.value = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
}

watch(
  () => props.messages.length,
  () => {
    if (!stickToBottom.value) return;
    void nextTick(() => {
      const log = logRef.value;
      if (log !== null) log.scrollTop = log.scrollHeight;
    });
  },
  { flush: 'post' },
);

function submit(): void {
  const text = sanitizeChatMessageText(draft.value);
  if (text === null) {
    // BAR sends-or-closes on Enter: an empty submit in transient mode
    // just puts the console away.
    if (props.transient === true) closeInput();
    return;
  }
  emit('send', text);
  draft.value = '';
  // BAR's cancelChatInput after "say": a battle send closes the console
  // so gameplay hotkeys return immediately. Persistent rooms keep focus.
  if (props.transient === true) closeInput();
}

function closeInput(): void {
  inputRef.value?.blur();
  inputOpen.value = false;
}

function handleInputBlur(): void {
  if (props.transient === true) inputOpen.value = false;
}

function handleInputKeydown(event: KeyboardEvent): void {
  // The game's hotkey handler ignores events targeting inputs, but stop
  // propagation anyway so nothing above reinterprets typing.
  event.stopPropagation();
  if (event.key === 'Escape') {
    closeInput();
  }
}

function focusInput(): void {
  if (props.transient === true && !inputOpen.value) {
    inputOpen.value = true;
    void nextTick(() => inputRef.value?.focus());
    return;
  }
  inputRef.value?.focus();
}

defineExpose({ focusInput });
</script>

<template>
  <section
    class="chat-console"
    aria-label="Chat"
    @mouseenter="hovering = true"
    @mouseleave="hovering = false"
  >
    <div
      ref="logRef"
      class="chat-log"
      aria-live="polite"
      @scroll="handleLogScroll"
    >
      <div v-for="message in visibleMessages" :key="message.id" class="chat-line">
        <span
          v-if="message.channelTag !== ''"
          class="chat-channel"
          :class="`chat-channel-${message.channelTag.toLowerCase()}`"
        >[{{ message.channelTag }}]</span>
        <span
          class="chat-sender"
          :style="message.senderColor === '' ? undefined : { color: message.senderColor }"
        >{{ message.senderName }}:</span>
        <span class="chat-text">{{ message.text }}</span>
      </div>
    </div>

    <form v-if="showInputRow" class="chat-input-row" @submit.prevent="submit">
      <button
        v-for="channel in channels.length > 1 ? channels : []"
        :key="channel.id"
        type="button"
        class="chat-channel-btn"
        :class="{ active: channel.id === activeChannelId }"
        @click="emit('update:activeChannelId', channel.id)"
      >{{ channel.label }}</button>
      <input
        ref="inputRef"
        v-model="draft"
        class="chat-input"
        type="text"
        :maxlength="CHAT_MESSAGE_MAX_LENGTH"
        autocomplete="off"
        :placeholder="placeholder"
        aria-label="Chat message"
        @keydown="handleInputKeydown"
        @blur="handleInputBlur"
      />
    </form>
  </section>
</template>

<style scoped>
.chat-console {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: min(420px, calc(100vw - 32px));
  font-family: monospace;
  pointer-events: auto;
}

.chat-log {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 168px;
  overflow-y: auto;
  scrollbar-width: thin;
  padding: 4px 6px;
  background: rgba(6, 10, 13, 0.62);
  border-radius: 3px;
}

.chat-log:empty {
  display: none;
}

.chat-line {
  font-size: 12px;
  line-height: 1.35;
  color: #e6eef3;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
  overflow-wrap: anywhere;
}

.chat-channel {
  margin-right: 4px;
  font-weight: bold;
}

.chat-channel-team {
  color: #7fd48a;
}

.chat-channel-spec {
  color: #9db4c4;
}

.chat-channel-all {
  color: #d9c47a;
}

.chat-sender {
  margin-right: 5px;
  font-weight: bold;
  color: #bcd0dc;
}

.chat-text {
  color: #e6eef3;
}

.chat-input-row {
  display: flex;
  gap: 4px;
}

.chat-channel-btn {
  background: rgba(24, 32, 38, 0.85);
  border: 1px solid rgba(180, 199, 209, 0.3);
  color: #c8d6de;
  font-family: monospace;
  font-size: 10px;
  font-weight: bold;
  padding: 2px 8px;
  cursor: pointer;
}

.chat-channel-btn.active {
  background: rgba(84, 128, 150, 0.6);
  color: #f0f7fa;
}

.chat-input {
  flex: 1;
  min-width: 0;
  background: rgba(10, 15, 19, 0.8);
  border: 1px solid rgba(180, 199, 209, 0.3);
  color: #e6eef3;
  font-family: monospace;
  font-size: 12px;
  padding: 3px 6px;
}

.chat-input::placeholder {
  color: #5c6b74;
}

.chat-input:focus {
  outline: none;
  border-color: rgba(140, 190, 214, 0.7);
}
</style>
