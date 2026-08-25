function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[bar controls wrapping contract] ${message}`);
}

export function runBarControlsWrappingContractTest(): void {
  assertContract(
    CLIENT_CONFIG.buildGridDebug.options.every((option) =>
      option.label.length <= 14 && !option.label.includes('BUILD SQUARES')),
    'BUILD buttons must use concise labels; the section title already supplies their context',
  );
  for (const source of [battleBarSource, lobbySource]) {
    assertContract(
      source.includes('PLATEAU WALL (DEG):') &&
        source.includes('SIM TICK (HZ):') &&
        !/\{\{\s*opt\s*\}\}\s+(?:DEG|HZ)/.test(source),
      'button units must live once in the section title, not in every numeric button',
    );
  }
  assertContract(
    !/(?:debug-control-group|path-control-group|path-mode-button-group|path-unit-button-group)/
      .test(clientBarSource),
    'CLIENT controls must use the shared wrapping components without PATH-only layout classes',
  );

  const fixture = document.createElement('div');
  fixture.className = 'bar-controls';
  fixture.style.position = 'fixed';
  fixture.style.visibility = 'hidden';
  fixture.style.width = '190px';

  const control = document.createElement('div');
  control.className = 'control-group';
  const label = document.createElement('span');
  label.className = 'control-label';
  label.textContent = 'PATH:';
  const buttons = document.createElement('div');
  buttons.className = 'bar-button-group';
  for (const text of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO']) {
    const button = document.createElement('button');
    button.className = 'control-btn';
    button.textContent = text;
    buttons.append(button);
  }
  control.append(label, buttons);
  fixture.append(control);
  document.body.append(fixture);

  try {
    const controlStyle = window.getComputedStyle(control);
    const buttonGroupStyle = window.getComputedStyle(buttons);
    const buttonElements = [...buttons.querySelectorAll<HTMLButtonElement>('.control-btn')];
    const rows = new Set(buttonElements.map((button) => button.offsetTop));
    assertContract(
      controlStyle.flexWrap === 'wrap' &&
        buttonGroupStyle.display === 'flex' &&
        buttonGroupStyle.flexWrap === 'wrap',
      'shared control and button groups must own the wrapping behavior',
    );
    assertContract(rows.size > 1, 'a long shared button group must wrap at narrow widths');
    assertContract(
      buttonElements.every((button) => button.clientWidth >= button.scrollWidth),
      'wrapped button labels must retain their readable intrinsic width',
    );
  } finally {
    fixture.remove();
  }
}
import { CLIENT_CONFIG } from '../clientBarConfig';
import battleBarSource from './GameCanvasBattleControlBar.vue?raw';
import clientBarSource from './GameCanvasClientControlBar.vue?raw';
import lobbySource from './LobbyModal.vue?raw';
