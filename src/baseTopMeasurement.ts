import { calculateVerticalHeight, type MeasurementHit, type Point3 } from './measurement';

/** A real, fresh viewer ray and the nearest plane observation from one XR frame. */
export interface AimFrame {
  origin: Point3;
  direction: Point3;
  viewerY: number;
  timestamp: number;
  sessionId: string;
  epoch: number;
  source: 'webxr-view-ray';
  hitState: 'none' | 'valid' | 'invalid';
  hit: MeasurementHit | null;
}

export interface BaseTopResult {
  meters: number;
  centimeters: number;
  lateralMeters: number;
  source: 'webxr-plane-hit' | 'virtual-vertical-plane';
  accuracy: 'unverified';
  /** Frames behind the upper point: 1 is the tapped frame alone, more is a median. */
  smoothedFrames: number;
  base: MeasurementHit;
  top: Point3;
  timestamp: number;
  sessionId: string;
  epoch: number;
}

export interface BaseTopState {
  step: 'base' | 'top' | 'result';
  base: MeasurementHit | null;
  result: BaseTopResult | null;
}
export type BaseTopPreview = { ok: true; result: BaseTopResult } | { ok: false; reason: string };
export type BaseTopConfirmation = { ok: true; result: BaseTopResult | null } | { ok: false; reason: string };

const MAX_FRAME_AGE_MS = 250;
const MIN_HORIZONTAL_NORMAL_Y = Math.cos(20 * Math.PI / 180);
const MIN_BASE_DISTANCE_METERS = .2;
const MIN_HEIGHT_METERS = .005;
const MIN_RAY_PLANE_DOT = .1;
const MAX_INTERSECTION_DISTANCE_METERS = 30;
// Hand tremor and the tap itself move single frames. These limits only decide
// when recent frames agree well enough to share a median; they are not a
// measured accuracy tolerance.
const SMOOTHING_WINDOW_MS = 400;
const SMOOTHING_AGREEMENT_METERS = .03;
const SMOOTHING_MIN_SAMPLES = 3;
const SMOOTHING_MIN_AGREEMENT = .6;

type SampleKind = 'base' | BaseTopResult['source'];
interface Sample { kind: SampleKind; point: Point3; timestamp: number; sessionId: string; epoch: number }

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finitePoint(value: unknown): value is Point3 {
  if (!value || typeof value !== 'object') return false;
  const point = value as Point3;
  return [point.x, point.y, point.z].every(Number.isFinite);
}

function cloneHit(hit: MeasurementHit): MeasurementHit {
  return { ...hit, position: { ...hit.position } };
}

function cloneResult(result: BaseTopResult): BaseTopResult {
  return { ...result, base: cloneHit(result.base), top: { ...result.top } };
}

function emptyState(): BaseTopState {
  return { step: 'base', base: null, result: null };
}

function validFrame(frame: AimFrame, now: number): boolean {
  if (!finitePoint(frame.origin) || !finitePoint(frame.direction)) return false;
  const length = Math.hypot(frame.direction.x, frame.direction.y, frame.direction.z);
  return Number.isFinite(length) && Math.abs(length - 1) <= .001
    && Number.isFinite(now) && now >= 0
    && Number.isFinite(frame.timestamp) && frame.timestamp >= 0
    && Number.isFinite(frame.viewerY)
    && typeof frame.sessionId === 'string' && frame.sessionId.trim().length > 0
    && Number.isInteger(frame.epoch) && frame.epoch >= 0
    && frame.source === 'webxr-view-ray'
    && ['none', 'valid', 'invalid'].includes(frame.hitState);
}

function hitFailure(frame: AimFrame): string | null {
  if (frame.hitState === 'invalid') return 'invalid-hit';
  const hit = frame.hit;
  if (frame.hitState === 'none') return hit === null ? null : 'invalid-hit';
  if (!hit || !finitePoint(hit.position) || !Number.isFinite(hit.normalY)
    || Math.abs(hit.normalY) > 1 || hit.source !== 'webxr-plane-hit') return 'invalid-hit';
  if (hit.timestamp !== frame.timestamp || hit.sessionId !== frame.sessionId
    || hit.epoch !== frame.epoch || hit.viewerY !== frame.viewerY) return 'hit-frame-mismatch';
  return null;
}

/**
 * Two taps, one uninterrupted XR coordinate system. The upper candidate may be
 * a real plane hit of any orientation or a clearly labelled vertical-plane
 * estimate. The assumed plane is fixed when the real base is captured, facing
 * the camera horizontally. It does not identify objects or recover target depth.
 */
export class BaseTopMeasurement {
  private state = emptyState();
  private planeNormal: Point3 | null = null;
  private samples: Sample[] = [];

  getState(): BaseTopState {
    return {
      step: this.state.step,
      base: this.state.base ? cloneHit(this.state.base) : null,
      result: this.state.result ? cloneResult(this.state.result) : null,
    };
  }

  /** Read-only; preview/confirm handle loss of the current tracking identity. */
  getRejectionReason(frame: AimFrame | null, now: number): string | null {
    if (this.state.step === 'result') return 'already-complete';
    if (!frame) return 'no-frame';
    if (!validFrame(frame, now)) return 'invalid-frame';
    if (this.state.base && (this.state.base.sessionId !== frame.sessionId || this.state.base.epoch !== frame.epoch)) {
      return 'coordinate-space-changed';
    }
    if (now < frame.timestamp) return 'future-frame';
    if (now - frame.timestamp > MAX_FRAME_AGE_MS) return 'stale-frame';
    const failure = hitFailure(frame);
    if (failure) return failure;

    if (this.state.step === 'base') {
      const hit = frame.hit;
      if (!hit) return 'no-hit';
      if (Math.abs(hit.normalY) < MIN_HORIZONTAL_NORMAL_Y) return 'non-horizontal-base';
      if (hit.position.y >= frame.viewerY - .05) return 'base-not-below-camera';
      const distance = Math.hypot(frame.origin.x - hit.position.x, frame.origin.z - hit.position.z);
      if (!Number.isFinite(distance) || distance < MIN_BASE_DISTANCE_METERS) return 'base-too-close';
      return null;
    }

    const candidate = this.topCandidate(frame, false);
    return candidate.ok ? null : candidate.reason;
  }

  /**
   * Base-step counterpart of preview: call once per new frame so the tapped
   * base can use the median of the steady frames just before the tap.
   */
  observe(frame: AimFrame | null, now: number): string | null {
    const reason = this.getRejectionReason(frame, now);
    if (reason) this.invalidateFor(reason);
    else if (this.state.step === 'base') this.record('base', frame!.hit!.position, frame!);
    return reason;
  }

  canConfirm(frame: AimFrame | null, now: number): boolean {
    return this.getRejectionReason(frame, now) === null;
  }

  preview(frame: AimFrame | null, now: number): BaseTopPreview {
    const reason = this.getRejectionReason(frame, now);
    if (reason) {
      this.invalidateFor(reason);
      return { ok: false, reason };
    }
    if (this.state.step === 'base') return { ok: false, reason: 'base-required' };
    return this.topCandidate(frame!, true);
  }

  confirm(frame: AimFrame | null, now: number): BaseTopConfirmation {
    const reason = this.getRejectionReason(frame, now);
    if (reason) {
      this.invalidateFor(reason);
      return { ok: false, reason };
    }
    if (this.state.step === 'base') {
      const base = cloneHit(frame!.hit!);
      this.record('base', base.position, frame!);
      const steady = this.smoothed('base', frame!, base.position, false).point;
      // The steady point must still satisfy the checks the tapped frame passed.
      if (steady.y < frame!.viewerY - .05
        && Math.hypot(frame!.origin.x - steady.x, frame!.origin.z - steady.z) >= MIN_BASE_DISTANCE_METERS) {
        base.position = steady;
      }
      this.samples = [];
      const nx = frame!.origin.x - base.position.x;
      const nz = frame!.origin.z - base.position.z;
      const distance = Math.hypot(nx, nz);
      this.planeNormal = { x: nx / distance, y: 0, z: nz / distance };
      this.state = { step: 'top', base, result: null };
      return { ok: true, result: null };
    }

    const candidate = this.topCandidate(frame!, true);
    if (!candidate.ok) return candidate;
    this.samples = [];
    this.state = { step: 'result', base: this.state.base, result: cloneResult(candidate.result) };
    return { ok: true, result: cloneResult(candidate.result) };
  }

  reset(): void {
    this.state = emptyState();
    this.planeNormal = null;
    this.samples = [];
  }

  invalidate(): void { this.reset(); }

  private invalidateFor(reason: string): void {
    if (['no-frame', 'invalid-frame', 'stale-frame', 'future-frame', 'coordinate-space-changed'].includes(reason)) this.reset();
  }

  private record(kind: SampleKind, point: Point3, frame: AimFrame): void {
    const last = this.samples[this.samples.length - 1];
    if (last && frame.timestamp < last.timestamp) this.samples = [];
    else if (last && frame.timestamp === last.timestamp) return;
    this.samples = this.samples.filter((sample) => frame.timestamp - sample.timestamp <= SMOOTHING_WINDOW_MS);
    this.samples.push({ kind, point: { ...point }, timestamp: frame.timestamp, sessionId: frame.sessionId, epoch: frame.epoch });
  }

  /**
   * Median of the recent frames of the same kind, only when most of them agree.
   * While the aim is still moving, or after too few frames, the current frame
   * is returned unchanged, so a different kind of surface is never blended in.
   */
  private smoothed(kind: SampleKind, frame: AimFrame, current: Point3, heightOnly: boolean): { point: Point3; frames: number } {
    const unchanged = { point: current, frames: 1 };
    const recent = this.samples.filter((sample) => sample.kind === kind
      && sample.sessionId === frame.sessionId && sample.epoch === frame.epoch
      && frame.timestamp >= sample.timestamp && frame.timestamp - sample.timestamp <= SMOOTHING_WINDOW_MS);
    if (recent.length < SMOOTHING_MIN_SAMPLES) return unchanged;
    const y = median(recent.map((sample) => sample.point.y));
    const centre = heightOnly ? { x: current.x, y, z: current.z } : {
      x: median(recent.map((sample) => sample.point.x)), y, z: median(recent.map((sample) => sample.point.z)),
    };
    const agreeing = recent.filter((sample) => (heightOnly ? Math.abs(sample.point.y - y)
      : Math.hypot(sample.point.x - centre.x, sample.point.y - y, sample.point.z - centre.z)) <= SMOOTHING_AGREEMENT_METERS).length;
    if (agreeing < SMOOTHING_MIN_SAMPLES || agreeing / recent.length < SMOOTHING_MIN_AGREEMENT || !finitePoint(centre)) return unchanged;
    return { point: centre, frames: agreeing };
  }

  private topCandidate(frame: AimFrame, remember: boolean): BaseTopPreview {
    const base = this.state.base;
    const normal = this.planeNormal;
    if (!base || !normal) return { ok: false, reason: 'base-required' };
    let top: Point3;
    let source: BaseTopResult['source'];
    if (frame.hit) {
      // A closer observed surface must never be replaced by a farther virtual
      // target merely because its height is inconvenient or too low.
      top = { ...frame.hit.position };
      source = 'webxr-plane-hit';
    } else {
      const dot = normal.x * frame.direction.x + normal.z * frame.direction.z;
      if (Math.abs(dot) < MIN_RAY_PLANE_DOT) return { ok: false, reason: 'parallel-ray' };
      const numerator = normal.x * (base.position.x - frame.origin.x) + normal.z * (base.position.z - frame.origin.z);
      const distance = numerator / dot;
      if (!Number.isFinite(distance)) return { ok: false, reason: 'invalid-intersection' };
      if (distance <= 0) return { ok: false, reason: 'behind-camera' };
      if (distance > MAX_INTERSECTION_DISTANCE_METERS) return { ok: false, reason: 'intersection-too-far' };
      top = {
        x: frame.origin.x + distance * frame.direction.x,
        y: frame.origin.y + distance * frame.direction.y,
        z: frame.origin.z + distance * frame.direction.z,
      };
      source = 'virtual-vertical-plane';
    }
    if (!finitePoint(top)) return { ok: false, reason: 'invalid-intersection' };
    if (top.y - base.position.y <= MIN_HEIGHT_METERS) return { ok: false, reason: 'top-not-above-base' };
    let smoothedFrames = 1;
    if (remember) {
      this.record(source, top, frame);
      // Only height is smoothed: wall and ceiling hits near the corner differ sideways.
      const steady = this.smoothed(source, frame, top, true);
      if (steady.point.y - base.position.y > MIN_HEIGHT_METERS) { top = steady.point; smoothedFrames = steady.frames; }
    }
    try {
      return { ok: true, result: {
        ...calculateVerticalHeight(base.position, top), source, accuracy: 'unverified', smoothedFrames,
        base: cloneHit(base), top, timestamp: frame.timestamp, sessionId: frame.sessionId, epoch: frame.epoch,
      } };
    } catch {
      return { ok: false, reason: 'invalid-intersection' };
    }
  }
}
