import { onMounted, onUnmounted } from 'vue';

export function useGameCanvasEntityLabHotkey(openEntityLab: () => void): void {
  function handleEntityLabKeydown(e: KeyboardEvent): void {
    if (e.key === '~') {
      e.preventDefault();
      openEntityLab();
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleEntityLabKeydown);
  });

  onUnmounted(() => {
    window.removeEventListener('keydown', handleEntityLabKeydown);
  });
}
