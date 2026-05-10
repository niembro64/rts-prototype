import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { BattleMode } from '../battleBarConfig';
import type { BackgroundBattleState } from '../game/lobby/LobbyManager';
import { networkManager } from '../game/network/NetworkManager';
import type { GameServer } from '../game/server/GameServer';
import { formatDuration } from './uiUtils';

type ReadableRef<T> = { readonly value: T };

type LobbyPresencePlayer = {
  ipAddress?: string;
  localTime?: string;
};

type PresenceOptions = {
  currentBattleMode: ReadableRef<BattleMode>;
  localLobbyPlayer: ReadableRef<LobbyPresencePlayer | null>;
  getBattleStartTime: () => number;
  getBackgroundBattle: () => BackgroundBattleState | null;
  getCurrentServer: () => GameServer | null;
};

function readLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

function deriveLocationFromTimezone(timezone: string): string {
  try {
    if (!timezone) return '';
    const parts = timezone.split('/');
    const tzCity = (parts[parts.length - 1] ?? '').replace(/_/g, ' ');
    const tzRegion = parts.length > 1 ? parts[0] : '';
    return [tzCity, tzRegion].filter((s) => s.length > 0).join(', ');
  } catch {
    return '';
  }
}

export function useGameCanvasPresence({
  currentBattleMode,
  localLobbyPlayer,
  getBattleStartTime,
  getBackgroundBattle,
  getCurrentServer,
}: PresenceOptions) {
  const localIpAddress = ref<string>('N/A');
  const localLocation = ref<string>('');
  const localTimezone = ref<string>(readLocalTimezone());
  const clientTime = ref<string>('');
  const battleElapsed = ref('00:00:00');
  let clientTimeInterval: ReturnType<typeof setInterval> | null = null;
  let ipFetchController: AbortController | null = null;
  let disposed = false;

  const displayedClientTime = computed(() =>
    currentBattleMode.value === 'real'
      ? localLobbyPlayer.value?.localTime ?? ''
      : clientTime.value,
  );
  const displayedClientIp = computed(() =>
    currentBattleMode.value === 'real'
      ? localLobbyPlayer.value?.ipAddress ?? ''
      : (localIpAddress.value !== 'N/A' ? localIpAddress.value : ''),
  );

  function reportLocalPlayerInfo(): void {
    networkManager.reportLocalPlayerInfo(
      localIpAddress.value !== 'N/A' ? localIpAddress.value : undefined,
      localLocation.value || undefined,
      localTimezone.value || undefined,
    );
  }

  function updateClientTime(): void {
    clientTime.value = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(new Date());
    const battleStartTime = getBattleStartTime();
    battleElapsed.value = battleStartTime > 0
      ? formatDuration(Date.now() - battleStartTime)
      : '00:00:00';
  }

  onMounted(() => {
    disposed = false;
    ipFetchController = new AbortController();
    fetch('https://api.ipify.org?format=text', { signal: ipFetchController.signal })
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => '')
      .then((ipText) => {
        if (disposed) return;
        const ip = ipText.trim();
        const loc = deriveLocationFromTimezone(localTimezone.value);
        if (ip) {
          localIpAddress.value = ip;
          getBackgroundBattle()?.server.setIpAddress(ip);
          getCurrentServer()?.setIpAddress(ip);
        }
        if (loc) localLocation.value = loc;
        reportLocalPlayerInfo();
      });

    updateClientTime();
    clientTimeInterval = setInterval(updateClientTime, 1000);
  });

  onUnmounted(() => {
    disposed = true;
    ipFetchController?.abort();
    ipFetchController = null;
    if (clientTimeInterval) {
      clearInterval(clientTimeInterval);
      clientTimeInterval = null;
    }
  });

  return {
    battleElapsed,
    displayedClientIp,
    displayedClientTime,
    localIpAddress,
    reportLocalPlayerInfo,
  };
}
