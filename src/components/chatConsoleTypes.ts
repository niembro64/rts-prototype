/** Shared shapes for ChatConsole.vue — in their own module because a
 *  `<script setup>` block cannot export types to its consumers. */

export type ChatConsoleMessage = {
  readonly id: string;
  readonly senderName: string;
  /** CSS color for the sender name; '' uses the default. */
  readonly senderColor: string;
  /** '' hides the tag; 'TEAM' / 'SPEC' / 'ALL' render as a channel prefix. */
  readonly channelTag: string;
  readonly text: string;
};

export type ChatChannelOption = {
  readonly id: string;
  readonly label: string;
};
