import { describe, expect, it } from 'vitest';
import { autoRayPlansMatch, createAutoRayPlan } from '../src/autoRay';

// Synthetic projection/pose geometry only; this does not verify phone hit tests.
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const projection = (scale = 2) => [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, -1.002, -1, 0, 0, -.2002, 0];
function translate(x: number, y: number, z: number) {
  const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m;
}
function multiply(a: number[], b: number[]) {
  return Array.from({ length: 16 }, (_, i) => {
    const row = i % 4, column = Math.floor(i / 4);
    return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[column * 4 + k], 0);
  });
}
function makePose({ p = projection(), viewer = identity(), eye = viewer, emulated = false, count = 1 }: {
  p?: number[]; viewer?: number[]; eye?: number[]; emulated?: boolean; count?: number;
} = {}) {
  const view = { eye: 'none', projectionMatrix: new Float32Array(p), transform: { matrix: new Float32Array(eye) } };
  return { emulatedPosition: emulated, transform: { matrix: new Float32Array(viewer) }, views: Array.from({ length: count }, () => view) } as unknown as XRViewerPose;
}
function unit(x: number, y: number, z: number) { const d = Math.hypot(x, y, z); return { x: x / d, y: y / d, z: z / d }; }
function expectVector(actual: DOMPointInit, expected: { x: number; y: number; z: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 6); expect(actual.y).toBeCloseTo(expected.y, 6); expect(actual.z).toBeCloseTo(expected.z, 6);
}

describe('automatic upper/lower viewer-space hit rays', () => {
  it('derives upper/lower guide rays from the actual perspective, not a guessed FOV', () => {
    const plan = createAutoRayPlan(makePose())!;
    expectVector(plan.ceiling.direction, unit(0, .3, -1));
    expectVector(plan.floor.direction, unit(0, -.3, -1));
    expectVector(plan.floor.origin, { x: 0, y: 0, z: 0 });
    expect(plan.floor.direction.w).toBe(0); expect(plan.floor.origin.w).toBe(1);
    const narrower = createAutoRayPlan(makePose({ p: projection(3) }))!;
    expectVector(narrower.ceiling.direction, unit(0, .2, -1));
    expect(autoRayPlansMatch(plan, narrower)).toBe(false);
  });
  it('handles an asymmetric, skewed projection using its full inverse', () => {
    const p = projection(); p[4] = .25; p[8] = .2; p[9] = -.1;
    const plan = createAutoRayPlan(makePose({ p }))!;
    const y = (.6 - .1) / 2;
    expectVector(plan.ceiling.direction, unit((.2 - .25 * y) / 2, y, -1));
    expectVector(plan.floor.direction, unit((.2 - .25 * -.35) / 2, -.35, -1));
  });
  it('uses the eye origin relative to the viewer, not its world position', () => {
    const viewer = translate(5, 1.6, -4);
    const eye = multiply(viewer, translate(.03, -.01, .02));
    const plan = createAutoRayPlan(makePose({ viewer, eye }))!;
    expectVector(plan.floor.origin, { x: .03, y: -.01, z: .02 });
    expectVector(plan.ceiling.direction, unit(0, .3, -1));
  });
  it('rotates eye directions into viewer space without translating directions', () => {
    // Eye turns 90 degrees left relative to the viewer: eye -Z becomes viewer -X.
    const eye = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, .02, 0, 0, 1];
    const plan = createAutoRayPlan(makePose({ eye }))!;
    expectVector(plan.ceiling.direction, unit(-1, .3, 0));
    expectVector(plan.floor.origin, { x: .02, y: 0, z: 0 });
  });
  it('does not recreate sources when the whole camera translates or rotates', () => {
    const first = createAutoRayPlan(makePose())!;
    const moved = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 3, 1.6, -2, 1];
    const second = createAutoRayPlan(makePose({ viewer: moved }))!;
    expect(autoRayPlansMatch(first, second)).toBe(true);
    expect(second.key).toBe(first.key);
  });
  it('compares against the existing plan with a tolerance, including across rounding boundaries', () => {
    const first = createAutoRayPlan(makePose({ p: projection(2.000049) }))!;
    const jitter = createAutoRayPlan(makePose({ p: projection(2.000051) }))!;
    expect(autoRayPlansMatch(first, jitter)).toBe(true);
    const movedEye = createAutoRayPlan(makePose({ eye: translate(.001, 0, 0) }))!;
    expect(autoRayPlansMatch(first, movedEye)).toBe(false);
  });
  it.each([
    { name: 'zoom in', fx: 3.6, fy: 4, offsetX: 0, offsetY: 0 },
    { name: 'zoom out', fx: 1.2, fy: 1.5, offsetX: 0, offsetY: 0 },
    { name: 'asymmetric camera crop', fx: 3, fy: 3.5, offsetX: .15, offsetY: -.08 },
  ])('recognizes $name from camera projection and still hits both guide positions', ({ fx, fy, offsetX, offsetY }) => {
    // Camera zoom must be reflected by XRView.projectionMatrix. CSS enlargement
    // cannot provide this geometry and is not treated as optical camera zoom.
    const initial = createAutoRayPlan(makePose())!;
    const p = projection(); p[0] = fx; p[5] = fy; p[8] = offsetX; p[9] = offsetY;
    const zoomed = createAutoRayPlan(makePose({ p }))!;
    expect(autoRayPlansMatch(initial, zoomed)).toBe(false);
    for (const [side, expectedY] of [['floor', -.6], ['ceiling', .6]] as const) {
      const { x, y, z } = zoomed[side].direction;
      const clipX = p[0] * x + p[4] * y + p[8] * z;
      const clipY = p[1] * x + p[5] * y + p[9] * z;
      const clipW = p[3] * x + p[7] * y + p[11] * z;
      expect(clipX / clipW).toBeCloseTo(0, 6);
      expect(clipY / clipW).toBeCloseTo(expectedY, 6);
    }
  });
  it('keeps geometrically identical center rays if only horizontal FOV changes', () => {
    const initial = createAutoRayPlan(makePose())!;
    const p = projection(); p[0] = 4;
    const changed = createAutoRayPlan(makePose({ p }))!;
    expect(autoRayPlansMatch(initial, changed)).toBe(true);
  });
  it.each([0, 2])('rejects %s camera views instead of assuming a mono camera', count => {
    expect(createAutoRayPlan(makePose({ count }))).toBeNull();
  });
  it('rejects an emulated viewer position', () => {
    expect(createAutoRayPlan(makePose({ emulated: true }))).toBeNull();
  });
  it.each(['zero', 'nan', 'infinity', 'singular', 'orthographic'])('rejects an invalid %s projection', invalid => {
    const p = invalid === 'zero' ? Array(16).fill(0) : invalid === 'orthographic' ? identity() : projection();
    if (invalid === 'nan') p[0] = NaN;
    if (invalid === 'infinity') p[5] = Infinity;
    if (invalid === 'singular') p[0] = 0;
    expect(createAutoRayPlan(makePose({ p }))).toBeNull();
  });
  it.each(['viewer', 'eye'] as const)('rejects nonfinite or singular %s pose matrices', side => {
    const invalid = identity(); invalid[12] = NaN;
    expect(createAutoRayPlan(makePose({ [side]: invalid }))).toBeNull();
    expect(createAutoRayPlan(makePose({ [side]: Array(16).fill(0) }))).toBeNull();
  });
  it('rejects malformed pose data without throwing', () => {
    expect(createAutoRayPlan({ views: [{}] } as unknown as XRViewerPose)).toBeNull();
  });
});
