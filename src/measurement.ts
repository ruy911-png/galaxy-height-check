export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface MeasurementHit {
  position: Point3;
  normalY: number;
  viewerY: number;
  timestamp: number;
  sessionId: string;
  epoch: number;
  source: 'webxr-plane-hit';
}

export interface HeightResult {
  meters: number;
  centimeters: number;
  lateralMeters: number;
  source: 'webxr-plane-hit';
  accuracy: 'unverified';
  floor: MeasurementHit;
  ceiling: MeasurementHit;
}

export type MeasurementStep = 'floor' | 'ceiling' | 'result';
export interface MeasurementState {
  step: MeasurementStep;
  floor: MeasurementHit | null;
  result: HeightResult | null;
}
export type MeasurementFailureReason =
  | 'no-hit'
  | 'invalid-hit'
  | 'stale-hit'
  | 'future-hit'
  | 'non-horizontal'
  | 'floor-not-below-camera'
  | 'ceiling-not-above-camera'
  | 'ceiling-not-above-floor'
  | 'coordinate-space-changed'
  | 'already-complete';
export type Confirmation =
  | { ok: true; result: HeightResult | null }
  | { ok: false; reason: MeasurementFailureReason };

const MAX_CANDIDATE_AGE_MS = 250;
const MIN_HORIZONTAL_NORMAL_Y = Math.cos(20 * Math.PI / 180);
const MIN_CAMERA_CLEARANCE_METERS = 0.05;

function finitePoint(value: unknown): value is Point3 {
  if (!value || typeof value !== 'object') return false;
  const point = value as Point3;
  return [point.x, point.y, point.z].every(Number.isFinite);
}

function validHit(value: unknown): value is MeasurementHit {
  if (!value || typeof value !== 'object') return false;
  const hit = value as MeasurementHit;
  return finitePoint(hit.position)
    && Number.isFinite(hit.normalY)
    && Math.abs(hit.normalY) <= 1
    && Number.isFinite(hit.viewerY)
    && Number.isFinite(hit.timestamp)
    && hit.timestamp >= 0
    && typeof hit.sessionId === 'string'
    && hit.sessionId.trim().length > 0
    && Number.isInteger(hit.epoch)
    && hit.epoch >= 0
    && hit.source === 'webxr-plane-hit';
}

function cloneHit(hit: MeasurementHit): MeasurementHit {
  return { ...hit, position: { ...hit.position } };
}

function cloneResult(result: HeightResult): HeightResult {
  return { ...result, floor: cloneHit(result.floor), ceiling: cloneHit(result.ceiling) };
}

function emptyState(): MeasurementState {
  return { step: 'floor', floor: null, result: null };
}

/** WebXR local-floor coordinates use meters and a gravity-aligned +Y axis. */
export function calculateVerticalHeight(floor: Point3, ceiling: Point3): {
  meters: number;
  centimeters: number;
  lateralMeters: number;
} {
  if (!finitePoint(floor) || !finitePoint(ceiling)) throw new RangeError('Invalid coordinates');
  const meters = ceiling.y - floor.y;
  const centimeters = meters * 100;
  const lateralMeters = Math.hypot(ceiling.x - floor.x, ceiling.z - floor.z);
  if (![meters, centimeters, lateralMeters].every(Number.isFinite)) throw new RangeError('Invalid coordinate difference');
  if (meters <= 0) throw new RangeError('Ceiling must be above floor');
  return { meters, centimeters, lateralMeters };
}

/**
 * Stores confirmed snapshots in one uninterrupted tracking epoch.
 * The live hit must be recent; a previously committed floor may be older.
 * The XR owner must call invalidate synchronously on tracking/session changes.
 */
export class HeightMeasurement {
  private state = emptyState();

  getState(): MeasurementState {
    return {
      step: this.state.step,
      floor: this.state.floor ? cloneHit(this.state.floor) : null,
      result: this.state.result ? cloneResult(this.state.result) : null,
    };
  }

  canConfirm(hit: MeasurementHit | null, now: number): boolean {
    return this.rejectionReason(hit, now) === null;
  }

  confirm(hit: MeasurementHit | null, now: number): Confirmation {
    const reason = this.rejectionReason(hit, now);
    if (reason) {
      if (reason === 'coordinate-space-changed') this.invalidate();
      return { ok: false, reason };
    }
    // The checks above validate a non-null hit without mutating its input.
    const snapshot = cloneHit(hit!);
    if (this.state.step === 'floor') {
      this.state = { step: 'ceiling', floor: snapshot, result: null };
      return { ok: true, result: null };
    }

    const floor = this.state.floor!;
    let dimensions: ReturnType<typeof calculateVerticalHeight>;
    try { dimensions = calculateVerticalHeight(floor.position, snapshot.position); }
    catch { return { ok: false, reason: 'invalid-hit' }; }
    const result: HeightResult = {
      ...dimensions,
      source: 'webxr-plane-hit',
      accuracy: 'unverified',
      floor: cloneHit(floor),
      ceiling: snapshot,
    };
    this.state = { step: 'result', floor, result };
    return { ok: true, result: cloneResult(result) };
  }

  reset(): void {
    this.state = emptyState();
  }

  invalidate(): void {
    this.reset();
  }

  private rejectionReason(hit: MeasurementHit | null, now: number): MeasurementFailureReason | null {
    if (this.state.step === 'result') return 'already-complete';
    if (!hit) return 'no-hit';
    if (!validHit(hit) || !Number.isFinite(now) || now < 0) return 'invalid-hit';
    const floor = this.state.floor;
    if (floor && (floor.sessionId !== hit.sessionId || floor.epoch !== hit.epoch)) return 'coordinate-space-changed';
    if (now < hit.timestamp) return 'future-hit';
    if (now - hit.timestamp > MAX_CANDIDATE_AGE_MS) return 'stale-hit';
    // Normal sign alone does not establish the semantic floor/ceiling identity.
    if (Math.abs(hit.normalY) < MIN_HORIZONTAL_NORMAL_Y) return 'non-horizontal';

    if (this.state.step === 'floor') {
      return hit.position.y < hit.viewerY - MIN_CAMERA_CLEARANCE_METERS ? null : 'floor-not-below-camera';
    }
    if (hit.position.y <= hit.viewerY + MIN_CAMERA_CLEARANCE_METERS) return 'ceiling-not-above-camera';
    if (!floor || hit.position.y <= floor.position.y) return 'ceiling-not-above-floor';
    return null;
  }
}
