import serverBarConfig from './serverBarConfig.json';
import {
  SERVER_CONFIG,
} from './serverBarConfig';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[server bar config contract] ${message}`);
  }
}

export function runServerBarConfigContractTest(): void {
  assertContract(
    Array.isArray(serverBarConfig.unitGroundNormalEma.options) &&
      serverBarConfig.unitGroundNormalEma.options.length > 0,
    'unitGroundNormalEma.options must be a non-empty option list',
  );
  assertContract(
    SERVER_CONFIG.unitGroundNormalEma.options.includes(SERVER_CONFIG.unitGroundNormalEma.default),
    'SERVER_CONFIG.unitGroundNormalEma.default must be one of the authored options',
  );
}
