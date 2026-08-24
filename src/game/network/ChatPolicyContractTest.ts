import {
  appendRecentChatMessages,
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_MESSAGES_PER_ROOM,
  sanitizeChatMessageText,
} from './chatPolicy';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[chat policy contract] ${message}`);
}

export function runChatPolicyContractTest(): void {
  const longText = `  hello   ${'x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 20)}  `;
  const sanitized = sanitizeChatMessageText(longText);
  assertContract(sanitized !== null, 'non-empty text must survive sanitizing');
  assertContract(
    sanitized.startsWith('hello x') && sanitized.length === CHAT_MESSAGE_MAX_LENGTH,
    'chat text must collapse whitespace and stop at the shared length ceiling',
  );
  assertContract(sanitizeChatMessageText(' \n\t ') === null, 'empty text must be refused');

  const history = appendRecentChatMessages(
    Array.from({ length: CHAT_MESSAGES_PER_ROOM }, (_, index) => index),
    [CHAT_MESSAGES_PER_ROOM],
  );
  assertContract(
    history.length === CHAT_MESSAGES_PER_ROOM &&
      history[0] === 1 &&
      history[history.length - 1] === CHAT_MESSAGES_PER_ROOM,
    'a room must retain only its newest messages in chronological order',
  );

  const initialRoom = appendRecentChatMessages(
    [],
    Array.from({ length: CHAT_MESSAGES_PER_ROOM + 2 }, (_, index) => index),
  );
  assertContract(
    initialRoom.length === CHAT_MESSAGES_PER_ROOM && initialRoom[0] === 2,
    'an initial backend history read must also be capped to the newest messages',
  );
}
