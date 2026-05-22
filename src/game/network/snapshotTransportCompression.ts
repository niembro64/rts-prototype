import { SNAPSHOT_CONFIG } from '../../config';
import type { SnapshotCompressionFormat } from '../../types/config';
import {
  addRunningStat,
  createRunningStats,
  formatRunningAverage,
  formatRunningMax,
  type RunningStats,
} from '../diagnosticStats';

type FullSnapshotCompressionOptions = {
  enabled: boolean;
  format: SnapshotCompressionFormat;
  minBytes: number;
};

type SnapshotTransportCompressionStats = {
  rawBytes: RunningStats;
  wireBytes: RunningStats;
  savedPct: RunningStats;
  compressMs: RunningStats;
  decompressMs: RunningStats;
};

export type SnapshotTransportCompressionReportRow = {
  kind: 'FULLSNAP';
  attempts: number;
  compressed: number;
  decompressed: number;
  rawFallback: number;
  unsupported: number;
  encodeFailures: number;
  decodeFailures: number;
  rawBytesAvg: number | string;
  rawBytesMax: number | string;
  wireBytesAvg: number | string;
  wireBytesMax: number | string;
  savedPctAvg: number | string;
  compressMs: number | string;
  compressMsMax: number | string;
  decompressMs: number | string;
  decompressMsMax: number | string;
};

export type SnapshotTransportCompressionDebugApi = {
  reset(): void;
  report(): void;
  rows(): SnapshotTransportCompressionReportRow[];
};

declare global {
  interface Window {
    __BA_SNAPSHOT_TRANSPORT_COMPRESSION__?: SnapshotTransportCompressionDebugApi;
  }
}

function createStats(): SnapshotTransportCompressionStats {
  return {
    rawBytes: createRunningStats(),
    wireBytes: createRunningStats(),
    savedPct: createRunningStats(),
    compressMs: createRunningStats(),
    decompressMs: createRunningStats(),
  };
}

function envFlag(name: string): boolean {
  const value = import.meta.env[name];
  if (typeof value !== 'string') return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function queryFlag(...names: string[]): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  for (let i = 0; i < names.length; i++) {
    const value = params.get(names[i]);
    if (value === null) continue;
    if (value === '' || value === '1') return true;
    const normalized = value.toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  }
  return false;
}

function streamApiAvailable(): boolean {
  return typeof CompressionStream !== 'undefined' &&
    typeof DecompressionStream !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof Response !== 'undefined';
}

function streamSupportsFormat(format: SnapshotCompressionFormat): boolean {
  if (!streamApiAvailable()) return false;
  try {
    new CompressionStream(format);
    new DecompressionStream(format);
    return true;
  } catch {
    return false;
  }
}

async function transformBytes(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const readable = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(stream);
  const buffer = await new Response(readable).arrayBuffer();
  return new Uint8Array(buffer);
}

export function getFullSnapshotCompressionOptions(): FullSnapshotCompressionOptions {
  const config = SNAPSHOT_CONFIG.fullSnapshotCompression;
  return {
    enabled: config.enabled ||
      envFlag('VITE_BA_FULLSNAP_COMPRESSION') ||
      queryFlag('fullSnapshotCompression', 'snapshotCompression', 'fsCompression'),
    format: config.format,
    minBytes: Math.max(0, config.minBytes),
  };
}

export function canUseSnapshotCompression(format: SnapshotCompressionFormat): boolean {
  return streamSupportsFormat(format);
}

export async function compressSnapshotPayload(
  bytes: Uint8Array,
  format: SnapshotCompressionFormat,
): Promise<Uint8Array> {
  return transformBytes(bytes, new CompressionStream(format));
}

export async function decompressSnapshotPayload(
  bytes: Uint8Array,
  format: SnapshotCompressionFormat,
): Promise<Uint8Array> {
  return transformBytes(bytes, new DecompressionStream(format));
}

class SnapshotTransportCompressionInstrumentation {
  private attempts = 0;
  private compressed = 0;
  private decompressed = 0;
  private rawFallback = 0;
  private unsupported = 0;
  private encodeFailures = 0;
  private decodeFailures = 0;
  private stats = createStats();

  recordUnsupported(rawBytes: number): void {
    this.attempts++;
    this.unsupported++;
    this.recordSize(rawBytes, rawBytes);
  }

  recordRawFallback(rawBytes: number, compressMs: number): void {
    this.attempts++;
    this.rawFallback++;
    this.recordSize(rawBytes, rawBytes);
    addRunningStat(this.stats.compressMs, compressMs);
  }

  recordEncodeFailure(rawBytes: number): void {
    this.attempts++;
    this.encodeFailures++;
    this.recordSize(rawBytes, rawBytes);
  }

  recordCompressed(rawBytes: number, wireBytes: number, compressMs: number): void {
    this.attempts++;
    this.compressed++;
    this.recordSize(rawBytes, wireBytes);
    addRunningStat(this.stats.compressMs, compressMs);
  }

  recordDecompressed(wireBytes: number, rawBytes: number, decompressMs: number): void {
    this.decompressed++;
    this.recordSize(rawBytes, wireBytes);
    addRunningStat(this.stats.decompressMs, decompressMs);
  }

  recordDecodeFailure(): void {
    this.decodeFailures++;
  }

  reset(): void {
    this.attempts = 0;
    this.compressed = 0;
    this.decompressed = 0;
    this.rawFallback = 0;
    this.unsupported = 0;
    this.encodeFailures = 0;
    this.decodeFailures = 0;
    this.stats = createStats();
  }

  rows(): SnapshotTransportCompressionReportRow[] {
    return [{
      kind: 'FULLSNAP',
      attempts: this.attempts,
      compressed: this.compressed,
      decompressed: this.decompressed,
      rawFallback: this.rawFallback,
      unsupported: this.unsupported,
      encodeFailures: this.encodeFailures,
      decodeFailures: this.decodeFailures,
      rawBytesAvg: formatRunningAverage(this.stats.rawBytes, 0),
      rawBytesMax: formatRunningMax(this.stats.rawBytes, 0),
      wireBytesAvg: formatRunningAverage(this.stats.wireBytes, 0),
      wireBytesMax: formatRunningMax(this.stats.wireBytes, 0),
      savedPctAvg: formatRunningAverage(this.stats.savedPct, 1),
      compressMs: formatRunningAverage(this.stats.compressMs),
      compressMsMax: formatRunningMax(this.stats.compressMs),
      decompressMs: formatRunningAverage(this.stats.decompressMs),
      decompressMsMax: formatRunningMax(this.stats.decompressMs),
    }];
  }

  report(): void {
    console.info('[NET] Snapshot transport compression report');
    console.table(this.rows());
  }

  private recordSize(rawBytes: number, wireBytes: number): void {
    addRunningStat(this.stats.rawBytes, rawBytes);
    addRunningStat(this.stats.wireBytes, wireBytes);
    if (rawBytes > 0) {
      addRunningStat(this.stats.savedPct, ((rawBytes - wireBytes) / rawBytes) * 100);
    }
  }
}

export const SNAPSHOT_TRANSPORT_COMPRESSION =
  new SnapshotTransportCompressionInstrumentation();

if (typeof window !== 'undefined') {
  window.__BA_SNAPSHOT_TRANSPORT_COMPRESSION__ = {
    reset: () => SNAPSHOT_TRANSPORT_COMPRESSION.reset(),
    report: () => SNAPSHOT_TRANSPORT_COMPRESSION.report(),
    rows: () => SNAPSHOT_TRANSPORT_COMPRESSION.rows(),
  };
}
