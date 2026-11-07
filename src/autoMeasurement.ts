import { HeightMeasurement, type HeightResult, type MeasurementHit } from './measurement';

export interface AutoPair {
  floor: MeasurementHit | null;
  ceiling: MeasurementHit | null;
}

export interface AutoReading {
  status: 'searching' | 'blocked' | 'stabilizing' | 'ready';
  reason: string;
  result: HeightResult | null;
  progress: number;
}

const REQUIRED_STABLE_MS = 1000;
const REQUIRED_DISTINCT_FRAMES = 10;
const MAX_FRAME_GAP_MS = 250;
// A consistency gate, NOT an accuracy specification or confidence interval.
const MAX_Y_DRIFT_METERS = 0.025;

interface StableWindow {
  sessionId: string;
  epoch: number;
  floorY: number;
  ceilingY: number;
  startedAt: number;
  lastTimestamp: number;
  frames: number;
  reading: AutoReading;
}

function cloneReading(reading: AutoReading): AutoReading {
  const result = reading.result;
  return {
    ...reading,
    result: result ? {
      ...result,
      floor: { ...result.floor, position: { ...result.floor.position } },
      ceiling: { ...result.ceiling, position: { ...result.ceiling.position } },
    } : null,
  };
}

/**
 * Consumes two direct plane hits from one XR frame. This deliberately has no
 * image/object classifier: an eligible horizontal shelf can still be mistaken
 * for a room surface. A ready reading remains a live, unverified candidate.
 * The owner must reset synchronously on tracking loss, visibility and XR reset.
 */
export class AutoHeightMeasurement {
  private window: StableWindow | null = null;

  update(pair: AutoPair, now: number): AutoReading {
    const { floor, ceiling } = pair;
    if (!floor || !ceiling) {
      return this.reject('searching', !floor && !ceiling ? 'missing-both' : !floor ? 'missing-floor' : 'missing-ceiling');
    }
    if (floor.timestamp !== ceiling.timestamp) return this.reject('blocked', 'different-frame');
    if (floor.sessionId !== ceiling.sessionId || floor.epoch !== ceiling.epoch) {
      return this.reject('blocked', 'coordinate-space-changed');
    }
    if (floor.viewerY !== ceiling.viewerY) return this.reject('blocked', 'different-viewer');

    // Reuse the same direct-hit, age, horizontal-plane and camera-height rules
    // as manual measurement; never substitute a virtual or previously seen hit.
    const validator = new HeightMeasurement();
    const lower = validator.confirm(floor, now);
    if (!lower.ok) return this.reject('blocked', `floor:${lower.reason}`);
    const upper = validator.confirm(ceiling, now);
    if (!upper.ok) return this.reject('blocked', `ceiling:${upper.reason}`);
    if (!upper.result) return this.reject('blocked', 'ceiling:invalid-hit');

    const previous = this.window;
    if (!previous) return this.begin(floor, ceiling, 'holding-still');
    if (previous.sessionId !== floor.sessionId || previous.epoch !== floor.epoch) {
      return this.begin(floor, ceiling, 'coordinate-space-changed');
    }
    if (floor.timestamp < previous.lastTimestamp) return this.reject('blocked', 'out-of-order-frame');
    if (floor.timestamp - previous.lastTimestamp > MAX_FRAME_GAP_MS) {
      return this.begin(floor, ceiling, 'frame-gap');
    }
    if (Math.abs(floor.position.y - previous.floorY) > MAX_Y_DRIFT_METERS
      || Math.abs(ceiling.position.y - previous.ceilingY) > MAX_Y_DRIFT_METERS) {
      return this.begin(floor, ceiling, 'height-moved');
    }
    // UI polling or a repeated callback is not another camera observation.
    // Validate freshness above even when keeping this prior reading.
    if (floor.timestamp === previous.lastTimestamp) return cloneReading(previous.reading);

    previous.lastTimestamp = floor.timestamp;
    previous.frames += 1;
    const elapsed = floor.timestamp - previous.startedAt;
    const ready = elapsed >= REQUIRED_STABLE_MS && previous.frames >= REQUIRED_DISTINCT_FRAMES;
    previous.reading = {
      status: ready ? 'ready' : 'stabilizing',
      reason: ready ? 'ready' : 'holding-still',
      result: ready ? upper.result : null,
      progress: Math.min(1, elapsed / REQUIRED_STABLE_MS, previous.frames / REQUIRED_DISTINCT_FRAMES),
    };
    return cloneReading(previous.reading);
  }

  reset(): void {
    this.window = null;
  }

  private reject(status: 'searching' | 'blocked', reason: string): AutoReading {
    this.reset();
    return { status, reason, result: null, progress: 0 };
  }

  private begin(floor: MeasurementHit, ceiling: MeasurementHit, reason: string): AutoReading {
    const reading: AutoReading = { status: 'stabilizing', reason, result: null, progress: 0 };
    this.window = {
      sessionId: floor.sessionId,
      epoch: floor.epoch,
      floorY: floor.position.y,
      ceilingY: ceiling.position.y,
      startedAt: floor.timestamp,
      lastTimestamp: floor.timestamp,
      frames: 1,
      reading,
    };
    return cloneReading(reading);
  }
}
