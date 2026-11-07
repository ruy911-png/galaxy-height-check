/** Viewer-space rays for the two visible guides, derived from the real XR camera. */
type RayPoint = Required<DOMPointInit>;
export interface AutoRay { origin: RayPoint; direction: RayPoint }
export interface AutoRayPlan { floor: AutoRay; ceiling: AutoRay; key: string }

const EPSILON = 1e-12;
// A 0.1 mm origin difference / roughly 0.006 degree direction difference is below
// practical hit-test precision. Compare to the existing plan, never a moving average.
const CONFIG_TOLERANCE = 1e-4;

function readMatrix(input: ArrayLike<number> | undefined): number[] | null {
  if (!input || input.length !== 16) return null;
  const matrix = Array.from(input);
  return matrix.every(Number.isFinite) ? matrix : null;
}

/** XR pose matrices are rigid, column-major transforms, not projection matrices. */
function isRigid(matrix: number[]): boolean {
  if ([3, 7, 11].some(i => Math.abs(matrix[i]) > 1e-5) || Math.abs(matrix[15] - 1) > 1e-5) return false;
  const dot = (a: number, b: number) => matrix[a] * matrix[b] + matrix[a + 1] * matrix[b + 1] + matrix[a + 2] * matrix[b + 2];
  if ([0, 4, 8].some(i => Math.abs(dot(i, i) - 1) > 1e-3)) return false;
  if (Math.abs(dot(0, 4)) > 1e-3 || Math.abs(dot(0, 8)) > 1e-3 || Math.abs(dot(4, 8)) > 1e-3) return false;
  const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[9] * matrix[6])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[9] * matrix[2])
    + matrix[8] * (matrix[1] * matrix[6] - matrix[5] * matrix[2]);
  return determinant > 0;
}

/** Full inverse also supports asymmetric or skewed WebXR perspective matrices. */
function inverse(matrix: number[]): number[] | null {
  const rows = Array.from({ length: 4 }, (_, row) => [
    ...Array.from({ length: 4 }, (_, column) => matrix[column * 4 + row]),
    ...Array.from({ length: 4 }, (_, column) => Number(row === column)),
  ]);
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < EPSILON) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let i = 0; i < 8; i++) rows[column][i] /= divisor;
    for (let row = 0; row < 4; row++) {
      if (row === column) continue;
      const multiplier = rows[row][column];
      for (let i = 0; i < 8; i++) rows[row][i] -= multiplier * rows[column][i];
    }
  }
  const result = Array.from({ length: 16 }, (_, i) => rows[i % 4][4 + Math.floor(i / 4)]);
  return result.every(Number.isFinite) ? result : null;
}

function multiply(left: number[], right: number[]): number[] {
  return Array.from({ length: 16 }, (_, i) => {
    const row = i % 4, column = Math.floor(i / 4);
    let value = 0;
    for (let k = 0; k < 4; k++) value += left[k * 4 + row] * right[column * 4 + k];
    return value;
  });
}

function transform(matrix: number[], x: number, y: number, z: number, w: number): RayPoint {
  return {
    x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w,
    y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w,
    z: matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] * w,
    w: matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w,
  };
}

function ray(inverseProjection: number[], eyeToViewer: number[], ndcY: number): AutoRay | null {
  const near = transform(inverseProjection, 0, ndcY, -1, 1);
  if (!Object.values(near).every(Number.isFinite) || Math.abs(near.w) < EPSILON) return null;
  const eyeDirection = { x: near.x / near.w, y: near.y / near.w, z: near.z / near.w };
  if (eyeDirection.z >= -EPSILON) return null;
  const origin = transform(eyeToViewer, 0, 0, 0, 1);
  const direction = transform(eyeToViewer, eyeDirection.x, eyeDirection.y, eyeDirection.z, 0);
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Object.values(origin).every(Number.isFinite) || !Number.isFinite(length) || length < EPSILON) return null;
  return {
    origin: { x: origin.x, y: origin.y, z: origin.z, w: 1 },
    direction: { x: direction.x / length, y: direction.y / length, z: direction.z / length, w: 0 },
  };
}

/**
 * Guides are (50%, 20%) and (50%, 80%) of a single XR view: NDC y = ±0.6.
 * offsetRay is expressed in the viewer reference space. XRView and viewer poses
 * can differ, so transform the eye ray through inverse(viewerPose) * viewPose.
 * Ordinary world motion must not change this source configuration.
 */
function createRayContext(pose: XRViewerPose): { inverseProjection: number[]; eyeToViewer: number[] } | null {
  if (!pose || pose.emulatedPosition || pose.views?.length !== 1) return null;
  const view = pose.views[0];
  const projection = readMatrix(view?.projectionMatrix);
  const viewer = readMatrix(pose.transform?.matrix);
  const eye = readMatrix(view?.transform?.matrix);
  if (!projection || !viewer || !eye || !isRigid(viewer) || !isRigid(eye)) return null;
  // A perspective XR camera has a zero bottom-right entry and looks along -Z.
  if ([3, 7, 15].some(i => Math.abs(projection[i]) > 1e-8) || projection[11] >= -EPSILON) return null;
  const inverseProjection = inverse(projection);
  const inverseViewer = inverse(viewer);
  if (!inverseProjection || !inverseViewer) return null;
  const eyeToViewer = multiply(inverseViewer, eye);
  return { inverseProjection, eyeToViewer };
}

/** The same real view transform, aimed at the visible screen center. */
export function createCenterRayPlan(pose: XRViewerPose): AutoRay | null {
  const context = createRayContext(pose);
  return context ? ray(context.inverseProjection, context.eyeToViewer, 0) : null;
}

export function createAutoRayPlan(pose: XRViewerPose): AutoRayPlan | null {
  const context = createRayContext(pose);
  if (!context) return null;
  const { inverseProjection, eyeToViewer } = context;
  const floor = ray(inverseProjection, eyeToViewer, -.6);
  const ceiling = ray(inverseProjection, eyeToViewer, .6);
  if (!floor || !ceiling) return null;
  const key = [floor, ceiling].flatMap(item => [item.origin.x, item.origin.y, item.origin.z,
    item.direction.x, item.direction.y, item.direction.z]).map(value => Math.round(value * 1e5)).join(',');
  return { floor, ceiling, key };
}

/** Tolerant comparison avoids repeatedly cancelling pending sources on float jitter. */
export function autoRayPlansMatch(left: AutoRayPlan, right: AutoRayPlan): boolean {
  return (['floor', 'ceiling'] as const).every(side => (['origin', 'direction'] as const).every(kind => {
    const a = left[side][kind], b = right[side][kind];
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= CONFIG_TOLERANCE;
  }));
}

/** A viewer-relative source only needs replacement when its actual ray changes. */
export function autoRaysMatch(left: AutoRay, right: AutoRay): boolean {
  return (['origin', 'direction'] as const).every(kind => {
    const a = left[kind], b = right[kind];
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= CONFIG_TOLERANCE;
  });
}
