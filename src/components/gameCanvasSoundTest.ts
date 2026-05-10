import { onMounted, onUnmounted, ref, type Ref } from 'vue';

export function useGameCanvasSoundTest(): {
  showSoundTest: Ref<boolean>;
} {
  const showSoundTest = ref(false);

  function handleSoundTestKeydown(e: KeyboardEvent): void {
    if (e.key === '~') {
      showSoundTest.value = !showSoundTest.value;
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleSoundTestKeydown);
  });

  onUnmounted(() => {
    window.removeEventListener('keydown', handleSoundTestKeydown);
  });

  return { showSoundTest };
}
