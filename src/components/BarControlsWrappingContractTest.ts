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

  // One button group for everything. The old connected-pill BarButtonGroup
  // (fused borders, rounded end caps) is gone; every bar button — even a run
  // of one — sits inside the wrapping <BarButtons> group, and the bars no
  // longer reserve a left `.bar-info` column (DEFAULTS lives with the rest
  // of the buttons in `.bar-controls`).
  const barSources: readonly (readonly [string, string])[] = [
    ['BATTLE', battleBarSource],
    ['SERVER', serverBarSource],
    ['CLIENT', clientBarSource],
    ['LOBBY', lobbySource],
  ];
  for (const [name, source] of barSources) {
    assertContract(
      !source.includes('BarButtonGroup') && !source.includes('bar-button-group'),
      `${name} bar must not use the removed connected-pill button group`,
    );
    assertContract(
      !source.includes('bar-info'),
      `${name} bar must not reserve a left bar-info column; all buttons live in bar-controls`,
    );
    const template = source.slice(source.indexOf('<template>'));
    let groupDepth = 0;
    for (const tag of template.matchAll(/<\/?BarButtons?\b/g)) {
      if (tag[0] === '<BarButtons') groupDepth += 1;
      else if (tag[0] === '</BarButtons') groupDepth -= 1;
      else if (tag[0] === '<BarButton') {
        assertContract(
          groupDepth >= 1,
          `${name} bar has a <BarButton> outside a <BarButtons> group — every button run, even a single button, uses the same group`,
        );
      }
    }
    assertContract(groupDepth === 0, `${name} bar has unbalanced <BarButtons> tags`);
  }

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
  buttons.className = 'bar-buttons';
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
    assertContract(
      buttonElements.every((button) => window.getComputedStyle(button).borderRadius === '0px'),
      'bar buttons must have square corners — no rounded borders anywhere in the bars',
    );
  } finally {
    fixture.remove();
  }
}
import { CLIENT_CONFIG } from '../clientBarConfig';
import battleBarSource from './GameCanvasBattleControlBar.vue?raw';
import clientBarSource from './GameCanvasClientControlBar.vue?raw';
import serverBarSource from './GameCanvasServerControlBar.vue?raw';
import lobbySource from './LobbyModal.vue?raw';
